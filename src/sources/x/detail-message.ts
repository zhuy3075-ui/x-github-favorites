import {readPost} from './post-reader.ts';
import {selectors} from './selectors.ts';
import {samePost} from '../../domain/detail-snapshot.ts';
import {postUrl} from '../../domain/repository-url.ts';

export const detailHashPrefix='#favorites-detail=';
export function isDetailReaderPage():boolean{return /^#favorites-detail=[a-f0-9-]{36}$/.test(location.hash);}
export function installDetailReader():boolean{
  const helper=isDetailReaderPage();let expanded=false;
  chrome.runtime.onMessage.addListener((m,sender,reply)=>{
    if(m?.type!=='READ_POST_DETAIL')return false;
    if(!helper||m.protocolVersion!==1||sender.id!==chrome.runtime.id||sender.tab||
      typeof m.nonce!=='string'||location.hash!==detailHashPrefix+m.nonce||
      typeof m.targetUrl!=='string'||!postUrl(m.targetUrl)||!samePost(location.href,m.targetUrl)){
      reply({ok:false,status:'rejected'});return false;
    }
    for(const card of document.querySelectorAll(selectors.card)){
      try{
        const snapshot=readPost(card);
        if(!samePost(snapshot.entry.url,m.targetUrl))continue;
        if(snapshot.entry.body.completeness==='unavailable'){reply({ok:false,status:'pending'});return false;}
        const more=Array.from(card.querySelectorAll<HTMLElement>(selectors.more)).find(e=>e.closest(selectors.card)===card&&!e.closest(selectors.quote));
        if(snapshot.entry.body.completeness==='truncated'&&more&&!expanded){expanded=true;more.click();reply({ok:false,status:'pending'});return false;}
        reply({ok:true,snapshot});return false;
      }catch{/* DOM may still be rendering. The worker polls within its bounded budget. */}
    }
    reply({ok:false,status:'pending'});return false;
  });return helper;
}
