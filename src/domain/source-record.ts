import { digest } from './snapshot.ts';
import { repositoryFromUrl } from './repository-url.ts';
import { CollectorError } from './types.ts';
import type { Job, Observation, PostSnapshot, FavoriteStatus } from './types.ts';
import type { FeishuRecord } from '../destinations/feishu/client.ts';
import { plain, linkValue } from '../destinations/feishu/fields.ts';
const start = '[FAVORITES_SOURCE_V1]';
const end = '[/FAVORITES_SOURCE_V1]';
export type Receipt = { schemaVersion:1; observationId:string; entryFingerprint:string; entryUrl:string;
  repositoryKey:string; expectedKeys:string[]; complete:boolean;readFingerprints?:string[] };
export function receipts(text:string):Receipt[] {
  const found:Receipt[]=[];const regex=/\[FAVORITES_SOURCE_V1\]\r?\n([^\r\n]+)\r?\n\[\/FAVORITES_SOURCE_V1\]/g;
  for (const m of text.matchAll(regex)) {
    try { const r=JSON.parse(m[1]) as Receipt;
      if(r.schemaVersion===1 && /^[a-f0-9]{64}$/.test(r.observationId) && /^[a-f0-9]{64}$/.test(r.entryFingerprint) &&
        Array.isArray(r.expectedKeys) && r.expectedKeys.every(k=>typeof k==='string') && typeof r.entryUrl==='string' &&
        typeof r.repositoryKey==='string' && typeof r.complete==='boolean'&&
        (r.readFingerprints===undefined||(Array.isArray(r.readFingerprints)&&r.readFingerprints.length<=3&&
          r.readFingerprints.every(fp=>typeof fp==='string'&&/^[a-f0-9]{64}$/.test(fp))))) found.push(r);
    } catch { /* Human text is never executed or normalized. */ }
  } return found;
}
export function sourceBlock(job:Job,o:Observation):string {
  const r:Receipt = {schemaVersion:1,observationId:o.observationId,entryFingerprint:job.entryFingerprint,
    entryUrl:job.snapshot.entry.url!,repositoryKey:o.repository.key,expectedKeys:job.expectedKeys,complete:job.complete,
    ...(job.readFingerprints?.length?{readFingerprints:job.readFingerprints}:{})};
  return start+'\n'+JSON.stringify({...r,collectedAt:job.snapshot.collectedAt,linkLocation:o.linkLocation,
    originalUrls:o.originalUrls,entry:job.snapshot.entry,quoted:job.snapshot.quoted,relation:job.snapshot.relation,
    warnings:job.warnings,...(job.displayedSnapshot?{displayedSnapshot:job.displayedSnapshot}:{})})+'\n'+end;
}
export function appendSource(existing:string,block:string):string {
  const result=existing ? existing+'\n\n'+block : block;
  if(result.length>48000)throw new CollectorError('CAPACITY_EXCEEDED','来源记录已超出本版容量限制，请整理后重试；原内容未覆盖。');
  if(existing.includes(start) && receipts(existing).length===0)
    throw new CollectorError('REMOTE_CONFLICT','已有来源记录格式无法安全核验，请检查表格。');
  return result;
}
export async function observations(snapshot:PostSnapshot,fp:string,resolved:Map<string,string>,complete=true):Promise<Observation[]> {
  const collected=new Map<string,{repository:NonNullable<ReturnType<typeof repositoryFromUrl>>;entry:boolean;quoted:boolean;urls:Set<string>}>();
  for(const layer of ['entry','quoted'] as const) for(const l of snapshot[layer]?.links ?? []) {
    const target=resolved.get(l.href);const repo=target ? repositoryFromUrl(target) : null;if(!repo)continue;
    const item=collected.get(repo.key) ?? {repository:repo,entry:false,quoted:false,urls:new Set<string>()};
    item[layer]=true;item.urls.add(l.href);item.urls.add(target!);collected.set(repo.key,item);
  }
  const result:Observation[]=[];
  const expectedKeys=[...collected.keys()].sort();
  for(const item of collected.values())result.push({repository:item.repository,primarySource:item.entry?'entry':'quoted',
    linkLocation:item.entry&&item.quoted?'both':item.entry?'entry':'quoted',originalUrls:[...item.urls],
    observationId:await digest([item.repository.key,fp,expectedKeys,complete])});
  return result;
}
export function favoriteStatus(rows:FeishuRecord[],query:{entryUrl:string;fingerprint:string;keys:string[];unresolved:boolean},
  githubField:string,sourceField:string):FavoriteStatus {
  const candidates=rows.flatMap(row=>receipts(plain(row.fields[sourceField])).map(r=>({row,r}))).filter(x=>
    x.r.entryUrl===query.entryUrl && (x.r.entryFingerprint===query.fingerprint||x.r.readFingerprints?.includes(query.fingerprint)) &&
    repositoryFromUrl(linkValue(x.row.fields[githubField]) ?? '')?.key===x.r.repositoryKey);
  if(candidates.length){
    const expected=new Set(candidates.flatMap(x=>x.r.expectedKeys));
    const present=new Set(candidates.map(x=>x.r.repositoryKey));
    const all=expected.size>0 && [...expected].every(k=>present.has(k));
    const completeGroups=candidates.filter(x=>x.r.complete);
    const verified=completeGroups.some(group=>group.r.expectedKeys.length>0 && group.r.expectedKeys.every(key=>
      completeGroups.some(x=>x.r.repositoryKey===key&&JSON.stringify([...x.r.expectedKeys].sort())===
        JSON.stringify([...group.r.expectedKeys].sort()))));
    return all && verified ? 'saved' : 'partial';
  }
  const known=new Set(rows.map(r=>repositoryFromUrl(linkValue(r.fields[githubField]) ?? '')?.key).filter(Boolean));
  if(query.keys.length && query.keys.every(k=>known.has(k)) && !query.unresolved)return 'repositories_known';
  return query.unresolved ? 'unknown' : 'new';
}
