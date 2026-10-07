import type { Settings, StoredSettings } from '../domain/types.ts';
import { CollectorError } from '../domain/types.ts';
export async function protectSettings():Promise<void>{
  await chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
}
export async function storedSettings():Promise<StoredSettings|null>{
  const value=(await chrome.storage.local.get('connection')).connection as StoredSettings|undefined;
  return value?.settings && value.credential ? value : null;
}
export function validateCredential(value:string):string{
  const token=value.trim();
  if(!/^pt-[a-z0-9_-]{16,512}$/i.test(token))throw new CollectorError('AUTH_INVALID','请输入此多维表格的 pt- 授权码。');
  return token;
}
export async function saveConnection(settings:Settings,credential:string):Promise<void>{
  await chrome.storage.local.set({connection:{settings,credential:validateCredential(credential)}});
}
export async function credentialFor(settings:Settings):Promise<string>{
  const saved=await storedSettings();
  if(!saved || saved.settings.revision!==settings.revision || saved.settings.credentialVersion!==settings.credentialVersion)
    throw new CollectorError('CONFIG_CHANGED','设置已变更，旧任务已暂停。');
  return saved.credential;
}
