import { send,el,statusText,date,safeLink,showError } from './shared.ts';
import type { Settings } from '../domain/types.ts';
const list=document.querySelector<HTMLElement>('#jobs')!,connection=document.querySelector<HTMLElement>('#connection-state')!;
type Summary={id:string;status:string;author:string|null;createdAt:string;results:{repositoryName:string}[];error:string|null};
document.querySelector('#settings')!.addEventListener('click',()=>void chrome.runtime.openOptionsPage());
async function load(){
  const current=await send<{settings:Settings|null}>('GET_PUBLIC_SETTINGS');
  connection.textContent=current.settings?'已配置 · 最近读取检查 '+date(current.settings.connectedAt):'尚未连接 Favorites';
  const target=document.querySelector('#target')!;target.replaceChildren(current.settings?
    safeLink('打开 Favorites',current.settings.url,['feishu.cn']):el('span','请先完成首次配置'));
  const jobs=await send<Summary[]>('GET_RECENT_JOBS');list.replaceChildren();
  if(!jobs.length){list.append(el('p','还没有收藏记录。在 X 帖子旁点击 ＋ 即可。','muted'));return;}
  for(const job of jobs.slice(0,10)){
    const item=el('article',undefined,'job');const headline=el('div',undefined,'between');
    headline.append(el('strong',job.results[0]?.repositoryName??'帖子收藏'),el('span',statusText[job.status]??job.status,'status'));
    const detail=el('a','查看详情');detail.href=chrome.runtime.getURL('detail.html')+'?id='+encodeURIComponent(job.id);detail.target='_blank';
    item.append(headline,el('p',(job.author??'作者未读取')+' · '+date(job.createdAt),'muted'),detail);
    if(job.error)item.append(el('p',job.error,'error'));list.append(item);
  }
}
chrome.runtime.onMessage.addListener(m=>{if(m?.type==='JOB_UPDATED')void load().catch(e=>showError(connection,e));});
void load().catch(e=>showError(connection,e));
