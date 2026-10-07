import type { Field, Target, Observation, PostSnapshot } from '../../domain/types.ts';
import { CollectorError } from '../../domain/types.ts';
export const fieldTypes: Record<string, number> = {
  '仓库名称':1,'GitHub 链接':15,'帖子原文':1,'原帖链接':15,'博主名称':1,'博主账号':1,'发帖时间':5,
  '入口帖子链接':15,'入口帖原文':1,'引用帖链接':15,'引用帖原文':1,'引用关系':3,'链接位置':3,'采集时间':5,'采集状态':3,'来源记录':1,
};
const options: Record<string, string[]> = {
  '引用关系':['无引用','有一层引用','纯转发','待核对'],
  '链接位置':['入口帖','引用帖','两者'],'采集状态':['已读取当前展示内容','部分缺失','待核对'],
};
export function fieldBindings(fields: Field[], mapping: Record<string,string>): Record<string,Field> {
  const bindings: Record<string,Field> = {};
  const used = new Set<string>();
  for (const [name,type] of Object.entries(fieldTypes)) {
    const f = fields.find(f => f.field_id === mapping[name]);
    if (!f || f.type !== type || used.has(f.field_id)) throw new CollectorError('FIELD_MISMATCH','请调整字段映射：' + name);
    if (options[name]?.some(v=>!f.property?.options?.some(o=>o.name===v)))
      throw new CollectorError('FIELD_MISMATCH','单选字段缺少选项：' + name);
    used.add(f.field_id);bindings[name] = f;
  }
  return bindings;
}
export function recommendMapping(fields: Field[]): Record<string,string> {
  const result: Record<string,string> = {};
  for (const name of Object.keys(fieldTypes)) {
    const f = fields.find(f=>f.field_name===name || name==='帖子原文' && f.field_name==='功能原文');
    if (f) result[name]=f.field_id;
  } return result;
}
export function plain(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(v=>typeof v === 'string' ? v :
    v && typeof v === 'object' ? String((v as Record<string,unknown>).text ?? '') : '').join('');
  return '';
}
export function linkValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as Record<string,unknown>).link === 'string')
    return (value as {link:string}).link;
  return null;
}
export function newFields(snapshot: PostSnapshot, observation: Observation, sourceText: string,
  bindings: Record<string,Field>, incomplete: boolean): Record<string,unknown> {
  const main = observation.primarySource==='quoted' ? snapshot.quoted! : snapshot.entry;
  const relation = {none:'无引用',quote:'有一层引用',repost:'纯转发',unknown:'待核对'}[snapshot.relation];
  const values: Record<string,unknown> = {
    '仓库名称':observation.repository.name,'GitHub 链接':{text:observation.repository.name,link:observation.repository.url},
    '帖子原文':main.body.text,'原帖链接':main.url ? {text:'原帖',link:main.url} : null,
    '博主名称':main.authorName,'博主账号':main.authorHandle,'发帖时间':main.publishedAt ? Date.parse(main.publishedAt) : null,
    '入口帖子链接':{text:'入口帖子',link:snapshot.entry.url},'入口帖原文':snapshot.entry.body.text,
    '引用帖链接':snapshot.quoted?.url ? {text:'引用帖',link:snapshot.quoted.url} : null,
    '引用帖原文':snapshot.quoted?.body.text ?? null,'引用关系':relation,
    '链接位置':{entry:'入口帖',quoted:'引用帖',both:'两者'}[observation.linkLocation],
    '采集时间':Date.parse(snapshot.collectedAt),'采集状态':incomplete ? '部分缺失' : '已读取当前展示内容','来源记录':sourceText,
  };
  const result: Record<string,unknown> = Object.create(null);
  for (const [name,value] of Object.entries(values)) if (value !== null) result[bindings[name].field_name] = value;
  return result;
}
export function parseTarget(value: string, tableOverride?: string): Omit<Target,'fieldMapping'> {
  let u: URL; try { u = new URL(value); } catch { throw new CollectorError('NOT_CONFIGURED','请填写完整多维表格链接。'); }
  const token = u.pathname.match(/^\/base\/([a-z0-9]+)\/?$/i)?.[1];
  const tableId = tableOverride || u.searchParams.get('table') || '';
  if (u.protocol!=='https:' || !(u.hostname==='feishu.cn' || u.hostname.endsWith('.feishu.cn')) || u.username || u.password || u.port || !token)
    throw new CollectorError('NOT_CONFIGURED','请使用飞书 /base/ 多维表格地址。');
  if (tableId && !/^tbl[a-z0-9]+$/i.test(tableId)) throw new CollectorError('NOT_CONFIGURED','数据表 ID 格式无效。');
  return {baseAppToken:token,tableId,url:u.origin+'/base/'+token+(tableId ? '?table='+tableId : '')};
}
