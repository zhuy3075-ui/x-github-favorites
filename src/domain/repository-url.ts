import type { Repository } from './types.ts';
const reserved = new Set(['settings','search','topics','collections','trending','marketplace','login','logout',
  'signup','join','features','enterprise','pricing','about','contact','security','sponsors','orgs','users',
  'organizations','site','apps','new','notifications','explore','account','codespaces','copilot','dashboard']);
const suffixes = new Set(['tree','blob','issues','pull','pulls','releases','commit','commits','compare','wiki',
  'discussions','actions','projects','milestones','tags','branches','stargazers','watchers','forks']);
export function repositoryFromUrl(value: string): Repository | null {
  let url: URL; try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port) return null;
  if (/%2f|%5c/i.test(url.pathname) || value.includes('\\') || value.includes('…')) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2 || reserved.has(parts[0].toLowerCase())) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38})$/i.test(parts[0]) || !/^[a-z0-9_.-]+$/i.test(parts[1])) return null;
  let repo = parts[1].replace(/\.git$/i, '');
  if (!repo || repo === '.' || repo === '..' || !/[a-z0-9_]/i.test(repo)) return null;
  if (parts.length > 2 && !suffixes.has(parts[2])) return null;
  const name = parts[0] + '/' + repo;
  return { key: name.toLowerCase(), name, url: 'https://github.com/' + name };
}
export function githubCandidate(value: string | null): boolean {
  return !!value && /(?:https:\/\/)?github\.com\//i.test(value);
}
export function shortLink(value: string): boolean {
  try { const u = new URL(value); return u.protocol === 'https:' && u.hostname === 't.co' && !u.port &&
    !u.username && !u.password && /^\/[a-z0-9]+$/i.test(u.pathname); } catch { return false; }
}
export function postUrl(value: string, base = 'https://x.com'): string | null {
  try {
    const u = new URL(value, base);
    if (u.protocol !== 'https:' || !['x.com','twitter.com'].includes(u.hostname) || u.port || u.username || u.password) return null;
    const match = u.pathname.match(/^\/([a-z0-9_]+)\/status\/(\d+)(?:\/(?:photo|video)\/\d+)?$/i);
    return match ? 'https://x.com/' + match[1] + '/status/' + match[2] : null;
  } catch { return null; }
}
