// @module work
// @role import-contract
import { ApiError } from "../../protocol-errors";
import {canonicalInput} from "../persistence/transaction";
import {type Json} from "../persistence/public";
import {validateIdentityImport} from "../identity/import-participant";
export type SourceTable='workspaces'|'projects'|'users'|'workspace_members'|'user_groups'|'user_group_members'|'group_project_grants'|'issues'|'issue_comments'|'activity'|'issue_resolution_events'|'wiki_pages'|'wiki_revisions'|'custom_field_definitions'|'task_statuses'|'task_types';
export interface SourceEntity{table:SourceTable;id:string;workspaceId:string;projectId:string|null;row:Record<string,Json>}
export interface ImportSubject{id:string;kind:'human'|'agent';displayName:string;loginId:string|null;active:boolean;globalAdministrator:boolean}
export interface ImportPermission{principalId:string;scopeId:string;permissions:string[]}
export interface ImportDataset{id:string;subjects:ImportSubject[];permissions:ImportPermission[];entities:SourceEntity[]}
export const supported=new Set<SourceTable>(['workspaces','projects','users','workspace_members','user_groups','user_group_members','group_project_grants','issues','issue_comments','activity','issue_resolution_events','wiki_pages','wiki_revisions','custom_field_definitions','task_statuses','task_types']);
export const identifier=/^[A-Za-z0-9_-]{1,128}$/;
export const sourceScope=(e:SourceEntity)=>e.projectId??'workspace:'+e.workspaceId;
export function text(row:Record<string,Json>,key:string,fallback?:string){const v=row[key];if(typeof v==='string')return v;if(fallback!==undefined&&(v===null||v===undefined))return fallback;throw new ApiError(400,'source_field_invalid');}
export function time(row:Record<string,Json>,key:string){const v=row[key];if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0)throw new ApiError(400,'source_time_invalid');return new Date(v*1000).toISOString();}
/** Source version 0 remains in the immutable row/metadata; editing revisions start at 1. */
export function wikiRevision(row:Record<string,Json>){const v=row.version;if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0)throw new ApiError(400,'source_version_invalid');return v===0?1:v;}
export function noCredentials(v:Json):void{if(typeof v==='string'&&new TextDecoder('utf-8',{ignoreBOM:true}).decode(new TextEncoder().encode(v))!==v)throw new ApiError(400,'source_field_invalid');if(!v||typeof v!=='object')return;for(const[k,x]of Object.entries(v)){if(/password|secret|token_hash|encoded_hash|csrf|cookie|access_token|bearer/i.test(k))throw new ApiError(400,'credential_data_forbidden');noCredentials(x);}}
export const stateFromSource=(s:string)=>({backlog:'Backlog',todo:'Todo',in_progress:'In Progress',in_review:'In Review',done:'Done',cancelled:'Canceled'}[s]);
export const sourceFromState=(s:string)=>({'Backlog':'backlog','Todo':'todo','In Progress':'in_progress','In Review':'in_review','Done':'done','Canceled':'cancelled'}[s]);
export const priorityFromSource=(s:string)=>({none:null,low:1,medium:2,high:3,urgent:4}[s]);
/** Shared pure validation for the existing runner and one-file SQL compiler. */
export function validateImportDataset(data:ImportDataset){
 if(!identifier.test(data.id)||data.entities.length>10000||data.subjects.length>256)throw new ApiError(400,'import_dataset_invalid');const seen=new Set<string>();
 for(const e of data.entities){if(!supported.has(e.table)||!identifier.test(e.id)||!identifier.test(e.workspaceId)||(e.projectId!==null&&!identifier.test(e.projectId))||seen.has(e.table+':'+e.id))throw new ApiError(400,'source_identity_invalid');if(e.row.id!==undefined&&e.row.id!==e.id)throw new ApiError(400,'source_identity_mismatch');if(e.row.project_id!==undefined&&e.row.project_id!==e.projectId)throw new ApiError(400,'source_project_mismatch');if(e.row.workspace_id!==undefined&&e.row.workspace_id!==e.workspaceId)throw new ApiError(400,'source_workspace_mismatch');noCredentials(e.row);canonicalInput(e.row,65536);seen.add(e.table+':'+e.id);}

 const entityIndex=new Map(data.entities.map(e=>[e.table+':'+e.id,e])),subjectIds=new Set(data.subjects.map(s=>s.id));
 const targetsById=new Map<string,SourceEntity[]>();for(const e of data.entities)if(e.table!=='activity'){const rows=targetsById.get(e.id)??[];rows.push(e);targetsById.set(e.id,rows);}
 const by=(table:SourceTable,id:Json|undefined)=>typeof id==='string'?entityIndex.get(table+':'+id):undefined;
 const same=(e:SourceEntity,p:SourceEntity|undefined)=>{if(!p||e.workspaceId!==p.workspaceId||e.projectId!==p.projectId)throw new ApiError(400,'source_reference_scope_mismatch');};
 for(const e of data.entities){
  if(e.table!=='workspaces'&&!by('workspaces',e.workspaceId))throw new ApiError(400,'source_workspace_missing');
  if(e.projectId!==null){const p=by('projects',e.projectId);if(!p||p.workspaceId!==e.workspaceId)throw new ApiError(400,'source_project_missing');}
  if(e.table==='issues'){if(e.projectId===null)throw new ApiError(400,'source_issue_project_required');if(e.row.parent_id!==null&&e.row.parent_id!==undefined)same(e,by('issues',e.row.parent_id));}
  if(e.table==='issue_comments'||e.table==='issue_resolution_events')same(e,by('issues',e.row.issue_id));
  if(e.table==='wiki_revisions')same(e,by('wiki_pages',e.row.page_id));
  if(e.table==='wiki_pages')wikiRevision(e.row);
  if(e.table==='wiki_pages'&&e.row.parent_id!==null&&e.row.parent_id!==undefined)same(e,by('wiki_pages',e.row.parent_id));
  if(e.table==='activity'){const targets=(typeof e.row.entity_id==='string'?targetsById.get(e.row.entity_id):undefined)??[];if(targets.length!==1)throw new ApiError(400,'source_activity_target_missing');same(e,targets[0]);}
  for(const k of['author_id','actor_id','created_by_id','updated_by_id','assignee_id'])if(e.row[k]!==undefined&&e.row[k]!==null&&(typeof e.row[k]!=='string'||!subjectIds.has(e.row[k])))throw new ApiError(400,'source_actor_missing');
 }
 validateIdentityImport(data);
}
export function canonicalImportRow(e:SourceEntity):{table:string;row:Record<string,Json>}|null{
 const r=e.row,source=canonicalInput(r,65536),scope=sourceScope(e);
 if(e.table==='workspaces')return{table:'workspaces',row:{id:e.id,name:text(r,'name'),source_json:source}};
 if(e.table==='projects')return{table:'projects',row:{id:e.id,workspace_id:e.workspaceId,key:text(r,'key'),slug:text(r,'slug',text(r,'key')),name:text(r,'name'),description:text(r,'description',''),source_json:source}};
 if(e.table==='issues'){
  const state=stateFromSource(text(r,'status'));if(!state)throw new ApiError(400,'source_status_invalid');const priority=text(r,'priority');if(!['none','low','medium','high','urgent'].includes(priority))throw new ApiError(400,'source_priority_invalid');
  return{table:'issues',row:{id:e.id,project_id:e.projectId,title:text(r,'title'),body:text(r,'body'),revision:1,created_at:time(r,'created_at'),updated_at:time(r,'updated_at'),before_body:null,priority:priorityFromSource(priority)!,assignee_id:r.assignee_id??null,state,resolved_at:typeof r.completed_at==='number'?new Date(r.completed_at*1000).toISOString():null,resolution_json:typeof r.completed_at==='number'?JSON.stringify({kind:'instant',at:new Date(r.completed_at*1000).toISOString()}):null,schedule_json:'{"start":null,"end":null,"due":null}',before_meta_json:null,workspace_id:e.workspaceId,number:r.number??null,parent_id:r.parent_id??null,type_id:r.type_id??null,status_id:r.status_id??null,created_by_id:r.created_by_id??null,priority_key:priority,metadata_json:JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k])=>!['body','title'].includes(k))))}};
 }
 if(e.table==='wiki_pages'||e.table==='issue_comments'){
  const wiki=e.table==='wiki_pages';return{table:'content_documents',row:{id:e.id,kind:wiki?'wiki':'comment',scope_id:scope,project_id:e.projectId,workspace_id:e.workspaceId,parent_kind:wiki?null:'issue',parent_id:wiki?null:r.issue_id,title:text(r,'title',''),body:text(r,wiki?'content':'body'),revision:wiki?wikiRevision(r):1,created_at:time(r,'created_at'),updated_at:time(r,'updated_at'),before_body:null,before_title:null,slug:wiki?r.slug??null:null,wiki_parent_id:wiki?r.parent_id??null:null,metadata_json:JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k])=>!['content','body','title'].includes(k))))}};
 }
 return null;
}
