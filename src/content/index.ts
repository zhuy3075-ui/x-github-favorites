import { readPost, actionGroup } from '../sources/x/post-reader.ts';
import { selectors } from '../sources/x/selectors.ts';
import { fingerprint } from '../domain/snapshot.ts';
import { repositoryFromUrl, shortLink } from '../domain/repository-url.ts';
import { send } from '../messaging/client.ts';
import type { FavoriteStatus } from '../domain/types.ts';
import {installDetailReader} from '../sources/x/detail-message.ts';
const helperPage=installDetailReader();
type Summary={id:string;status:string;results:{outcome:string;error?:string|null}[];warnings:string[];error:string|null};
type State={card:Element;host:HTMLElement;button:HTMLButtonElement;label:HTMLElement;fp:string;generation:number;
  status:string;visible:boolean;jobId:string|null;lastChecked:number;requestId:string|null};
const states=new Map<Element,State>(),dirty=new Set<Element>();
let timer:ReturnType<typeof setTimeout>|null=null,checking=false;
const busy=new Set(['queued','extracting','checking','saving']);
const labels:Record<string,string>={unknown:'加入 Favorites（收藏状态待核对）',new:'加入 Favorites',saved:'已收藏',
  partial:'部分收藏，点击补存',repositories_known:'仓库已收录，点击保存本帖来源',not_configured:'先连接 Favorites',
  queued:'排队中',extracting:'正在读取正文与链接',checking:'正在查重',saving:'收藏中',success:'已加入 Favorites',
  failed:'收藏失败，点击重试',uncertain:'结果待核对，请在任务记录查看',interrupted:'任务暂停，请在任务记录查看',
  no_repository:'未找到可识别的仓库',paused_config_changed:'设置已变更，请在任务记录查看'};
