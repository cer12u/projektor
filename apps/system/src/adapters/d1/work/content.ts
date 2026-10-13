// @module work
// @role private-d1
import {workTargetVisible,workParentVisible} from "./recovery-policy";
import {workPermissions,WORK_INPUT_LIMITS,validateContentRoute,validateContentPage,validateHistoryPage,validateOperationId} from "../../../modules/work/rules";
import type {ContentChangePlan} from "../../../modules/work/ports";
import type {ContentResource,ContentChange} from "../../../modules/work/public";
import { idPrefix } from "../../../modules/work/content-contracts";
import type {AuthDB} from "../primitives";
import type {Authenticated} from "../identity/authorization";
import {currentCredentialSql,principalProjectionSql} from "../identity/authorization";
import {readMutationReceipt,type MutationAdapter,type MutationTarget,type ReadPolicyFor} from "../persistence/transaction";
import {MutationError,type Json} from "../persistence/public";
import {sql,type Sql} from "../primitives";
import { permissionSql,requirePermission } from "../identity/authorization";
function parentVisible(project:string,r:ContentResource):Sql {
 if(r.kind==='wiki')return sql('1');
 return workParentVisible(sql('?',project),sql('?',r.parentKind),sql('?',r.parentId));
}
function match(alias:string,r:ContentResource):Sql {return r.kind==='wiki'?sql(`${alias}.kind='wiki'`):sql(`${alias}.kind='comment' AND ${alias}.parent_kind=? AND ${alias}.parent_id=?`,r.parentKind,r.parentId);}
export function contentJson(alias:string){return `json_object('id',${alias}.id,'kind',${alias}.kind,'projectId',${alias}.project_id,'workspaceId',${alias}.workspace_id,'scopeId',${alias}.scope_id,'metadata',json(${alias}.metadata_json),'parentKind',${alias}.parent_kind,'parentId',${alias}.parent_id,'title',${alias}.title,'body',${alias}.body,'references',json(${alias}.references_json),'revision',${alias}.revision,'revisionOrigin',CASE WHEN EXISTS(SELECT 1 FROM imported_entities e WHERE e.id=${alias}.id AND e.kind=CASE WHEN ${alias}.kind='wiki' THEN 'wiki_pages' ELSE 'issue_comments' END) THEN CASE WHEN ${alias}.kind='wiki' AND json_extract(${alias}.metadata_json,'$.version')>=1 THEN 'source-version' ELSE 'new-import-baseline' END ELSE 'native' END,'createdAt',${alias}.created_at,'updatedAt',${alias}.updated_at)`;}
function visible(t:MutationTarget,r:ContentResource,confirmed=true):Sql {
 return workTargetVisible(t.kind,sql('?',t.projectId),sql('?',t.targetId),r.kind==='comment'?sql('?',r.parentKind):sql('NULL'),r.kind==='comment'?sql('?',r.parentId):sql('NULL'),confirmed);
}
function snapshot(t:MutationTarget,r:ContentResource):Sql {const m=match('d',r);return sql(`SELECT ${contentJson('d')} FROM content_documents d WHERE d.id=? AND d.scope_id=? AND ${m.text}`,t.targetId,t.projectId,...m.values);}
export function contentPolicies(project:string,r:ContentResource):ReadPolicyFor {
 return kind=>kind===r.kind+'.create'||kind===r.kind+'.edit'?{authority:'project',permissions:workPermissions(kind,{}),visible:t=>t.projectId===project?visible(t,r):sql('0')}:undefined;
}
export async function prepareContent(auth:Authenticated,x:ContentChange,plan:ContentChangePlan){
 const project=x.projectId,r=x.resource,id=x.kind==='edit'?x.id:undefined,edit=x.kind==='edit',parsed=x.input as import("../../../modules/work/public").WikiEditInput;
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([auth.id,parsed.operationId])));
 const targetId=id??idPrefix(r)+[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
 const command={kind:r.kind+(edit?'.edit':'.create'),operationId:parsed.operationId,targetId,projectId:project,input:JSON.parse(JSON.stringify({...(Object.hasOwn(parsed,'body')?{body:parsed.body}:{}),...(Object.hasOwn(parsed,'title')?{title:parsed.title}:{}),...(Object.hasOwn(parsed,'references')?{references:parsed.references}:{}),...(edit?{revision:parsed.revision}:{}),...(r.kind==='comment'?{parentKind:r.parentKind,parentId:r.parentId}:{})})) as Json};
 const adapter:MutationAdapter={authority:'project',commandPolicy:{canonicalMaxBytes:WORK_INPUT_LIMITS[r.kind]},permissions:plan.permissions,visible:t=>visible(t,r,false),
  preconditions:c=>[{reason:edit?'revision_conflict':'content_exists',valid:edit?sql('EXISTS(SELECT 1 FROM content_documents WHERE id=? AND scope_id=? AND revision=?)',c.targetId,project,parsed.revision):sql('NOT EXISTS(SELECT 1 FROM content_documents WHERE id=?)',c.targetId)}],
  updates:c=>[{expectedChanges:1,statement:edit?sql("UPDATE content_documents SET before_body=body,before_title=title,before_references_json=references_json,title=COALESCE(?,title),body=COALESCE(?,body),references_json=COALESCE(?,references_json),revision=revision+1,updated_at=max(updated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=? AND scope_id=? AND revision=?",parsed.title??null,parsed.body??null,parsed.references?JSON.stringify(parsed.references):null,c.targetId,project,parsed.revision):sql("INSERT INTO content_documents(id,kind,scope_id,project_id,workspace_id,parent_kind,parent_id,body,title,references_json,revision,created_at,updated_at) VALUES(?,?,?,?,CASE WHEN ? LIKE 'workspace:%' THEN substr(?,11) ELSE (SELECT workspace_id FROM projects WHERE id=?) END,?,?,?,?,?,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))",c.targetId,r.kind,project,project.startsWith('workspace:')?null:project,project,project,project,r.kind==='comment'?r.parentKind:null,r.kind==='comment'?r.parentId:null,parsed.body!,parsed.title??'',JSON.stringify(parsed.references??[]))}],
  history:c=>[{expectedChanges:1,statement:sql(`INSERT INTO content_history(content_kind,content_id,scope_id,revision,operation_id,actor_id,actor_name,change_kind,before_body,after_body,created_at,before_title,after_title,before_references_json,after_references_json) SELECT d.kind,d.id,d.scope_id,d.revision,?,p.id,p.display_name,?,d.before_body,d.body,d.updated_at,d.before_title,d.title,d.before_references_json,d.references_json FROM content_documents d JOIN (${principalProjectionSql().text}) p ON p.id=? WHERE d.id=? AND d.scope_id=?`,c.operationId,c.kind,c.principalId,c.targetId,project)}],
  snapshot:t=>snapshot(t,r),current:t=>snapshot(t,r)};
 return {command,adapter,policyFor:contentPolicies(project,r)};
}
async function readAuthorized(db:AuthDB,auth:Authenticated,project:string,allowed:Sql,data:Sql):Promise<Json>{
 const credential=currentCredentialSql(auth),rights=permissionSql(auth,project,'view');
 const q=sql(`SELECT (${credential.text}) AS authenticated,(${rights.text}) AS permitted,(${allowed.text}) AS visible,CASE WHEN (${credential.text}) AND (${rights.text}) AND (${allowed.text}) THEN (${data.text}) ELSE NULL END AS data`,...credential.values,...rights.values,...allowed.values,...credential.values,...rights.values,...allowed.values,...data.values);
 const row=await db.prepare(q.text).bind(...q.values).first<{authenticated:number;permitted:number;visible:number;data:string|null}>();
 if(!row?.authenticated)throw new MutationError(401,'unauthenticated');if(!row.permitted)throw new MutationError(403,'forbidden');if(!row.visible||row.data===null)throw new MutationError(404,'not_found');return JSON.parse(row.data) as Json;
}
export function getContent(db:AuthDB,auth:Authenticated,project:string,r:ContentResource,id:string){validateContentRoute(project,r,id);const t={kind:r.kind+'.edit',targetId:id,projectId:project};return readAuthorized(db,auth,project,visible(t,r),snapshot(t,r));}

