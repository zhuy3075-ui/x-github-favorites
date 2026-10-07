import {CollectorError} from '../domain/types.ts';

// Read-only checks: no credential, request headers, token storage or permission grant.
export async function diagnoseFeishuReadFailure(error:unknown):Promise<CollectorError>{
  if(typeof navigator!=='undefined'&&navigator.onLine===false)
    return new CollectorError('NET_OFFLINE','[NET_OFFLINE] 浏览器处于离线状态，请恢复网络后检查连接。');
  if(error instanceof Error&&['TimeoutError','AbortError'].includes(error.name))
    return new CollectorError('NET_TIMEOUT','[NET_TIMEOUT] 飞书读取超时，请检查网络或代理后重试。');
  let host='主机权限未能确认',rule='本插件规则未能确认';
  if(typeof chrome!=='undefined'){
    if(typeof chrome.permissions?.contains==='function'){
      try{
        if(!await chrome.permissions.contains({origins:['https://base-api.feishu.cn/*']}))
          return new CollectorError('NET_HOST_PERMISSION','[NET_HOST_PERMISSION] 插件没有飞书主机访问权限。请在扩展详情的“网站访问权限”中允许 base-api.feishu.cn，再检查连接。');
        host='主机权限已具备';
      }catch{/* Unsupported diagnostics must not become a false permission denial. */}
    }
    if(typeof chrome.declarativeNetRequest?.testMatchOutcome==='function'){
      try{
        const result=await chrome.declarativeNetRequest.testMatchOutcome({url:'https://base-api.feishu.cn/',
          initiator:chrome.runtime.getURL(''),type:'xmlhttprequest',method:'get'});
        const ids=result.matchedRules.map(r=>r.ruleId);
        if(ids.includes(9001)&&!ids.includes(9002))
          return new CollectorError('NET_PLUGIN_BLOCKED','[NET_PLUGIN_BLOCKED] 本插件的规则测试将拦截飞书读取请求，请反馈此错误码。');
        if(ids.includes(9002))rule='本插件规则测试放行';
      }catch{/* testMatchOutcome is only available to unpacked development extensions. */}
    }
  }
  return new CollectorError('NET_FETCH_FAILED','[NET_FETCH_FAILED] 浏览器未能读取飞书响应（'+host+'；'+rule+'）。请查看后台开发者工具“网络”标签中红色请求的错误码；可能涉及代理、证书、其他扩展拦截或响应重定向。');
}
