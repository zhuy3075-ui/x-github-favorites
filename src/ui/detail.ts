import { send,el,statusText,date,safeLink,showError } from './shared.ts';
import type { Job,RawPost } from '../domain/types.ts';
import {needsPostDetail} from '../domain/detail-snapshot.ts';
const main=document.querySelector<HTMLElement>('#detail')!,notice=document.querySelector<HTMLElement>('#notice')!;
const id=new URL(location.href).searchParams.get('id');
function section(title:string,post:RawPost|null):HTMLElement{
  const part=el('section');part.append(el('h2',title));if(!post){part.append(el('p','无引用'));return part;}
  part.append(el('p',(post.authorName??'作者未读取')+' '+(post.authorHandle??'')+' · '+date(post.publishedAt)));
  part.append(safeLink('打开原帖',post.url));
  const text=el('pre',post.body.text??'正文未读取');part.append(text);
  if(post.body.completeness!=='displayed')part.append(el('p','仅保存已展示部分，完整正文未读取。','muted'));
  if(post.articlePreview){part.append(el('h3','文章卡片预览'),el('p','仅预览，正文未读取。','muted'),el('pre',post.articlePreview));}
  return part;
}
async function copy(value:string){try{await navigator.clipboard.writeText(value);notice.textContent='已复制。';}
  catch{notice.textContent='浏览器未允许复制，请手动选择文字。';}}
async function load(){
  if(!id){notice.textContent='缺少任务标识。';return;}
  const job=await send<Job|null>('GET_JOB_DETAIL',{id});
  if(!job){notice.textContent='未找到本机任务。';return;}
  main.replaceChildren(el('h1',statusText[job.status]??job.status),el('p','采集时间：'+date(job.snapshot.collectedAt),'muted'),
    safeLink('入口帖子',job.snapshot.entry.url),document.createTextNode(' · '),safeLink('打开 Favorites',job.target.url,['feishu.cn']));
  if(job.error)main.append(el('p',job.error,'error'));
  for(const warning of job.warnings)main.append(el('p',warning,'muted'));
  if(['failed','partial','uncertain','interrupted','paused_config_changed'].includes(job.status)||
    (job.status==='no_repository'&&(!job.complete||needsPostDetail(job.snapshot)))){
    const retry=el('button',job.intent?'核对结果':'重试未完成项');retry.addEventListener('click',async()=>{
      retry.disabled=true;try{await send('RETRY_JOB',{id});await load();}catch(e){showError(notice,e);}finally{retry.disabled=false;}
    });main.append(retry);
  }
  const results=el('section');results.append(el('h2','仓库结果'));
  const outcomes:Record<string,string>={created:'已新增',existing:'已有同一来源',source_appended:'已补充来源',failed:'失败',uncertain:'待核对'};
  for(const result of job.results){
    const row=el('article',undefined,'job');row.append(safeLink(result.repositoryName,result.repositoryUrl),el('span',' · '+outcomes[result.outcome]));
    if(result.error)row.append(el('p',result.error,'error'));
    const copyButton=el('button','复制仓库链接');copyButton.addEventListener('click',()=>void copy(result.repositoryUrl));row.append(copyButton);results.append(row);
  }main.append(results,section('入口帖原文',job.snapshot.entry),section('引用帖原文',job.snapshot.quoted));
  if(job.displayedSnapshot)main.append(section('点击收藏时展示的原文',job.displayedSnapshot.entry));
  const copyText=el('button','复制原文与来源');copyText.addEventListener('click',()=>void copy(
    JSON.stringify({entry:job.snapshot.entry,quoted:job.snapshot.quoted,warnings:job.warnings},null,2)));main.append(copyText);
}
chrome.runtime.onMessage.addListener(m=>{if(m?.type==='JOB_UPDATED'&&m.job?.id===id)void load().catch(e=>showError(notice,e));});
void load().catch(e=>showError(notice,e));
