// @module workbench
// @role model
/** Browser-owned incomplete input. It never grants authority or substitutes for a server revision. */
export interface ProjectDraft {
 kind:'project'|'workspace';
 name:string;
 workspaceId:string;
 key:string;
 slug:string;
 description:string;
}
export const emptyProjectDraft=(kind:ProjectDraft['kind'],workspaceId=''):ProjectDraft=>({kind,name:'',workspaceId,key:'',slug:'',description:''});
export function parseProjectDraft(value:unknown):ProjectDraft {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid_directory_draft');
 const v=value as Record<string,unknown>;
 if(!['project','workspace'].includes(String(v.kind))||['name','workspaceId','key','slug','description'].some(k=>typeof v[k]!=='string'))throw new Error('invalid_directory_draft');
 return {kind:v.kind as ProjectDraft['kind'],name:v.name as string,workspaceId:v.workspaceId as string,key:v.key as string,slug:v.slug as string,description:v.description as string};
}

import type {DirectoryChange,DirectoryEntity,DirectoryManagement} from '../../modules/work/directory-contracts';
import {decodeDirectoryChange} from '../../modules/work/public';
export interface ProjectSubmission {owner:string;command:DirectoryChange}
export interface ProjectEditState {version:1;owner:string;draft:ProjectDraft;base:DirectoryEntity|null;pending:ProjectSubmission|null;held:ProjectSubmission[]}
export function entityDraft(entity:DirectoryEntity):ProjectDraft {
 return {kind:entity.kind,name:entity.name,workspaceId:entity.kind==='project'?entity.workspaceId:'',key:entity.kind==='project'?entity.key:'',slug:entity.kind==='project'?entity.slug:'',description:entity.kind==='project'?entity.description:''};
}
const object=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid_directory_state');return value as Record<string,unknown>;};
export function directoryEntity(value:unknown):DirectoryEntity {
 const v=object(value);if(!['project','workspace'].includes(String(v.kind))||typeof v.id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(v.id)||typeof v.name!=='string'||!Number.isSafeInteger(v.revision)||Number(v.revision)<1)throw new Error('invalid_directory_entity');
 if(v.kind==='workspace') {if(v.scopeId!=='workspace:'+v.id)throw new Error('invalid_directory_scope');return {kind:'workspace',id:v.id,name:v.name,revision:Number(v.revision),scopeId:String(v.scopeId)};}
 if(['workspaceId','key','slug','description'].some(k=>typeof v[k]!=='string'))throw new Error('invalid_directory_entity');
 return {kind:'project',id:v.id,name:v.name,revision:Number(v.revision),workspaceId:String(v.workspaceId),key:String(v.key),slug:String(v.slug),description:String(v.description)};
}
export function directoryManagement(value:unknown):DirectoryManagement {
 const v=object(value);if(typeof v.canCreate!=='boolean'||!Array.isArray(v.projects)||!Array.isArray(v.workspaces))throw new Error('invalid_directory_management');
 const projects=v.projects.map(directoryEntity),workspaces=v.workspaces.map(directoryEntity);
 if(projects.some(p=>p.kind!=='project')||workspaces.some(w=>w.kind!=='workspace'))throw new Error('invalid_directory_management');
 return {canCreate:v.canCreate,projects:projects as DirectoryManagement['projects'],workspaces:workspaces as DirectoryManagement['workspaces']};
}
export function projectCommand(draft:ProjectDraft,base:DirectoryEntity|null,operationId:string):DirectoryChange {
 if(base&&base.kind!==draft.kind)throw new Error('invalid_directory_target');
 const input={operationId,name:draft.name,...(base?{revision:base.revision}:{}),...(draft.kind==='project'?{description:draft.description,...(!base?{workspaceId:draft.workspaceId,key:draft.key,slug:draft.slug}:{})}:{})};
 return decodeDirectoryChange(draft.kind,base?.id,input);
}
function submission(value:unknown,owner:string):ProjectSubmission {
 const v=object(value),c=object(v.command);if(v.owner!==owner||!['project','workspace'].includes(String(c.kind))||!['create','edit'].includes(String(c.action))||(c.action==='edit'&&typeof c.id!=='string'))throw new Error('invalid_directory_operation');
 return {owner,command:decodeDirectoryChange(c.kind as DirectoryChange['kind'],c.action==='edit'?String(c.id):undefined,c.input)};
}
export function restoreProjectState(value:unknown,owner:string):ProjectEditState {
 const v=object(value);if(v.version!==1||v.owner!==owner||!Array.isArray(v.held))throw new Error('invalid_directory_state');
 const draft=parseProjectDraft(v.draft),base=v.base===null?null:directoryEntity(v.base),pending=v.pending===null?null:submission(v.pending,owner),held=v.held.map(p=>submission(p,owner));
 if(base&&base.kind!==draft.kind)throw new Error('invalid_directory_target');
 if(pending&&(pending.command.kind!==draft.kind||(base?(pending.command.action!=='edit'||pending.command.id!==base.id||pending.command.input.revision!==base.revision):pending.command.action!=='create')))throw new Error('invalid_directory_operation');
 return {version:1,owner,draft,base,pending,held};
}
export function managesEntity(context:DirectoryManagement,entity:DirectoryEntity):boolean {
 return (entity.kind==='project'?context.projects:context.workspaces).some(v=>v.id===entity.id);
}
export function matchesProjectReceipt(command:DirectoryChange,snapshot:DirectoryEntity):boolean {
 if(command.kind!==snapshot.kind)return false;
 if(command.action==='edit')return command.id===snapshot.id&&snapshot.revision===command.input.revision+1;
 if(snapshot.revision!==1||snapshot.name!==command.input.name)return false;
 return command.kind!=='project'||snapshot.kind==='project'&&snapshot.workspaceId===command.input.workspaceId&&snapshot.key===command.input.key&&snapshot.slug===command.input.slug&&snapshot.description===command.input.description;
}
