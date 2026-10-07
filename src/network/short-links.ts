import { CollectorError } from '../domain/types.ts';
import { shortLink, repositoryFromUrl } from '../domain/repository-url.ts';
import type { LinkEvidence } from '../domain/types.ts';
export async function networkGuard(): Promise<void> {
  if (typeof chrome === 'undefined') return;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds:[9001,9002],
    addRules:[
      {id:9001,priority:1,action:{type:'block'},condition:{initiatorDomains:[chrome.runtime.id],resourceTypes:['xmlhttprequest']}},
      {id:9002,priority:2,action:{type:'allow'},condition:{initiatorDomains:[chrome.runtime.id],
        regexFilter:'^https://(t\\.co|github\\.com|base-api\\.feishu\\.cn)/',resourceTypes:['xmlhttprequest']}},
    ],
  });
}
export async function resolveLink(link: LinkEvidence, fetcher: typeof fetch = fetch, budgetMs=15000): Promise<string | null> {
  if (repositoryFromUrl(link.href)) return link.href;
  if (!shortLink(link.href)) return null;
  if (link.expandedUrl && repositoryFromUrl(link.expandedUrl)) return link.expandedUrl;
  const deadline=Date.now()+Math.min(15000,Math.max(1,budgetMs));
  try {
    // DNR blocks each hop outside the three exact HTTPS hosts before the browser sends it.
    const response = await fetcher(link.href,{method:'HEAD',redirect:'follow',credentials:'omit',
      referrerPolicy:'no-referrer',signal:AbortSignal.timeout(Math.max(1,deadline-Date.now()))});
    if (repositoryFromUrl(response.url)) return response.url;
    // Some t.co links return an HTML refresh instead of an HTTP redirect.
    if (!shortLink(response.url || link.href)) return null;
    if(Date.now()>=deadline)return null;
    const htmlResponse = await fetcher(link.href,{credentials:'omit',redirect:'follow',referrerPolicy:'no-referrer',
      signal:AbortSignal.timeout(Math.max(1,deadline-Date.now()))});
    if (repositoryFromUrl(htmlResponse.url)) { await htmlResponse.body?.cancel(); return htmlResponse.url; }
    if (!shortLink(htmlResponse.url || link.href) || !htmlResponse.ok) return null;
    const reader = htmlResponse.body?.getReader(); if (!reader) return null;
    const decoder = new TextDecoder(); let html = '';
    try { while (true) { const part = await reader.read(); if (part.done) break;
      html += decoder.decode(part.value,{stream:true}); if (html.length > 65536) return null; } }
    finally { await reader.cancel(); }
    for (const meta of html.matchAll(/<meta\b[^>]*>/gi)) {
      if (!/http-equiv\s*=\s*["']?refresh/i.test(meta[0])) continue;
      const content = meta[0].match(/content\s*=\s*["']([^"']+)["']/i)?.[1];
      const target = content?.match(/url\s*=\s*(https:\/\/[^;\s]+)/i)?.[1]?.replace(/&amp;/g,'&');
      if (target && repositoryFromUrl(target)) return target;
    }
    return null;
  } catch { return null; }
}
export function assertGuardReady(ok: boolean): void {
  if (!ok) throw new CollectorError('URL_UNRESOLVED','短链网络边界未就绪，无法继续解析。');
}
