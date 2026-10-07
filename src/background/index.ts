import { TaskStore } from '../storage/tasks.ts';
import { protectSettings, storedSettings, saveConnection, validateCredential, credentialFor } from '../storage/settings.ts';
import { validateSnapshot, fingerprint } from '../domain/snapshot.ts';
import { CollectorError, messageOf } from '../domain/types.ts';
import type { Settings, Job, Target } from '../domain/types.ts';
import { FeishuClient } from '../destinations/feishu/client.ts';
import { fieldBindings, recommendMapping, parseTarget, fieldTypes } from '../destinations/feishu/fields.ts';
import { runCollection } from './collect-task.ts';
import { networkGuard } from '../network/short-links.ts';
import { favoriteStatus } from '../domain/source-record.ts';
import type { FeishuRecord } from '../destinations/feishu/client.ts';
import {cleanDetailTab} from './read-detail.ts';
import {needsPostDetail} from '../domain/detail-snapshot.ts';
const jobs=new TaskStore();
const ready=Promise.all([protectSettings(),networkGuard()]);
let drain:Promise<void>|null=null;
type FavoriteIndex={revision:number;at:number;rows:FeishuRecord[];github:string;source:string};
let index:FavoriteIndex|null=null;
let loadingIndex:Promise<FavoriteIndex>|null=null;
let submissions:Promise<unknown>=Promise.resolve();
let cacheEpoch=0;
function summarize(j:Job){return {id:j.id,status:j.status,createdAt:j.createdAt,updatedAt:j.updatedAt,
  entryUrl:j.snapshot.entry.url,author:j.snapshot.entry.authorHandle,results:j.results,warnings:j.warnings,error:j.error};}
