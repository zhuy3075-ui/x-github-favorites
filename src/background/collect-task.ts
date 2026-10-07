import type { Job, RepoResult, Field } from '../domain/types.ts';
import { CollectorError, messageOf } from '../domain/types.ts';
import { observations, receipts, sourceBlock, appendSource } from '../domain/source-record.ts';
import { repositoryFromUrl } from '../domain/repository-url.ts';
import { resolveLink } from '../network/short-links.ts';
import { digest } from '../domain/snapshot.ts';
import { FeishuClient } from '../destinations/feishu/client.ts';
import type { FeishuRecord } from '../destinations/feishu/client.ts';
import { fieldBindings, plain, linkValue, newFields } from '../destinations/feishu/fields.ts';
type Dependencies = {client:FeishuClient;persist:(j:Job)=>Promise<void>;stillCurrent:()=>Promise<boolean>;
  resolve?:(l:Job['snapshot']['entry']['links'][number])=>Promise<string|null>;changed?:()=>void;
  enrich?:(job:Job,persist:()=>Promise<void>)=>Promise<void>};
export async function runCollection(job:Job,deps:Dependencies):Promise<void>{
  const started=Date.now(),before=job.activityMs;
  const persist=async()=>{job.updatedAt=new Date().toISOString();job.activityMs=before+Date.now()-started;await deps.persist(job);deps.changed?.();};
  const stage=async(status:Job['status'])=>{job.status=status;await persist();};
  const current=async()=>{if(!await deps.stillCurrent())throw new CollectorError('CONFIG_CHANGED','设置已变更，旧任务已暂停。');};
  let bindings:Record<string,Field>;
  try{
    await current();
    if(!job.resolved){
      await stage('extracting');if(!job.intent)await deps.enrich?.(job,persist);
      await current();const resolved=new Map<string,string>(),visited=new Set<string>();
      for(const layer of [job.snapshot.entry,job.snapshot.quoted])for(const link of layer?.links??[]){
        if(visited.has(link.href))continue;visited.add(link.href);
        if(Date.now()>=deps.client.deadline)throw new CollectorError('INTERRUPTED','链接解析超出任务预算，未执行写入。');
        const target=await (deps.resolve??(l=>resolveLink(l,fetch,deps.client.deadline-Date.now())))(link);
        if(target)resolved.set(link.href,target);
        else{job.complete=false;job.warnings.push('链接未能解析：'+link.href.slice(0,120));}
      }
      const sourceFingerprint=job.readFingerprints?.length?
        await digest([job.entryFingerprint,job.readFingerprints.at(-1)]):job.entryFingerprint;
      job.observations=await observations(job.snapshot,sourceFingerprint,resolved,job.complete);
      job.expectedKeys=job.observations.map(o=>o.repository.key).sort();
      job.resolved=true;
      if(!job.observations.length){job.error=job.warnings.length?'没有可确认的仓库，未解析候选已保留。':'本帖未找到 GitHub 仓库。';await stage('no_repository');return;}
    }
    if(job.observations.length>20)throw new CollectorError('CAPACITY_EXCEEDED','本帖仓库超过 20 个，本次未写入；完整候选已保留。');
    await stage('checking');bindings=fieldBindings(await deps.client.fields(),job.target.fieldMapping);
    let rows=await deps.client.records(); // An incomplete scan must throw before any write.
    const githubName=bindings['GitHub 链接'].field_name,sourceName=bindings['来源记录'].field_name;
    const matches=(key:string)=>rows.filter(r=>repositoryFromUrl(linkValue(r.fields[githubName])??'')?.key===key);
    const proof=(row:FeishuRecord,id:string)=>receipts(plain(row.fields[sourceName])).some(r=>r.observationId===id);
    const resultFor=(o:Job['observations'][number],outcome:RepoResult['outcome'],recordId:string|null,error:string|null):RepoResult=>
      ({repositoryKey:o.repository.key,repositoryName:o.repository.name,repositoryUrl:o.repository.url,outcome,recordId,error});
    if(job.intent){
      const o=job.observations.find(o=>o.repository.key===job.intent!.repositoryKey);
      const found=matches(job.intent.repositoryKey);
      if(o&&found.length===1&&proof(found[0],job.intent.observationId)){
        job.results=job.results.filter(r=>r.repositoryKey!==o.repository.key);
        job.results.push(resultFor(o,job.intent.operation==='create'?'created':'source_appended',found[0].record_id,null));
        job.intent=null;await persist();
      }else{
        if(o){job.results=job.results.filter(r=>r.repositoryKey!==o.repository.key);
          job.results.push(resultFor(o,'uncertain',job.intent.recordId,'上次写入仍无法确认，请查看 Favorites；本次未重复写入。'));}
        job.intent.state='uncertain';job.error='上次写入结果仍待核对，本次未重复提交。';await stage('uncertain');return;
      }
    }
    for(const o of job.observations){
      if(job.results.some(r=>r.repositoryKey===o.repository.key&&!['failed','uncertain'].includes(r.outcome)))continue;
      await current();
      job.results=job.results.filter(r=>r.repositoryKey!==o.repository.key);
      try{
        const found=matches(o.repository.key);
        if(found.length>1)throw new CollectorError('REMOTE_CONFLICT','目标表存在同仓库重复行，请整理后重试。');
        if(found.length===1&&proof(found[0],o.observationId)){job.results.push(resultFor(o,'existing',found[0].record_id,null));await persist();continue;}
        const old=found[0];
        const text=appendSource(old?plain(old.fields[sourceName]):'',sourceBlock(job,o));
        await stage('saving');
        await current();
        job.intent={repositoryKey:o.repository.key,observationId:o.observationId,operation:old?'append':'create',
          recordId:old?.record_id??null,state:'sending'};
        await persist(); // Durable intent BEFORE sending; never infer "not sent" after restart.
        await current();
        let recordId:string;
        if(old){await deps.client.append(old.record_id,sourceName,text);recordId=old.record_id;old.fields[sourceName]=text;}
        else{
          const fields=newFields(job.snapshot,o,text,bindings,!job.complete||job.warnings.length>0);
          recordId=await deps.client.create(fields);rows.push({record_id:recordId,fields});
        }
        job.results.push(resultFor(o,old?'source_appended':'created',recordId,null));job.intent=null;await persist();
      }catch(error){
        if(error instanceof CollectorError&&error.code==='CONFIG_CHANGED'){job.intent=null;throw error;}
        if(error instanceof CollectorError && error.code==='WRITE_UNCERTAIN'){
          if(job.intent)job.intent.state='uncertain';
          job.results.push(resultFor(o,'uncertain',job.intent?.recordId??null,messageOf(error)));
          await stage('uncertain');
          // A single read-only reconciliation; no second write even when no row is found.
          try{
            rows=await deps.client.records();const found=matches(o.repository.key);
            if(found.length===1&&proof(found[0],o.observationId)){
              const operation=job.intent?.operation;job.results=job.results.filter(r=>r.repositoryKey!==o.repository.key);
              job.results.push(resultFor(o,operation==='create'?'created':'source_appended',found[0].record_id,null));
              job.intent=null;await persist();continue;
            }
          }catch{/* Keep durable uncertain intent and provide the manual verification action. */}
          job.error='写入结果待核对，请勿重复提交。';return;
        }
        job.intent=null;job.results.push(resultFor(o,'failed',null,messageOf(error)));await persist();
      }
    }
    const failed=job.results.filter(r=>r.outcome==='failed').length;
    await stage(failed ? failed===job.observations.length?'failed':'partial' : job.complete?'success':'partial');
  }catch(error){
    job.error=messageOf(error);
    if(job.intent){job.intent.state='uncertain';await stage('uncertain');}
    else await stage(error instanceof CollectorError&&error.code==='CONFIG_CHANGED'?'paused_config_changed':'failed');
  }finally{
    await persist();
  }
}
