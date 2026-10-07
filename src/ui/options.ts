import { send,el,showError } from './shared.ts';
import { fieldTypes } from '../destinations/feishu/fields.ts';
import type { Field, Settings, Target } from '../domain/types.ts';
const form=document.querySelector<HTMLFormElement>('#connection')!;
const url=document.querySelector<HTMLInputElement>('#base-url')!;
const token=document.querySelector<HTMLInputElement>('#credential')!;
const table=document.querySelector<HTMLSelectElement>('#table')!;
const feedback=document.querySelector<HTMLElement>('#feedback')!;
const mappings=document.querySelector<HTMLElement>('#mappings')!;
const check=document.querySelector<HTMLButtonElement>('#check')!;
const save=document.querySelector<HTMLButtonElement>('#save')!;
let fields:Field[]=[];let mapping:Record<string,string>={};let checkedUrl='',checkedCredential='',checkedTable='';
type Connection={tables:{table_id:string;name:string}[];fields:Field[];mapping:Record<string,string>;target:Target};
function renderMappings(){
  mappings.replaceChildren();
  for(const [name,type]of Object.entries(fieldTypes)){
    const row=el('div',undefined,'mapping-row');const label=el('label',name);const select=el('select');
    select.id='mapping-'+name;label.htmlFor=select.id;
    const empty=el('option','请选择对应列');empty.value='';select.append(empty);
    for(const f of fields.filter(f=>f.type===type)){const o=el('option',f.field_name);o.value=f.field_id;select.append(o);}
    select.value=mapping[name]??'';select.addEventListener('change',()=>{mapping[name]=select.value;validate();});
    row.append(label,select);mappings.append(row);
  }validate();
}
function validate(){
  const ids=Object.values(mapping);
  save.disabled=fields.length===0 || Object.keys(fieldTypes).some(n=>!mapping[n]) || new Set(ids).size!==ids.length ||
    url.value!==checkedUrl || token.value!==checkedCredential || table.value!==checkedTable;
}
function invalidate(){fields=[];save.disabled=true;feedback.textContent='配置已变更，请重新检查连接。';}
url.addEventListener('input',()=>{table.replaceChildren();const empty=el('option','根据链接定位或检查后选择');empty.value='';table.append(empty);invalidate();});
token.addEventListener('input',invalidate);
table.addEventListener('change',()=>{fields=[];save.disabled=true;feedback.textContent='请重新检查所选数据表。';});
document.querySelector<HTMLButtonElement>('#show-token')!.addEventListener('click',()=>{
  token.type=token.type==='password'?'text':'password';
  document.querySelector('#show-token')!.textContent=token.type==='password'?'显示':'隐藏';
});
check.addEventListener('click',async()=>{
  check.disabled=true;save.disabled=true;feedback.classList.remove('error');feedback.textContent='正在读取表格和字段…';
  try{
    const result=await send<Connection>('CHECK_CONNECTION',{url:url.value,credential:token.value,tableId:table.value});
    table.replaceChildren();const empty=el('option','选择数据表');empty.value='';table.append(empty);
    for(const t of result.tables){const o=el('option',t.name);o.value=t.table_id;table.append(o);}
    table.value=result.target.tableId;
    fields=result.fields;mapping=result.mapping;checkedUrl=url.value;checkedCredential=token.value;checkedTable=table.value;
    renderMappings();
    feedback.textContent=fields.length?'读取检查通过；写入将在首次收藏时验证。':'请选择数据表后再次检查连接。';
  }catch(error){showError(feedback,error);}
  finally{check.disabled=false;}
});
form.addEventListener('submit',async event=>{
  event.preventDefault();if(save.disabled)return;save.disabled=true;check.disabled=true;
  try{
    await send('SAVE_SETTINGS',{url:url.value,credential:token.value,tableId:table.value,fieldMapping:mapping});
    token.value='';token.type='password';token.placeholder='已保存；输入新授权码可替换';
    checkedCredential='';feedback.classList.remove('error');feedback.textContent='设置已保存，可以回到 X 一键收藏。';
  }catch(error){showError(feedback,error);}
  finally{check.disabled=false;validate();}
});
async function start(){
  const current=await send<{settings:Settings|null;hasCredential:boolean}>('GET_PUBLIC_SETTINGS');
  if(current.settings){
    url.value=current.settings.url;const o=el('option','当前表 · '+current.settings.tableId);o.value=current.settings.tableId;
    table.append(o);table.value=current.settings.tableId;mapping=current.settings.fieldMapping;
    if(current.hasCredential)token.placeholder='已保存；输入新授权码可替换';
    feedback.textContent='已保存连接；点击检查连接可核对或调整字段。';
  }else{
    url.value=''; // Each user connects their own table; no personal table is shipped.
  }
}
void start().catch(error=>showError(feedback,error));
