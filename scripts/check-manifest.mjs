import {readFile,access} from 'node:fs/promises';
import assert from 'node:assert/strict';
const m=JSON.parse(await readFile('dist/manifest.json','utf8'));
assert.equal(m.manifest_version,3);assert.equal(m.background.type,'module');
assert.deepEqual(m.permissions,['storage','alarms','declarativeNetRequest']);
assert(!m.host_permissions.includes('<all_urls>'));assert(!m.externally_connectable);assert(!m.web_accessible_resources);
for(const f of [m.background.service_worker,...m.content_scripts.flatMap(s=>s.js),m.options_page,m.action.default_popup,'detail.html'])await access('dist/'+f);
for(const name of ['background','content','options','popup','detail']){
  const s=await readFile('dist/'+name+'.js','utf8');assert(!/\b(?:eval|new Function)\s*\(/.test(s));assert(!/pt-[a-zA-Z0-9_-]{20,}/.test(s));
}
assert.match(m.content_security_policy.extension_pages,/script-src 'self'/);
console.log('manifest／文件入口／本地脚本／凭证样例检查通过。');
