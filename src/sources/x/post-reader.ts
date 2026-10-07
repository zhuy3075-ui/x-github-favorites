import { selectors } from './selectors.ts';
import { postUrl, githubCandidate } from '../../domain/repository-url.ts';
import { CollectorError } from '../../domain/types.ts';
import type { RawPost, PostSnapshot, LinkEvidence } from '../../domain/types.ts';
export function textWithEmoji(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? '';
  if (node.nodeType !== 1) return '';
  const e = node as Element;
  if(e.getAttribute('data-testid')==='tweet'||e.hasAttribute('data-xgf-host'))return '';
  if (e.tagName.toLowerCase() === 'svg') return '';
  if (e.tagName === 'BR') return '\n';
  if (e.tagName === 'IMG') return e.getAttribute('alt') ?? '';
  return Array.from(e.childNodes).map(textWithEmoji).join('');
}
export function quoteRoot(card: Element): Element | null {
  return Array.from(card.querySelectorAll(selectors.quote)).find(e => e.closest(selectors.card)===card&&
    !e.closest(selectors.article)&&e.querySelector(selectors.author) &&
    !e.parentElement?.closest(selectors.quote)) ?? null;
}
function own(root: Element, selector: string, excluded: Element | null): Element[] {
  return Array.from(root.querySelectorAll(selector)).filter(e => !excluded?.contains(e)&&
    e.closest(selectors.card)===root.closest(selectors.card));
}
function readLayer(root: Element, excluded: Element | null, entry: boolean): RawPost {
  const author = own(root,selectors.author,excluded)[0];
  const time = author?.querySelector('time') ?? own(root,'a[href*="/status/"] time',excluded)
    .find(t=>!t.closest(selectors.article)&&t.closest(selectors.card)===root);
  const statusHref = time?.closest('a')?.getAttribute('href') ??
    own(root,'a[href*="/status/"]',excluded).map(a=>a.getAttribute('href')).find(h=>h && postUrl(h)) ?? null;
  const url = statusHref ? postUrl(statusHref) : null;
  const authorClone = author?.cloneNode(true) as Element | undefined;
  for(const t of authorClone?.querySelectorAll('time') ?? []) (t.closest('a') ?? t).remove();
  const authorText = authorClone ? textWithEmoji(authorClone) : '';
  const handleNodes = author ? Array.from(author.querySelectorAll('a,span')).map(textWithEmoji)
    .filter(t=>/^@[a-z0-9_]{1,50}$/i.test(t)) : [];
  const handle = handleNodes.at(-1) ?? authorText.match(/@[a-z0-9_]{1,50}/i)?.[0] ?? null;
  const nameLink = author && Array.from(author.querySelectorAll('a')).find(a => !textWithEmoji(a).startsWith('@') &&
    !a.querySelector('time') && /^\/[a-z0-9_]+$/i.test(a.getAttribute('href') ?? ''));
  const authorName = nameLink ? textWithEmoji(nameLink).trim() : handle ?
    authorText.split(handle)[0].replace(/·\s*$/,'').trim() || null : null;
  const bodies = own(root,selectors.body,excluded);
  if (bodies.length > 1) throw new CollectorError('DOM_UNSUPPORTED','正文边界无法可靠区分。');
  const body = bodies[0];
  const articleBody=own(root,selectors.articleBody,excluded)[0];
  const articleTitle=own(root,selectors.articleTitle,excluded)[0];
  const content=articleBody??body;
  const links: LinkEvidence[] = [];
  const anchors = own(root,'a[href]',excluded).filter(a =>
    !!content?.contains(a) || /github\.com/i.test(textWithEmoji(a)) || /https:\/\/github\.com\//i.test(a.getAttribute('href') ?? ''));
  for (const a of anchors) {
    const href = a.getAttribute('href');
    if (!href) continue;
    const expanded = a.getAttribute('data-expanded-url') ?? a.getAttribute('title');
    if (githubCandidate(href) || githubCandidate(expanded) || githubCandidate(textWithEmoji(a))) {
      links.push({href,expandedUrl:expanded?.startsWith('https://') && !/[.…]$/.test(expanded) ? expanded : null,
        candidate:textWithEmoji(a)});
    }
  }
  if (content) {
    // Only bare text nodes: the text of truncated anchors is never promoted to a literal URL.
    const walk = (n: Node): void => {
      if (n.nodeType === 1 && (n as Element).tagName === 'A') return;
      if(n.nodeType===1&&(n as Element).getAttribute('data-testid')==='tweet')return;
      if (n.nodeType === 3) for (const match of (n.textContent ?? '').matchAll(/https:\/\/github\.com\/[^\s<>"，。；）)]+/g)) {
        if (!match[0].includes('…') && !match[0].endsWith('...')) links.push({href:match[0],expandedUrl:null,candidate:null});
      }
      for (const child of Array.from(n.childNodes)) walk(child);
    }; walk(content);
  }
  const previewRoot = own(root,'[data-testid="testCondensedMedia"]',excluded)[0];
  const rawTime = time?.getAttribute('datetime') ?? null;
  const publishedAt = rawTime && Number.isFinite(Date.parse(rawTime)) ? rawTime : null;
  if (entry && !url) throw new CollectorError('DOM_UNSUPPORTED','无法确定入口帖子身份。');
  const blocks=articleBody?Array.from(articleBody.querySelectorAll('[data-block="true"]'))
    .filter(e=>e.closest(selectors.card)===root.closest(selectors.card)&&!e.parentElement?.closest('[data-block="true"]')):[];
  const articleReady=!!articleBody&&!!textWithEmoji(articleBody).trim();
  const articleText=articleBody?[articleTitle?textWithEmoji(articleTitle):'',
    blocks.length?blocks.map(textWithEmoji).join('\n'):textWithEmoji(articleBody)].filter(Boolean).join('\n\n'):null;
  return {url,postId:url?.match(/\/status\/(\d+)$/)?.[1] ?? null,authorName,authorHandle:handle,
    publishedAt,publishedDisplay:time?.textContent ?? null,
    body:{text:articleText??(body ? textWithEmoji(body) : null),completeness:articleBody?(articleReady?'displayed':'unavailable'):body ?
      own(root,selectors.more,excluded).length ? 'truncated' : 'displayed' : 'unavailable'},
    links,articlePreview:previewRoot ? textWithEmoji(previewRoot) : null};
}
export function readPost(card: Element): PostSnapshot {
  const quote = quoteRoot(card);
  const entry = readLayer(card,quote,true);
  const quoted = quote ? readLayer(quote,null,false) : null;
  const warnings: string[] = [];
  if (entry.body.completeness !== 'displayed') warnings.push('入口正文未完整读取');
  if (quoted && !quoted.url) warnings.push('引用帖链接未读取');
  if (quoted && quoted.body.completeness !== 'displayed') warnings.push('引用正文未完整读取');
  if (!entry.publishedAt || (quoted && !quoted.publishedAt)) warnings.push('部分发布时间未读取');
  const repost = Array.from(card.querySelectorAll('[data-testid="socialContext"]')).some(e => /Reposted|转帖|转发/i.test(textWithEmoji(e)));
  return {schemaVersion:1,source:'x',entry,quoted,relation:quote ? 'quote' : repost ? 'repost' : 'none',
    collectedAt:new Date().toISOString(),warnings};
}
export function actionGroup(card: Element): Element | null {
  const groups = Array.from(card.querySelectorAll('[role="group"]')).filter(e => e.closest(selectors.card)===card&&
    !e.closest(selectors.article)&&
    e.querySelector('[data-testid="reply"]') && e.querySelector('[data-testid="like"]'));
  return groups.length === 1 ? groups[0] : null;
}
