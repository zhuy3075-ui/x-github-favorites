export type LinkEvidence = { href: string; expandedUrl: string | null; candidate: string | null };
export type RawPost = {
  url: string | null; postId: string | null; authorName: string | null; authorHandle: string | null;
  publishedAt: string | null; publishedDisplay: string | null;
  body: { text: string | null; completeness: 'displayed' | 'truncated' | 'unavailable' };
  links: LinkEvidence[]; articlePreview: string | null;
};
export type PostSnapshot = {
  schemaVersion: 1; source: 'x'; entry: RawPost; quoted: RawPost | null;
  relation: 'none' | 'quote' | 'repost' | 'unknown'; collectedAt: string; warnings: string[];
};
export type Repository = { key: string; name: string; url: string };
export type Observation = {
  repository: Repository; primarySource: 'entry' | 'quoted'; linkLocation: 'entry' | 'quoted' | 'both';
  originalUrls: string[]; observationId: string;
};
export type Field = { field_id: string; field_name: string; type: number; property?: { options?: { name: string }[] } | null };
export type Target = { baseAppToken: string; tableId: string; url: string; fieldMapping: Record<string, string> };
export type Settings = Target & { revision: number; credentialVersion: number; connectedAt: string };
export type StoredSettings = { settings: Settings; credential: string };
export type RepoResult = { repositoryKey: string; repositoryName: string; repositoryUrl: string;
  outcome: 'created' | 'existing' | 'source_appended' | 'failed' | 'uncertain'; recordId: string | null; error: string | null };
export type JobStatus = 'queued' | 'extracting' | 'checking' | 'saving' | 'success' | 'partial' | 'failed' |
  'uncertain' | 'interrupted' | 'paused_config_changed' | 'no_repository';
export type Job = {
  schemaVersion: 1; id: string; requestId: string; snapshot: PostSnapshot; target: Settings;
  status: JobStatus; createdAt: string; updatedAt: string; results: RepoResult[]; warnings: string[];
  error: string | null; entryFingerprint: string; observations: Observation[]; resolved: boolean; complete: boolean;
  expectedKeys: string[]; activityMs: number;
  displayedSnapshot?:PostSnapshot; readFingerprints?:string[]; detailAttempted?:boolean;
  detailReader?:{nonce:string;targetUrl:string;tabId:number|null;keepOpen?:boolean}|null;
  intent: { repositoryKey: string; observationId: string; operation: 'create' | 'append'; recordId: string | null;
    state: 'sending' | 'uncertain' } | null;
};
export type FavoriteStatus = 'saved' | 'partial' | 'repositories_known' | 'new' | 'unknown' | 'not_configured';
export class CollectorError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.name = 'CollectorError'; this.code = code; }
}
export function messageOf(error: unknown): string {
  if (error instanceof CollectorError) return error.message;
  return '操作未完成，请检查网络后重试。';
}
