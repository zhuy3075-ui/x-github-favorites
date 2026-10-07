import { CollectorError } from '../../domain/types.ts';
import type { Field, Target } from '../../domain/types.ts';
import {diagnoseFeishuReadFailure} from '../../network/feishu-read-diagnostics.ts';
export type FeishuRecord = { record_id:string; fields:Record<string,unknown> };
export class FeishuClient {
  target: Target; credential: string; fetcher:typeof fetch; deadline:number;
  constructor(target:Target,credential:string,fetcher:typeof fetch=fetch,deadline=Date.now()+120000) {
    this.target=target;this.credential=credential;this.fetcher=fetcher;this.deadline=deadline;
  }
  path(suffix:string):string {
    return '/open-apis/bitable/v1/apps/'+encodeURIComponent(this.target.baseAppToken)+'/tables'+suffix;
  }
  async request(method:string,path:string,body?:unknown):Promise<Record<string,unknown>> {
    if (Date.now()>=this.deadline) throw new CollectorError('INTERRUPTED','任务超时，请在详情中重试。');
    const write = method !== 'GET';
    for (let attempt=0;attempt<(write?1:2);attempt++) {
      try {
        const r = await this.fetcher.call(globalThis,'https://base-api.feishu.cn'+path,{method,redirect:'error',credentials:'omit',
          headers:{Authorization:'Bearer '+this.credential,'Content-Type':'application/json; charset=utf-8'},
          ...(body===undefined?{}:{body:JSON.stringify(body)}),
          signal:AbortSignal.timeout(Math.min(15000,Math.max(1,this.deadline-Date.now())))});
        if (write && (r.status>=500 || r.status===408)) throw new CollectorError('WRITE_UNCERTAIN','写入结果待核对，请勿重复提交。');
        if (r.status===429) throw new CollectorError('RATE_LIMITED','请求频繁，请稍后在详情中重试。');
        if ([401,403].includes(r.status)) throw new CollectorError('AUTH_INVALID','授权码不可用或没有本表权限，请检查设置。');
        let j: {code?:number;data?:Record<string,unknown>};try {j=await r.json();}catch {
          throw new CollectorError(write?'WRITE_UNCERTAIN':'PERMISSION_DENIED','接口未返回可核验结果。'); }
        if (!r.ok || j.code!==0) throw new CollectorError('PERMISSION_DENIED','飞书接口拒绝操作（HTTP '+r.status+'，业务码 '+String(j.code??'缺失')+'）。');
        if (!j.data) throw new CollectorError(write?'WRITE_UNCERTAIN':'PERMISSION_DENIED','接口缺少结果数据。');
        return j.data;
      } catch (error) {
        if (error instanceof CollectorError) throw error;
        if (write) throw new CollectorError('WRITE_UNCERTAIN','网络中断，写入结果待核对。');
        if (attempt===1 || Date.now()>=this.deadline) {
          const diagnostic=await diagnoseFeishuReadFailure(error);
          console.error('[Favorites] 飞书读取失败',{code:diagnostic.code,reason:diagnostic.message});
          throw diagnostic;
        }
      }
    } throw new CollectorError('INTERRUPTED','读取失败。');
  }
  async paged(path:string,limit:number):Promise<unknown[]> {
    const items:unknown[]=[];let token='',bytes=0;const seen=new Set<string>();
    for(let page=0;page<50;page++){
      const q=new URLSearchParams({page_size:'100'});if(token)q.set('page_token',token);
      const data=await this.request('GET',path+'?'+q);
      if(!Array.isArray(data.items)){
        // Empty SDK lists may omit items. Only a complete first page proving zero total is safe.
        if(page===0&&data.items==null&&data.has_more===false&&data.total===0)return [];
        const kind=data.items===undefined?'缺失':data.items===null?'null':typeof data.items;
        const more=data.has_more===true?'true':data.has_more===false?'false':'未确认';
        const total=typeof data.total==='number'&&Number.isFinite(data.total)?String(data.total):'未确认';
        throw new CollectorError('PERMISSION_DENIED','接口记录格式不兼容（items='+kind+'，has_more='+more+'，total='+total+'）。');
      }
      bytes+=new TextEncoder().encode(JSON.stringify(data.items)).length;
      if(bytes>20*1024*1024)throw new CollectorError('SCAN_LIMIT','查重数据超过本版容量限制，未执行写入。');
      items.push(...data.items);if(items.length>limit)throw new CollectorError('SCAN_LIMIT','查重范围超过限制，未执行写入。');
      if(data.has_more===false)return items;
      if(data.has_more!==true || typeof data.page_token!=='string' || !data.page_token || seen.has(data.page_token))
        throw new CollectorError('SCAN_LIMIT','分页查重未完成，未执行写入。');
      token=data.page_token;seen.add(token);
    }throw new CollectorError('SCAN_LIMIT','分页查重超出限制，未执行写入。');
  }
  async tables():Promise<{table_id:string;name:string}[]> {return await this.paged(this.path(''),1000) as {table_id:string;name:string}[];}
  async fields():Promise<Field[]> {
    const fields=await this.paged(this.path('/'+encodeURIComponent(this.target.tableId)+'/fields'),500) as Field[];
    if(fields.some(f=>typeof f.field_id!=='string' || typeof f.field_name!=='string' || typeof f.type!=='number'))
      throw new CollectorError('FIELD_MISMATCH','字段接口格式不兼容。');
    return fields;
  }
  async records():Promise<FeishuRecord[]> {
    const records=await this.paged(this.path('/'+encodeURIComponent(this.target.tableId)+'/records'),5000) as FeishuRecord[];
    if(records.some(r=>!r.record_id || !r.fields))throw new CollectorError('PERMISSION_DENIED','记录结构不兼容。');
    return records;
  }
  async create(fields:Record<string,unknown>):Promise<string> {
    const data=await this.request('POST',this.path('/'+encodeURIComponent(this.target.tableId)+'/records'),{fields});
    const record=data.record as FeishuRecord|undefined;if(!record?.record_id)throw new CollectorError('WRITE_UNCERTAIN','新增结果缺少记录 ID。');
    return record.record_id;
  }
  async append(recordId:string,fieldName:string,text:string):Promise<void> {
    const data=await this.request('PUT',this.path('/'+encodeURIComponent(this.target.tableId)+'/records/'+encodeURIComponent(recordId)),
      {fields:{[fieldName]:text}});
    if(!(data.record as FeishuRecord|undefined)?.record_id)throw new CollectorError('WRITE_UNCERTAIN','来源追加结果待核对。');
  }
}
