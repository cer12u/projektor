// @module work
// @role domain-rules
import type {Permission} from '../identity/dto';
import {InputError} from '../change-outcomes';
import type {DirectoryChange,DirectoryQuery} from './directory-contracts';
import {validateOperationId} from './rules';
export const DIRECTORY_INPUT_LIMIT=8192;
export const DIRECTORY_KINDS=['directory.project.create','directory.project.edit','directory.workspace.create','directory.workspace.edit'] as const;
export const directoryPolicy={create:'global-administrator',edit:'global-administrator-or-scoped-manager'} as const;
export function directoryPermissions(action:'create'|'edit'):Permission[]{return action==='create'?[]:['view','manage'];}
const fail=()=>new InputError('invalid_directory_input');
export function validateDirectoryQuery(x:DirectoryQuery):void{if(!['project','workspace'].includes(x.kind)||typeof x.id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(x.id))throw fail();}
export function decodeDirectoryChange(kind:'project'|'workspace',id:string|undefined,raw:unknown):DirectoryChange {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw fail();const v=raw as Record<string,unknown>,edit=id!==undefined;
 if(!['project','workspace'].includes(kind))throw fail();if(edit)validateDirectoryQuery({kind,id});
 const fields=['operationId','name',...(edit?['revision']:[]),...(kind==='project'?['description',...(edit?[]:['workspaceId','key','slug'])]:[])];
 if(Object.keys(v).some(k=>!fields.includes(k)))throw fail();validateOperationId(v.operationId as string);
 if(edit&&(!Number.isSafeInteger(v.revision)||(Number(v.revision)<1||Number(v.revision)>=Number.MAX_SAFE_INTEGER)))throw fail();
 const str=(key:string,max:number,required:boolean)=>{if(!(key in v)&&!required)return;if(typeof v[key]!=='string'||(key!=='description'&&!v[key].trim())||v[key].length>max)throw fail();};
 str('name',200,!edit||kind==='workspace');if(kind==='project')str('description',4000,!edit);
 if(kind==='project'&&!edit){for(const key of ['workspaceId','key','slug'])str(key,128,true);validateDirectoryQuery({kind:'workspace',id:v.workspaceId as string});if(!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(v.key as string)||!/^[a-z0-9][a-z0-9-]*$/.test(v.slug as string))throw fail();}
 if(edit&&kind==='project'&&!('name'in v)&&!('description'in v))throw fail();
 if(new TextEncoder().encode(JSON.stringify(v)).byteLength>DIRECTORY_INPUT_LIMIT)throw fail();
 return {kind,action:edit?'edit':'create',...(edit?{id}:{}),input:{...v}} as DirectoryChange;
}
export function normalizeDirectoryChange(x:DirectoryChange):DirectoryChange{return decodeDirectoryChange(x.kind,x.action==='edit'?x.id:undefined,x.input);}
