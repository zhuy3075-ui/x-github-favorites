import type {Job,PostSnapshot,RawPost} from './types.ts';
import {CollectorError} from './types.ts';
import {fingerprint,validateSnapshot} from './snapshot.ts';
import {postUrl} from './repository-url.ts';

export function samePost(a:string|null,b:string|null):boolean{
  const left=a&&postUrl(a),right=b&&postUrl(b);
  return !!left&&!!right&&left.split('/').at(-1)===right.split('/').at(-1);
}
export function needsDetail(post:RawPost|null):boolean{
  return !!post&&(post.body.completeness!=='displayed'||(!post.links.length&&!!post.articlePreview));
}
export function needsPostDetail(snapshot:PostSnapshot):boolean{
  return needsDetail(snapshot.entry)||needsDetail(snapshot.quoted)||
    (!snapshot.entry.links.length&&!snapshot.quoted?.links.length);
}
export function refreshReadWarnings(job:Job):void{
  const generated=new Set(['入口正文未完整读取','引用帖链接未读取','引用正文未完整读取','部分发布时间未读取']);
  const warnings=job.warnings.filter(w=>!generated.has(w));
  const s=job.snapshot;
  if(s.entry.body.completeness!=='displayed')warnings.push('入口正文未完整读取');
  if(s.quoted&&!s.quoted.url)warnings.push('引用帖链接未读取');
  if(s.quoted&&s.quoted.body.completeness!=='displayed')warnings.push('引用正文未完整读取');
  if(!s.entry.publishedAt||(s.quoted&&!s.quoted.publishedAt))warnings.push('部分发布时间未读取');
  job.warnings=[...new Set(warnings)];s.warnings=[...job.warnings];
}
export async function applyDetailSnapshot(job:Job,input:unknown,layer:'entry'|'quoted'):Promise<void>{
  const detailed=validateSnapshot(input),original=job.snapshot[layer];
  if(detailed.entry.body.completeness==='unavailable'||(!detailed.entry.body.text?.trim()&&!detailed.entry.links.length))
    throw new CollectorError('DOM_UNSUPPORTED','详情正文尚未就绪，保留点击时内容。');
  if(!original||!samePost(original.url,detailed.entry.url)||
    (original.authorHandle&&detailed.entry.authorHandle&&original.authorHandle.toLowerCase()!==detailed.entry.authorHandle.toLowerCase()))
    throw new CollectorError('DOM_UNSUPPORTED','详情与所选帖子身份不一致，未采用详情内容。');
  job.displayedSnapshot??=structuredClone(job.snapshot);
  const collectedAt=job.snapshot.collectedAt;
  if(layer==='entry'){
    const oldQuote=job.snapshot.quoted;
    if(oldQuote?.url&&detailed.quoted?.url&&!samePost(oldQuote.url,detailed.quoted.url)){
      detailed.quoted=oldQuote;job.warnings.push('[详情补读] 详情中的引用已变化，保留点击时引用');job.complete=false;
    }else if(oldQuote&&!detailed.quoted){
      detailed.quoted=oldQuote;job.warnings.push('[详情补读] 详情未显示原引用，保留点击时引用');job.complete=false;
    }
    job.snapshot=detailed;job.snapshot.collectedAt=collectedAt;
  }else job.snapshot.quoted=detailed.entry; // Do not recurse into the quoted post's own quotes.
  refreshReadWarnings(job);
  const fp=await fingerprint(job.snapshot);
  job.readFingerprints=[...new Set([...(job.readFingerprints??[]),fp])].slice(-3);
}
