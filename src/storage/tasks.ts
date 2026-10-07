import { CollectorError } from '../domain/types.ts';
import type { Job } from '../domain/types.ts';
const canArchive=(job:Job)=>job.status==='success'||(job.status==='no_repository'&&job.complete);
export function openTasks(factory:IDBFactory=indexedDB):Promise<IDBDatabase>{
  return new Promise((resolve,reject)=>{
    const req=factory.open('x-github-favorites',1);
    req.onupgradeneeded=()=>req.result.createObjectStore('jobs',{keyPath:'id'});
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(new CollectorError('CAPACITY_EXCEEDED','本机任务存储无法打开，现有数据未改动。'));
  });
}
export class TaskStore {
  db:Promise<IDBDatabase>;
  constructor(factory:IDBFactory=indexedDB){this.db=openTasks(factory);}
  async all():Promise<Job[]>{
    const db=await this.db;
    return new Promise((resolve,reject)=>{
      const req=db.transaction('jobs').objectStore('jobs').getAll();
      req.onsuccess=()=>{const jobs=req.result as Job[];if(jobs.some(j=>j.schemaVersion!==1)){
        reject(new CollectorError('CAPACITY_EXCEEDED','任务数据版本较新，请更新插件。'));return;}
        resolve(jobs.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)));};
      req.onerror=()=>reject(new CollectorError('CAPACITY_EXCEEDED','本机任务读取失败。'));
    });
  }
  async get(id:string):Promise<Job|undefined>{return (await this.all()).find(j=>j.id===id);}
  async clearDetailReader(id:string,nonce:string):Promise<void>{
    const db=await this.db;
    return new Promise((resolve,reject)=>{
      const tx=db.transaction('jobs','readwrite'),store=tx.objectStore('jobs'),req=store.get(id);
      req.onsuccess=()=>{
        const current=req.result as Job|undefined;
        if(current?.schemaVersion===1&&current.detailReader?.nonce===nonce){current.detailReader=null;store.put(current);}
      };
      tx.oncomplete=()=>resolve();
      tx.onabort=tx.onerror=()=>reject(new CollectorError('CAPACITY_EXCEEDED','临时详情页清理记录未能保存。'));
    });
  }
  async put(job:Job):Promise<void>{
    const db=await this.db;
    return new Promise((resolve,reject)=>{
      const tx=db.transaction('jobs','readwrite'),store=tx.objectStore('jobs'),req=store.getAll();
      let reason='任务无法保存到本机，请检查存储空间。';
      req.onsuccess=()=>{
        const all=req.result as Job[];
        if(all.some(j=>j.schemaVersion!==1)){reason='任务数据版本较新，停止写入。';tx.abort();return;}
        const completed=all.filter(j=>canArchive(j)&&j.id!==job.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
        const remove=completed.filter((j,i)=>i>=99 || Date.parse(j.createdAt)<Date.now()-30*86400000);
        const kept=all.filter(j=>j.id!==job.id&&!remove.some(r=>r.id===j.id));
        if(new TextEncoder().encode(JSON.stringify([...kept,job])).length>20*1024*1024){
          reason='本机任务存储已满，未接收新任务；未决任务仍保留。';tx.abort();return;}
        for(const old of remove)store.delete(old.id);
        store.put(job);
      };
      tx.oncomplete=()=>resolve();
      tx.onabort=()=>reject(new CollectorError('CAPACITY_EXCEEDED',reason));
      tx.onerror=()=>reject(new CollectorError('CAPACITY_EXCEEDED',reason));
    });
  }
}
