import { send } from '../messaging/client.ts';
export { send };
export const statusText:Record<string,string>={queued:'排队中',extracting:'正在解析链接',checking:'正在查重',saving:'收藏中',
  success:'已收藏',partial:'部分完成',failed:'收藏失败',uncertain:'结果待核对',interrupted:'任务已暂停',
  paused_config_changed:'设置已变更',no_repository:'未找到可识别仓库'};
export function el<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string,className?:string):HTMLElementTagNameMap[K]{
  const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(className)e.className=className;return e;
}
export function date(value:string|null|undefined):string{
  if(!value)return '未读取';const d=new Date(value);return Number.isFinite(d.getTime())?
    d.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'未读取';
}
export function safeLink(label:string,url:string|null,allowed=['x.com','twitter.com','github.com']):HTMLElement{
  if(!url)return el('span','未读取');
  try{const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password||u.port||
    !allowed.some(host=>u.hostname===host || host==='feishu.cn'&&u.hostname.endsWith('.feishu.cn')))return el('span','地址不可用');
    const a=el('a',label);a.href=u.href;a.target='_blank';a.rel='noopener noreferrer';return a;
  }catch{return el('span','地址不可用');}
}
export function showError(node:HTMLElement,error:unknown){node.textContent=error instanceof Error?error.message:'操作未完成。';node.classList.add('error');}
