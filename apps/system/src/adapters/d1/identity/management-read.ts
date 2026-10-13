// @module identity
// @role private-read
/** Read-only UI projection. Every disclosure is selected behind current authentication and authority. */
import type { AuthDB,Authenticated } from './db';
import { managementSnapshot } from './management';
import {currentCredentialSql,currentPermissionsSql} from "./authorization";
import {MutationError,type Json} from "../persistence/public";
import {sql,type Sql} from "../primitives";
import { PERMISSIONS } from './permissions';
export type ManagementRecordKind='principal'|'membership'|'credential'|'scope';
const kinds:Record<ManagementRecordKind,string>={principal:'management.principal.update',membership:'management.membership.set',credential:'management.credential.revoke',scope:'management.credential.scope'};
const fields:Record<ManagementRecordKind,string[]>={
 principal:['principalId','kind','displayName','active','authVersion','globalAdministrator','revision'],
 membership:['principalId','projectId','revision','permissions'],
 credential:['credentialId','principalId','expiresAt','revokedAt','revision'],
 scope:['credentialId','principalId','expiresAt','revokedAt','revision','projectId','permissions'],
};
import {managementIdentifier} from "../../../modules/identity/rules";
export {managementRecordKind,managementIdentifier,managementProject} from "../../../modules/identity/rules";
/** Never forward arbitrary stored JSON, including historical payloads, to HTTP. */
function publicSnapshot(kind:ManagementRecordKind,raw:string|null):Json{
 if(raw===null)return null;
 const parsed:unknown=JSON.parse(raw);if(parsed===null)return null;
 if(typeof parsed!=='object'||Array.isArray(parsed))throw new MutationError(503,'management_unavailable');
 const input=parsed as Record<string,Json>,out:Record<string,Json>={};
 for(const key of fields[kind]){
  const value=input[key];
  if(value===undefined)continue;
  if(key==='permissions'){
   if(!Array.isArray(value)||value.some(v=>typeof v!=='string'||!['view','edit','assign','transition','execute','manage'].includes(v)))throw new MutationError(503,'management_unavailable');
   out[key]=value;
  }else if(value===null||typeof value==='string'||typeof value==='number'||typeof value==='boolean')out[key]=value;
  else throw new MutationError(503,'management_unavailable');
 }
 return out;
}
/** Registration audit extension, disclosed only by the global principal-history route. */
function initialProjects(raw:string):{projectId:string;permissions:string[]}[]{
 const value=(JSON.parse(raw) as {initialProjects?:unknown}).initialProjects;
 if(!Array.isArray(value)||value.length>64)throw new MutationError(503,'management_unavailable');
 return value.map((entry:unknown)=>{
  if(!entry||typeof entry!=='object'||Array.isArray(entry))throw new MutationError(503,'management_unavailable');
  const p=entry as {projectId?:unknown;permissions?:unknown};
  if(typeof p.projectId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(p.projectId)||!Array.isArray(p.permissions)||p.permissions.length>6||p.permissions.some(v=>typeof v!=='string'||!PERMISSIONS.some(permission=>permission===v)))throw new MutationError(503,'management_unavailable');
  return{projectId:p.projectId,permissions:p.permissions as string[]};
 });
}
function authority(auth:Authenticated,kind:ManagementRecordKind,projectId:string):Sql{
 return kind==='principal'||kind==='credential'?sql('EXISTS(SELECT 1 FROM principal_management WHERE principal_id=? AND global_administrator=1)',auth.id):currentPermissionsSql(auth,projectId,['view','manage']);
}
function records(kind:ManagementRecordKind,projectId:string):{from:string;id:string;where:Sql}{
 if(kind==='principal')return{from:'principals p JOIN principal_management r ON r.principal_id=p.id',id:'p.id',where:sql('1')};
 if(kind==='credential')return{from:'api_credentials c JOIN credential_management r ON r.credential_id=c.id',id:'c.id',where:sql('1')};
 if(kind==='membership')return{from:'principal_project_records r',id:'r.principal_id',where:sql('r.project_id=?',projectId)};
 return{from:'credential_project_records r',id:'r.credential_id',where:sql('r.project_id=?',projectId)};
}
function cursor(raw:string|null):string{if(raw===null||raw==='')return '';return managementIdentifier(raw);}
async function selected(db:AuthDB,auth:Authenticated,rights:Sql,body:Sql):Promise<string>{
 const credential=currentCredentialSql(auth),q=sql(`SELECT (${credential.text}) AS authenticated,(${rights.text}) AS permitted,
 CASE WHEN (${credential.text}) AND (${rights.text}) THEN (${body.text}) ELSE NULL END AS body`,
 ...credential.values,...rights.values,...credential.values,...rights.values,...body.values);
 const row=await db.prepare(q.text).bind(...q.values).first<{authenticated:number;permitted:number;body:string|null}>();
 if(!row?.authenticated)throw new MutationError(401,'unauthenticated');if(!row.permitted)throw new MutationError(403,'forbidden');
 if(row.body===null)throw new MutationError(403,'forbidden');return row.body;
}
export async function managementContext(db:AuthDB,auth:Authenticated){
 // One database snapshot. This is informational; mutations still recheck their own batch.
 const checks=PERMISSIONS.map(permission=>({permission,valid:currentPermissionsSql(auth,sql('context_project.project_id'),[permission])}));
 const permissions=sql(`SELECT wanted.value AS permission FROM json_each(?) wanted WHERE CASE wanted.value ${checks.map(c=>`WHEN '${c.permission}' THEN (${c.valid.text})`).join(' ')} ELSE 0 END`,JSON.stringify(PERMISSIONS),...checks.flatMap(c=>c.valid.values));
 const view=currentPermissionsSql(auth,sql('context_project.project_id'),['view']);
 const body=sql(`SELECT json_object('globalAdministrator',EXISTS(SELECT 1 FROM principal_management WHERE principal_id=? AND global_administrator=1),
 'projects',json((SELECT COALESCE(json_group_array(json_object('id',project_id,'permissions',json((SELECT json_group_array(permission) FROM (${permissions.text}))))),'[]')
 FROM (SELECT DISTINCT project_id FROM memberships WHERE principal_id=? ORDER BY project_id) context_project WHERE (${view.text}))))`,auth.id,...permissions.values,auth.id,...view.values);
 const data=JSON.parse(await selected(db,auth,sql('1'),body)) as {globalAdministrator:number;projects:{id:string;permissions:string[]}[]};
 return{...data,globalAdministrator:data.globalAdministrator===1};
}
export async function listManagementRecords(db:AuthDB,auth:Authenticated,kind:ManagementRecordKind,projectId:string,after:string|null){
 const r=records(kind,projectId),last=cursor(after);
 const body=sql(`SELECT COALESCE(json_group_array(id),'[]') FROM(SELECT ${r.id} AS id FROM ${r.from} WHERE (${r.where.text}) AND ${r.id}>? ORDER BY ${r.id} LIMIT 51)`,...r.where.values,last);
 // Page IDs are still private data and must be guarded. Snapshot reads recheck authority too.
 const ids=JSON.parse(await selected(db,auth,authority(auth,kind,projectId),body)) as string[];
 const page=ids.slice(0,50),out:Json[]=[];
 for(const id of page)out.push(await readManagementRecord(db,auth,kind,projectId,id));
 return{records:out,nextAfter:ids.length>50?page.at(-1)!:null};
}
export async function readManagementRecord(db:AuthDB,auth:Authenticated,kind:ManagementRecordKind,projectId:string,targetId:string):Promise<Json>{
 managementIdentifier(targetId);
 const r=records(kind,projectId),rights=authority(auth,kind,projectId),relation=sql(`EXISTS(SELECT 1 FROM ${r.from} WHERE (${r.where.text}) AND ${r.id}=?)`,...r.where.values,targetId);
 const raw=await selected(db,auth,sql(`(${rights.text}) AND (${relation.text})`,...rights.values,...relation.values),managementSnapshot({kind:kinds[kind],projectId,targetId}));
 return publicSnapshot(kind,raw);
}
export async function readManagementHistory(db:AuthDB,auth:Authenticated,kind:ManagementRecordKind,projectId:string,targetId:string,after:string|null){
 managementIdentifier(targetId);
 if(after!==null&&after!==''&&(!/^[1-9][0-9]{0,14}$/.test(after)||!Number.isSafeInteger(Number(after))))throw new MutationError(400,'invalid_management_cursor');
 const r=records(kind,projectId),rights=authority(auth,kind,projectId),relation=sql(`EXISTS(SELECT 1 FROM ${r.from} WHERE (${r.where.text}) AND ${r.id}=?)`,...r.where.values,targetId);
 const allowed=sql(`(${rights.text}) AND (${relation.text})`,...rights.values,...relation.values);
 const body=sql(`SELECT COALESCE(json_group_array(json(item)),'[]') FROM(SELECT json_object('cursor',a.rowid,'actorId',actor_id,'actorName',actor_display_name,'operationId',operation_id,
 'kind',operation_kind,'beforeRevision',before_revision,'afterRevision',after_revision,'before',before_snapshot,'after',after_snapshot,'recordedAt',recorded_at) AS item
 FROM management_audit a WHERE target_id=? AND project_id=? AND (operation_kind=? OR operation_kind=?) AND a.rowid>? ORDER BY a.rowid LIMIT 51)`,
 targetId,projectId,kinds[kind],kind==='principal'?'management.principal.create':kinds[kind],Number(after||0));
 const rows=JSON.parse(await selected(db,auth,allowed,body)) as {cursor:number;actorId:string;actorName:string;operationId:string;kind:string;beforeRevision:number;afterRevision:number;before:string;after:string;recordedAt:number}[];
 const page=rows.slice(0,50);
 return{history:page.map(row=>({actorId:row.actorId,actorName:row.actorName,operationId:row.operationId,kind:row.kind,beforeRevision:row.beforeRevision,afterRevision:row.afterRevision,before:publicSnapshot(kind,row.before),after:publicSnapshot(kind,row.after),recordedAt:row.recordedAt,...(kind==='principal'&&row.kind==='management.principal.create'?{initialProjects:initialProjects(row.after)}:{})})),nextAfter:rows.length>50?String(page.at(-1)!.cursor):null};
}
