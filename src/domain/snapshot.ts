import { CollectorError } from './types.ts';
import type { PostSnapshot, RawPost, LinkEvidence } from './types.ts';
import { postUrl } from './repository-url.ts';
export async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
function stablePost(post: RawPost | null): unknown {
  if (!post) return null;
  return { url: post.url, body: post.body, authorName: post.authorName, authorHandle: post.authorHandle,
    articlePreview: post.articlePreview, links: post.links.map(l => [l.href,l.expandedUrl,l.candidate]).sort((a,b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b))) };
}
export function fingerprint(snapshot: PostSnapshot): Promise<string> {
  return digest([snapshot.entry.url, stablePost(snapshot.entry), stablePost(snapshot.quoted), snapshot.relation]);
}
function rawPost(input: unknown, entry: boolean): RawPost {
  if (!input || typeof input !== 'object') throw new CollectorError('DOM_UNSUPPORTED','帖子结构无法读取。');
  const p = input as Record<string, unknown>;
  const str = (v: unknown, max: number): string | null => {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string' || v.length > max) throw new CollectorError('CAPACITY_EXCEEDED','帖子字段超出读取范围。');
    return v;
  };
  const url = str(p.url, 2048);
  if (entry && !url) throw new CollectorError('DOM_UNSUPPORTED','无法确定入口帖子身份。');
  if (url && postUrl(url) !== url) throw new CollectorError('DOM_UNSUPPORTED','帖子地址不符合要求。');
  const body = p.body as Record<string, unknown> | undefined;
  if (!body || !['displayed','truncated','unavailable'].includes(String(body.completeness))) throw new CollectorError('DOM_UNSUPPORTED','正文状态无效。');
  if (!Array.isArray(p.links) || p.links.length > 100) throw new CollectorError('CAPACITY_EXCEEDED','帖子链接过多。');
  const links: LinkEvidence[] = p.links.map(v => {
    if (!v || typeof v !== 'object') throw new CollectorError('DOM_UNSUPPORTED','链接结构无效。');
    const l = v as Record<string, unknown>;
    const href = str(l.href,4096);
    if (!href) throw new CollectorError('DOM_UNSUPPORTED','链接地址缺失。');
    return { href, expandedUrl: str(l.expandedUrl,4096), candidate: str(l.candidate,4096) };
  });
  const time = str(p.publishedAt,80);
  if (time && (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(time) || !Number.isFinite(Date.parse(time))))
    throw new CollectorError('DOM_UNSUPPORTED','帖子时间格式无效。');
  const id = url?.match(/\/status\/(\d+)$/)?.[1] ?? null;
  return {url,postId:id,body:{text:str(body.text,200000),completeness:body.completeness as RawPost['body']['completeness']},
    authorName:str(p.authorName,500),authorHandle:str(p.authorHandle,100),publishedAt:time,
    publishedDisplay:str(p.publishedDisplay,100),links,articlePreview:str(p.articlePreview,20000)};
}
export function validateSnapshot(input: unknown): PostSnapshot {
  if (!input || typeof input !== 'object' || new TextEncoder().encode(JSON.stringify(input)).length > 256*1024)
    throw new CollectorError('CAPACITY_EXCEEDED','帖子快照超出大小限制。');
  const s = input as Record<string, unknown>;
  if (s.schemaVersion !== 1 || s.source !== 'x' || !['none','quote','repost','unknown'].includes(String(s.relation)))
    throw new CollectorError('DOM_UNSUPPORTED','帖子数据版本不支持。');
  return { schemaVersion:1,source:'x',entry:rawPost(s.entry,true),
    quoted:s.quoted ? rawPost(s.quoted,false) : null,relation:s.relation as PostSnapshot['relation'],
    collectedAt:new Date().toISOString(),warnings:Array.isArray(s.warnings) ? s.warnings.filter((x): x is string =>
      typeof x === 'string' && x.length <= 200).slice(0,20) : [] };
}