export function listContent(db:AuthDB,auth:Authenticated,project:string,r:ContentResource,page:number,pageSize:number){
 validateContentRoute(project,r);validateContentPage(page,pageSize);const m=match('d',r),where=`d.scope_id=? AND ${m.text}`,values=[project,...m.values];
 const data=sql(`SELECT json_object('documents',json((SELECT json_group_array(json(entry)) FROM(SELECT ${contentJson('d')} AS entry FROM content_documents d WHERE ${where} ORDER BY created_at,id LIMIT ? OFFSET ?))),'total',(SELECT count(*) FROM content_documents d WHERE ${where}),'page',?,'pageSize',?)`,...values,pageSize,(page-1)*pageSize,...values,page,pageSize);
 return readAuthorized(db,auth,project,parentVisible(project,r),data);
}
export function contentHistory(db:AuthDB,auth:Authenticated,project:string,r:ContentResource,id:string,after:number,limit:number){
 validateContentRoute(project,r,id);validateHistoryPage(after,limit);
 const data=sql(`WITH h AS(SELECT revision,json_object('revision',revision,'operationId',operation_id,'actorName',actor_name,'kind',change_kind,'beforeBody',before_body,'afterBody',after_body,'beforeTitle',before_title,'afterTitle',after_title,'beforeReferences',json(before_references_json),'afterReferences',json(after_references_json),'createdAt',created_at) AS entry FROM content_history WHERE content_kind=? AND content_id=? AND scope_id=? AND revision>? ORDER BY revision LIMIT ?) SELECT json_object('history',json((SELECT json_group_array(json(entry)) FROM h)),'nextAfterRevision',CASE WHEN EXISTS(SELECT 1 FROM content_history WHERE content_kind=? AND content_id=? AND scope_id=? AND revision>COALESCE((SELECT max(revision) FROM h),?)) THEN (SELECT max(revision) FROM h) ELSE NULL END,'resolutionEvents',json('[]'),'nextResolutionAfterRevision',NULL)`,r.kind,id,project,after,limit,r.kind,id,project,after);
 return readAuthorized(db,auth,project,visible({kind:r.kind+'.edit',targetId:id,projectId:project},r),data);
}
export async function contentResult(db:AuthDB,auth:Authenticated,project:string,r:ContentResource,op:string){validateContentRoute(project,r);validateOperationId(op);try{return await readMutationReceipt(db,auth,op,contentPolicies(project,r));}catch(e){if(e instanceof MutationError&&e.status===404)await requirePermission(db,auth,project,'view');throw e;}}
