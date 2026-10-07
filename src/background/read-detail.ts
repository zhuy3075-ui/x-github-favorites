import type {Job,PostSnapshot} from '../domain/types.ts';
import {CollectorError} from '../domain/types.ts';
import {needsDetail,needsPostDetail,applyDetailSnapshot,refreshReadWarnings,samePost} from '../domain/detail-snapshot.ts';
import {postUrl} from '../domain/repository-url.ts';
import {detailHashPrefix} from '../sources/x/detail-message.ts';

type Tabs=Pick<typeof chrome.tabs,'create'|'get'|'query'|'remove'|'sendMessage'|'onActivated'>;
const wait=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
async function within<T>(operation:Promise<T>,end:number):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([operation,new Promise<never>((_,reject)=>{
    timer=setTimeout(()=>reject(new CollectorError('INTERRUPTED','详情读取超时，保留原内容。')),Math.max(0,end-Date.now()));
  })]);}finally{clearTimeout(timer);}
}
function owned(tab:chrome.tabs.Tab,reader:NonNullable<Job['detailReader']>):boolean{
  if(!postUrl(reader.targetUrl)||!/^[-a-f0-9]{36}$/.test(reader.nonce))return false;
  const url=(!tab.url||tab.url==='about:blank')?tab.pendingUrl:tab.url;
  try{return !!url&&samePost(url,reader.targetUrl)&&new URL(url).hash===detailHashPrefix+reader.nonce;}catch{return false;}
}
export async function cleanDetailTab(job:Job,persist:()=>Promise<void>,tabs:Tabs=chrome.tabs):Promise<void>{
  const reader=job.detailReader;if(!reader)return;
  const end=Date.now()+2000;
  let candidates:chrome.tabs.Tab[]=[];
  if(reader.tabId!==null){try{candidates=[await within(tabs.get(reader.tabId),end)];}catch(e){
    if(!(e instanceof Error)||!/(No tab with id|closed)/i.test(e.message))throw e;
  }}
  else candidates=(await within(tabs.query({}),end)).filter(t=>owned(t,reader));
  // An unresolved create may still return: retain its durable ownership intent.
  if(reader.tabId===null&&candidates.length===0)return;
  if(candidates.length>1)throw new CollectorError('INTERRUPTED','临时详情页归属不唯一，保留清理记录。');
  if(candidates.length===1){
    const tab=candidates[0];
    if(tab.id!==undefined&&owned(tab,reader)&&!tab.active&&!reader.keepOpen)await within(tabs.remove(tab.id),end);
  }
  job.detailReader=null;await within(persist(),end);
}
export async function readPostDetail(job:Job,targetUrl:string,persist:()=>Promise<void>,deadline:number,
  tabs:Tabs=chrome.tabs,pause:typeof wait=wait,lateSettled?:(nonce:string)=>Promise<void>):Promise<PostSnapshot>{
  const canonical=postUrl(targetUrl);
  if(!canonical||canonical!==targetUrl)throw new CollectorError('DOM_UNSUPPORTED','详情地址不符合要求。');
  const end=Math.min(deadline,Date.now()+15000);
  if(Date.now()>=end)throw new CollectorError('INTERRUPTED','详情读取超出任务预算。');
  if(job.detailReader){await cleanDetailTab(job,persist,tabs);
    if(job.detailReader)throw new CollectorError('INTERRUPTED','上次详情页创建尚待核对，请稍后重试。');}
  const reader={nonce:crypto.randomUUID(),targetUrl:canonical,tabId:null as number|null,keepOpen:false};
  job.detailReader=reader;
  try{await within(persist(),end);}catch(e){
    // No create was sent: this failure must not leave an unresolved-create lock.
    job.detailReader=null;await within(persist(),Date.now()+2000).catch(()=>{});throw e;
  } // Ownership intent precedes tab creation.
  const activatedIds=new Set<number>();
  let creating=false,abandoned=false;
  const activated=(info:{tabId:number})=>{activatedIds.add(info.tabId);if(info.tabId===reader.tabId){
    reader.keepOpen=true;if(!abandoned)void persist().catch(()=>{});
  }};
  tabs.onActivated.addListener(activated);
  const settleLate=async()=>{
    // Never put a captured Job after its task ended: a retry may already own a newer version.
    if(lateSettled)await within(lateSettled(reader.nonce),Date.now()+2000);
    if(job.detailReader===reader)job.detailReader=null;
  };
  try{
    creating=true;
    const creation=tabs.create({url:canonical+detailHashPrefix+reader.nonce,active:false}).then(async tab=>{
      creating=false;reader.tabId=tab.id??null;reader.keepOpen=tab.active||activatedIds.has(tab.id!);
      if(abandoned){
        try{
          const cleanupJob={...job,detailReader:reader};
          await cleanDetailTab(cleanupJob,async()=>{},tabs);
          if(!cleanupJob.detailReader)await settleLate();
        }catch{/* Durable intent remains for recovery. */}
        finally{tabs.onActivated.removeListener(activated);}
      }
      return tab;
    },async e=>{
      creating=false;tabs.onActivated.removeListener(activated);
      // A definite create rejection differs from a still-pending creation.
      if(abandoned)await settleLate().catch(()=>{});
      else if(job.detailReader===reader){job.detailReader=null;await within(persist(),Date.now()+2000).catch(()=>{});}
      throw e;
    });
    const tab=await within(creation,end);
    if(tab.id===undefined)throw new CollectorError('INTERRUPTED','详情页未能创建。');
    await within(persist(),end);
    while(Date.now()<end){
      const current=await within(tabs.get(tab.id),end);
      if(current.url&&!owned(current,reader)&&current.status==='complete'&&!current.pendingUrl)
        throw new CollectorError('DOM_UNSUPPORTED','详情页离开了所选帖子，未采用内容。');
      try{
        const result=await within(tabs.sendMessage(tab.id,{protocolVersion:1,type:'READ_POST_DETAIL',nonce:reader.nonce,targetUrl:canonical},{frameId:0}),end) as
          {ok:boolean;snapshot?:unknown;status?:string};
        if(result?.ok&&result.snapshot){
          const raw=result.snapshot as PostSnapshot;
          if(!samePost(raw.entry?.url??null,canonical))throw new CollectorError('DOM_UNSUPPORTED','详情返回了其他帖子。');
          return raw;
        }
        if(result?.status==='rejected')throw new CollectorError('DOM_UNSUPPORTED','详情消息未通过身份核验。');
      }catch(e){if(e instanceof CollectorError)throw e;/* Content script may not yet have loaded. */}
      await pause(Math.min(500,Math.max(1,end-Date.now())));
    }
    throw new CollectorError('INTERRUPTED','未能读取帖子详情，请稍后重试或进入正文后收藏。');
  }finally{
    abandoned=true;
    if(!creating)tabs.onActivated.removeListener(activated);
    try{if(!creating)await cleanDetailTab(job,persist,tabs);}catch{
      job.warnings.push('临时详情页未能关闭，请手动关闭');await persist();
    }
  }
}
export async function enrichJobFromDetails(job:Job,persist:()=>Promise<void>,deadline:number,
  read:(url:string)=>Promise<PostSnapshot>=url=>readPostDetail(job,url,persist,deadline)):Promise<void>{
  if(job.detailAttempted||job.intent||!needsPostDetail(job.snapshot))return;
  job.warnings=job.warnings.filter(w=>!w.startsWith('[详情补读]'));
  job.detailAttempted=true;await persist();
  const initial=job.snapshot;
  const entryNeeded=needsDetail(initial.entry)||(!initial.entry.links.length&&!initial.quoted?.links.length);
  if(entryNeeded){
    try{await applyDetailSnapshot(job,await read(initial.entry.url!), 'entry');}
    catch(e){job.complete=false;job.warnings.push('[详情补读] '+(e instanceof CollectorError?e.message:'入口详情未能读取'));}
    await persist();
  }
  if(needsDetail(job.snapshot.quoted)&&job.snapshot.quoted?.url){
    try{await applyDetailSnapshot(job,await read(job.snapshot.quoted.url),'quoted');}
    catch(e){job.complete=false;job.warnings.push('[详情补读] '+(e instanceof CollectorError?e.message:'引用详情未能读取'));}
    await persist();
  }
  if(needsDetail(job.snapshot.entry)||needsDetail(job.snapshot.quoted))job.complete=false;
  refreshReadWarnings(job);await persist();
}