function invalidate(){cacheEpoch++;index=null;}
async function publicSettings(){
  const saved=await storedSettings();
  return saved ? {settings:saved.settings,hasCredential:true} : {settings:null,hasCredential:false};
}
async function notify(j:Job){
  await chrome.runtime.sendMessage({protocolVersion:1,type:'JOB_UPDATED',job:summarize(j)}).catch(()=>{});
  const tabs=await chrome.tabs.query({url:['https://x.com/*','https://twitter.com/*']}).catch(()=>[]);
  await Promise.all(tabs.filter(t=>t.id!==undefined).map(t=>chrome.tabs.sendMessage(t.id!,
    {protocolVersion:1,type:'JOB_UPDATED',job:summarize(j)},{frameId:0}).catch(()=>{})));
  await chrome.action.setBadgeText({text:['failed','partial','uncertain','interrupted','paused_config_changed'].includes(j.status)?'!':''}).catch(()=>{});
}
async function runQueue(){
  await ready;
  if(drain)return drain;
  drain=(async()=>{
    while(true){
      const j=(await jobs.all()).filter(j=>j.status==='queued').sort((a,b)=>a.createdAt.localeCompare(b.createdAt))[0];
      if(!j)break;
      try{
        const secret=await credentialFor(j.target);
        const client=new FeishuClient(j.target,secret,fetch,Date.now()+Math.max(1,120000-j.activityMs));
        await runCollection(j,{client,persist:async(job)=>{await jobs.put(job);await notify(job);},
          // Automatic detail reads stay disabled until retry/late-create ownership passes review.
          stillCurrent:async()=>{const s=await storedSettings();return s?.settings.revision===j.target.revision;},changed:invalidate});
      }catch(e){j.status=e instanceof CollectorError&&e.code==='CONFIG_CHANGED'?'paused_config_changed':'failed';j.error=messageOf(e);await jobs.put(j);await notify(j);}
    }
    await chrome.alarms.clear('favorites-queue');
  })().finally(()=>{drain=null;void jobs.all().then(all=>{if(all.some(j=>j.status==='queued'))void runQueue();});});
  return drain;
}
async function recover(restart:boolean){
  await ready;
  for(const j of await jobs.all()){
    if(j.detailReader){
      try{await cleanDetailTab(j,()=>jobs.put(j));j.detailAttempted=false;await jobs.put(j);}
      catch{j.warnings.push('[详情补读] 中断的临时页未能清理，请手动关闭');await jobs.put(j);}
    }
    if(j.intent){j.intent.state='uncertain';j.status='uncertain';await jobs.put(j);continue;}
    if(['extracting','checking','saving','queued'].includes(j.status)){
      j.status=restart?'interrupted':'queued';await jobs.put(j);
    }
  }
  if(!restart)void runQueue();
}
let recovered:Promise<void>|null=null;
function resumeWorker(){return recovered??=recover(false);}
async function loadIndex(settings:Settings){
  if(index&&index.revision===settings.revision&&Date.now()-index.at<300000)return index;
  if(loadingIndex)return loadingIndex;
  const epoch=cacheEpoch;
  loadingIndex=(async()=>{
    const client=new FeishuClient(settings,await credentialFor(settings));
    const b=fieldBindings(await client.fields(),settings.fieldMapping);
    const rows=await client.records();
    const loaded={revision:settings.revision,at:Date.now(),rows,github:b['GitHub 链接'].field_name,source:b['来源记录'].field_name};
    if(epoch===cacheEpoch)index=loaded;
    return loaded;
  })().finally(()=>{loadingIndex=null;});
  return loadingIndex;
}
type Message={protocolVersion:number;type:string;requestId?:string;[key:string]:unknown};
function authorized(sender:chrome.runtime.MessageSender,type:string):boolean{
  if(sender.id!==chrome.runtime.id)return false;
  const extensionOrigin=chrome.runtime.getURL('');
  const internal=sender.url?.startsWith(extensionOrigin) && !sender.tab?.url?.startsWith('https://x.com');
  if(internal)return type==='SAVE_SETTINGS'||type==='CHECK_CONNECTION'
    ? sender.url?.split('?')[0]===chrome.runtime.getURL('options.html') : true;
  if(sender.frameId!==0 || !sender.tab?.url)return false;
  try{return ['x.com','twitter.com'].includes(new URL(sender.tab.url).hostname)&&
    ['COLLECT_POST','CHECK_POST_FAVORITES','GET_JOB_STATUS','GET_PUBLIC_SETTINGS','OPEN_OPTIONS'].includes(type);}catch{return false;}
}
async function handle(m:Message,sender:chrome.runtime.MessageSender):Promise<unknown>{
  if(m.protocolVersion!==1||!authorized(sender,m.type))throw new CollectorError('PERMISSION_DENIED','请求不在插件许可范围。');
  await ready;await resumeWorker();
  switch(m.type){
    case 'OPEN_OPTIONS':await chrome.runtime.openOptionsPage();return {};
    case 'GET_PUBLIC_SETTINGS':return publicSettings();
    case 'CHECK_CONNECTION':case 'SAVE_SETTINGS':{
      if(typeof m.url!=='string')throw new CollectorError('NOT_CONFIGURED','请填写表格地址。');
      const saved=await storedSettings();
      const credential=typeof m.credential==='string'&&m.credential.trim()?validateCredential(m.credential):saved?.credential;
      if(!credential)throw new CollectorError('AUTH_INVALID','请先填写本表授权码。');
      const parsed=parseTarget(m.url,typeof m.tableId==='string'?m.tableId:undefined);
      const target:Target={...parsed,fieldMapping:{}};
      const client=new FeishuClient(target,credential);
      const tables=await client.tables();
      if(!target.tableId && tables.length===1)target.tableId=tables[0].table_id;
      if(!target.tableId)return {tables,fields:[],mapping:{},target};
      if(!tables.some(t=>t.table_id===target.tableId))throw new CollectorError('NOT_CONFIGURED','未找到目标数据表。');
      const fields=await client.fields();
      const mapping=m.type==='SAVE_SETTINGS'?m.fieldMapping as Record<string,string>:recommendMapping(fields);
      if(m.type==='SAVE_SETTINGS'){
        if(!mapping||typeof mapping!=='object'||Array.isArray(mapping))throw new CollectorError('FIELD_MISMATCH','字段映射无效。');
        const clean:Record<string,string>={};for(const name of Object.keys(fieldTypes))clean[name]=typeof mapping[name]==='string'?mapping[name]:'';
        fieldBindings(fields,clean);target.fieldMapping=clean;
        const settings:Settings={...target,revision:(saved?.settings.revision??0)+1,
          credentialVersion:(saved?.settings.credentialVersion??0)+1,connectedAt:new Date().toISOString()};
        await saveConnection(settings,credential);invalidate();return {settings,hasCredential:true};
      }
      return {tables,fields,mapping,target};
    }
    case 'COLLECT_POST':{
      const saved=await storedSettings();if(!saved)throw new CollectorError('NOT_CONFIGURED','请先连接 Favorites。');
      if(typeof m.requestId!=='string'||!/^[a-z0-9-]{10,100}$/i.test(m.requestId))throw new CollectorError('DOM_UNSUPPORTED','任务标识无效。');
      const old=(await jobs.all()).find(j=>j.requestId===m.requestId);if(old)return summarize(old);
      const snapshot=validateSnapshot(m.snapshot),fp=await fingerprint(snapshot);
      const same=(await jobs.all()).find(j=>j.target.revision===saved.settings.revision&&j.entryFingerprint===fp&&
        ['queued','extracting','checking','saving','uncertain'].includes(j.status));
      if(same)return summarize(same);
      const j:Job={schemaVersion:1,id:crypto.randomUUID(),requestId:m.requestId,snapshot,target:saved.settings,
        status:'queued',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),results:[],warnings:[...snapshot.warnings],
        error:null,entryFingerprint:fp,observations:[],resolved:false,complete:true,expectedKeys:[],activityMs:0,intent:null};
      await jobs.put(j);
      await chrome.alarms.create('favorites-queue',{when:Date.now()+30000});
      void runQueue();return summarize(j);
    }
    case 'CHECK_POST_FAVORITES':{
      if(!Array.isArray(m.posts)||m.posts.length>20)throw new CollectorError('DOM_UNSUPPORTED','状态检查超出范围。');
      const posts=m.posts as {entryUrl:string;fingerprint:string;keys:string[];unresolved:boolean}[];
      for(const q of posts)if(typeof q.entryUrl!=='string'||!/^[a-f0-9]{64}$/.test(q.fingerprint)||!Array.isArray(q.keys)||
        q.keys.length>100||q.keys.some(k=>typeof k!=='string')||typeof q.unresolved!=='boolean')throw new CollectorError('DOM_UNSUPPORTED','状态检查字段无效。');
      const saved=await storedSettings();if(!saved)return posts.map(q=>({fingerprint:q.fingerprint,status:'not_configured'}));
      const epoch=cacheEpoch,loaded=await loadIndex(saved.settings);
      // Do not publish a stale read after an in-flight write/config change.
      const latest=await storedSettings();
      if(epoch!==cacheEpoch||latest?.settings.revision!==saved.settings.revision||loaded.revision!==saved.settings.revision)
        return posts.map(q=>({fingerprint:q.fingerprint,status:'unknown'}));
      return posts.map(q=>({fingerprint:q.fingerprint,status:favoriteStatus(loaded.rows,q,loaded.github,loaded.source)}));
    }
    case 'GET_JOB_STATUS':{
      const j=typeof m.id==='string'?await jobs.get(m.id):undefined;return j?summarize(j):null;
    }
    case 'GET_RECENT_JOBS':return (await jobs.all()).slice(0,100).map(summarize);
    case 'GET_JOB_DETAIL':return typeof m.id==='string'?await jobs.get(m.id)??null:null;
    case 'RETRY_JOB':{
      const j=typeof m.id==='string'?await jobs.get(m.id):undefined;
      if(!j)throw new CollectorError('INTERRUPTED','任务不存在。');
      if(!['failed','partial','uncertain','interrupted','paused_config_changed'].includes(j.status)&&
        !(j.status==='no_repository'&&(!j.complete||needsPostDetail(j.snapshot))))return summarize(j);
      const saved=await storedSettings();
      if(!saved||saved.settings.baseAppToken!==j.target.baseAppToken||saved.settings.tableId!==j.target.tableId)
        throw new CollectorError('CONFIG_CHANGED','请切回任务原来的 Favorites 表后重试。');
      j.target=saved.settings;j.status='queued';j.error=null;j.activityMs=0;
      if(!j.complete&&!j.intent){j.resolved=false;j.complete=true;j.results=[];j.warnings=[...j.snapshot.warnings];}
      if(!j.intent&&needsPostDetail(j.snapshot)){
        j.detailAttempted=false;j.resolved=false;j.complete=true;j.results=[];j.readFingerprints=[];
        j.warnings=[...(j.displayedSnapshot??j.snapshot).warnings];
      }
      await jobs.put(j);await chrome.alarms.create('favorites-queue',{when:Date.now()+30000});void runQueue();return summarize(j);
    }
    default:throw new CollectorError('PERMISSION_DENIED','不支持这个操作。');
  }
}
chrome.runtime.onMessage.addListener((m:Message,sender,reply)=>{
  if(m?.type==='JOB_UPDATED')return false;
  const operation=['COLLECT_POST','SAVE_SETTINGS','RETRY_JOB'].includes(m?.type)?
    (submissions=submissions.catch(()=>{}).then(()=>handle(m,sender))):handle(m,sender);
  operation.then(data=>reply({ok:true,data}),error=>reply({ok:false,code:error instanceof CollectorError?error.code:'INTERRUPTED',
    error:messageOf(error)}));return true;
});
chrome.runtime.onStartup.addListener(()=>{recovered=recover(true);});
chrome.runtime.onInstalled.addListener(()=>{void ready;});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='favorites-queue')void resumeWorker().then(runQueue);});