function render(s:State,status:string,note?:string){
  s.status=status;s.button.setAttribute('aria-label',labels[status]??'加入 Favorites');
  s.button.title=(labels[status]??'加入 Favorites')+(note?' · '+note:'');
  s.button.textContent=['saved','success'].includes(status)?'✓':busy.has(status)?'◌':
    ['failed','partial','uncertain','interrupted','paused_config_changed'].includes(status)?'!':'＋';
  s.button.setAttribute('aria-busy',String(busy.has(status)));
  s.button.setAttribute('aria-disabled',String(busy.has(status)||['saved','success','uncertain'].includes(status)));
  s.label.textContent=busy.has(status)||['saved','success','partial','failed','uncertain'].includes(status)?
    labels[status]??'': '';
}
function attach(card:Element){
  if(states.has(card))return;
  const group=actionGroup(card);if(!group)return;
  try{readPost(card);}catch{return;}
  const host=document.createElement('span');host.setAttribute('data-xgf-host','');
  host.style.cssText='display:inline-flex;align-items:center;flex-shrink:0;margin-inline-start:4px;position:relative';
  const root=host.attachShadow({mode:'closed'}),style=document.createElement('style');
  style.textContent='button{font:600 20px system-ui;width:32px;height:32px;border:0;border-radius:50%;background:transparent;cursor:pointer;color:inherit;display:grid;place-items:center}button:hover{background:rgba(29,155,240,.13);color:#148bd0}button:focus-visible{outline:2px solid #1d9bf0;outline-offset:2px}button[aria-disabled=true]{cursor:default}.feedback{position:absolute;top:32px;right:0;font:12px/1.4 system-ui;white-space:nowrap;background:Canvas;color:CanvasText;border:1px solid GrayText;border-radius:6px;padding:3px 7px;z-index:1;pointer-events:none}.feedback:empty{display:none}';
  const button=document.createElement('button');button.type='button';
  const label=document.createElement('span');label.className='feedback';label.setAttribute('aria-live','polite');
  root.append(style,button,label);host.style.color=getComputedStyle(group).color;
  const s:State={card,host,button,label,fp:'',generation:0,status:'unknown',visible:false,jobId:null,lastChecked:0,requestId:null};
  states.set(card,s);render(s,'unknown');group.append(host);
  button.addEventListener('click',event=>{
    event.preventDefault();event.stopPropagation();
    if(!event.isTrusted)return;
    if(busy.has(s.status)||['saved','success','uncertain'].includes(s.status))return;
    void collect(s);
  });
  observer.observe(card);
}
async function collect(s:State){
  const generation=++s.generation;
  try{
    const snapshot=readPost(s.card),fp=await fingerprint(snapshot);
    if(generation!==s.generation)return;
    if(fp!==s.fp){s.fp=fp;s.requestId=null;s.jobId=null;}
    const configured=await send<{hasCredential:boolean}>('GET_PUBLIC_SETTINGS');
    if(!configured.hasCredential){render(s,'not_configured');await send('OPEN_OPTIONS');return;}
    render(s,'queued');
    s.requestId??=crypto.randomUUID();
    const job=await send<Summary>('COLLECT_POST',{snapshot,requestId:s.requestId});
    if(generation!==s.generation||!s.card.isConnected)return;
    s.jobId=job.id;renderJob(s,job);
    if(busy.has(job.status))void poll(s,job.id,generation);
  }catch(error){if(generation===s.generation){render(s,'failed',error instanceof Error?error.message:'读取失败');
    s.label.textContent=error instanceof Error?error.message:'读取失败';setTimeout(()=>{s.label.textContent='';},6000);}}
}
function renderJob(s:State,job:Summary){
  const done=job.results.filter(r=>!['failed','uncertain'].includes(r.outcome)).length;
  const failure=job.error??job.results.find(r=>r.error)?.error;
  render(s,job.status,failure??job.warnings.join('；'));
  if(job.status==='failed'&&failure)s.label.textContent=failure;
  if(job.status==='success'||job.status==='partial')s.label.textContent=
    (job.status==='success'?'已加入 Favorites':'部分完成')+' · '+done+' 个仓库';
  if(!busy.has(job.status)){
    if(!['uncertain','interrupted','paused_config_changed'].includes(job.status))s.requestId=null;
    setTimeout(()=>{if(s.jobId===job.id)s.label.textContent='';},job.status==='failed'?6000:3000);
  }
}
async function poll(s:State,id:string,generation:number){
  for(let n=0;n<60;n++){
    await new Promise(resolve=>setTimeout(resolve,2000));
    if(!s.card.isConnected||s.jobId!==id||s.generation!==generation)return;
    try{const j=await send<Summary|null>('GET_JOB_STATUS',{id});if(!j)return;renderJob(s,j);if(!busy.has(j.status))return;}
    catch{render(s,'unknown');return;}
  }render(s,'interrupted');
}
async function checkVisible(){
  timer=null;if(checking)return;checking=true;
  try{
    const batch:{s:State;fp:string;gen:number;query:{entryUrl:string;fingerprint:string;keys:string[];unresolved:boolean}}[]=[];
    for(const card of Array.from(dirty)){
      dirty.delete(card);attach(card);const s=states.get(card);
      if(!s?.visible)continue;
      try{
        const snapshot=readPost(card),fp=await fingerprint(snapshot);
        if(s.fp===fp&&Date.now()-s.lastChecked<300000)continue;
        if(fp!==s.fp){s.generation++;s.fp=fp;s.jobId=null;s.requestId=null;render(s,'unknown');}
        if(busy.has(s.status))continue;
        const links=[...snapshot.entry.links,...(snapshot.quoted?.links??[])];
        const keys=[...new Set(links.map(l=>repositoryFromUrl(l.expandedUrl??l.href)?.key).filter((k):k is string=>!!k))];
        batch.push({s,fp,gen:s.generation,query:{entryUrl:snapshot.entry.url!,fingerprint:fp,keys,
          unresolved:links.some(l=>shortLink(l.href)&&!repositoryFromUrl(l.expandedUrl??''))}});
        if(batch.length===20)break;
      }catch{render(s,'unknown','当前帖子结构无法读取');}
    }
    if(batch.length){
      const result=await send<{fingerprint:string;status:FavoriteStatus}[]>('CHECK_POST_FAVORITES',{posts:batch.map(x=>x.query)});
      for(const item of batch){
        if(item.s.fp!==item.fp||item.s.generation!==item.gen||busy.has(item.s.status))continue;
        const state=result.find(x=>x.fingerprint===item.fp)?.status??'unknown';
        item.s.lastChecked=Date.now();render(item.s,state);
        if(state==='saved')setTimeout(()=>{if(item.s.fp===item.fp)item.s.label.textContent='';},3000);
      }
    }
  }catch{/* A read-only lookup failure cannot mark a post as saved or trigger a write. */}
  finally{checking=false;if(dirty.size)schedule();}
}
function schedule(){if(timer===null)timer=setTimeout(()=>void checkVisible(),250);}
const observer=new IntersectionObserver(entries=>{
  for(const entry of entries){const s=states.get(entry.target);if(!s)continue;s.visible=entry.isIntersecting;
    if(s.visible){dirty.add(entry.target);schedule();}}
});
function markNode(node:Node){
  if(!(node instanceof Element))return;
  if(node.closest('[data-xgf-host]'))return;
  const card=node.closest(selectors.card);
  if(card){dirty.add(card);attach(card);}
  if(node.matches(selectors.card)){dirty.add(node);attach(node);}
  for(const c of node.querySelectorAll(selectors.card)){dirty.add(c);attach(c);}
}
const mutations=new MutationObserver(records=>{
  for(const record of records){
    if(record.target instanceof Element && record.target.closest('[data-xgf-host]'))continue;
    const parent=record.target instanceof Element?record.target:record.target.parentElement;
    if(parent?.closest(selectors.card))dirty.add(parent.closest(selectors.card)!);
    for(const node of record.addedNodes)markNode(node);
  }
  for(const [card,s] of states)if(!card.isConnected){observer.unobserve(card);states.delete(card);dirty.delete(card);s.generation++;}
  if(dirty.size)schedule();
});
if(!helperPage){
for(const card of document.querySelectorAll(selectors.card))attach(card);
mutations.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,
  attributeFilter:['href','datetime','data-expanded-url']});
window.addEventListener('focus',()=>{for(const [card,s] of states)if(s.visible){s.lastChecked=0;dirty.add(card);}schedule();});
document.addEventListener('visibilitychange',()=>{if(!document.hidden){for(const [card,s]of states)if(s.visible){s.lastChecked=0;dirty.add(card);}schedule();}});
}
chrome.runtime.onMessage.addListener(message=>{
  if(message?.type!=='JOB_UPDATED')return;
  if(message.settingsChanged){for(const [card,s]of states){s.lastChecked=0;if(s.visible){dirty.add(card);}}schedule();return;}
  const job=message.job as Summary|undefined;if(!job)return;
  for(const s of states.values())if(s.jobId===job.id)renderJob(s,job);
});
