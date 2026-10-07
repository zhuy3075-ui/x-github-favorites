export async function send<T=unknown>(type:string,payload:Record<string,unknown>={}):Promise<T>{
  const reply=await chrome.runtime.sendMessage({protocolVersion:1,type,...payload});
  if(!reply?.ok)throw new Error(typeof reply?.error==='string'?reply.error:'插件没有响应，请刷新页面后重试。');
  return reply.data as T;
}
