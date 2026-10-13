// @module work
// @role private-d1
import type {AuthDB} from "../primitives";
import type {Authenticated} from "../identity/authorization";
import type {LegacyReference} from "../../../modules/work/public";
import {validateImportedSource} from "../../../modules/work/rules";
import { ApiError } from "../../protocol-errors";
import {currentCredentialSql,principalProjectionSql,currentViewScopesSql} from "../identity/authorization";
import {sql,type Sql} from "../primitives";
import { permissionSql } from "../identity/authorization";
async function authorized(db:AuthDB,auth:Authenticated,scope:string,data:Sql){
 const credential=currentCredentialSql(auth),rights=permissionSql(auth,scope,'view');
 const q=sql(`SELECT (${credential.text}) authenticated,(${rights.text}) permitted,CASE WHEN (${credential.text}) AND (${rights.text}) THEN (${data.text}) END data`,...credential.values,...rights.values,...credential.values,...rights.values,...data.values);
 const row=await db.prepare(q.text).bind(...q.values).first<{authenticated:number;permitted:number;data:string|null}>();
 if(!row?.authenticated)throw new ApiError(401,'unauthenticated');if(!row.permitted)throw new ApiError(403,'forbidden');if(row.data===null)throw new ApiError(404,'not_found');return JSON.parse(row.data) as unknown;
}
/** Request-independent reads shared by REST and the closure-bound MCP adapter. */
export async function readImportedSource(db:AuthDB,auth:Authenticated,scope:string,kind:'issues'|'wiki_pages'|'issue_comments'|'projects',id:string,page=1):Promise<unknown>{
 validateImportedSource({scopeId:scope,kind,id,page});
  const data=sql(`SELECT json_object('record',json(e.record),'history',json((SELECT json_group_array(json(entry)) FROM(SELECT json_object('sourceTable',h.kind,'sourceId',h.id,'actorName',p.display_name,'record',json(h.record)) entry FROM imported_entities h LEFT JOIN (${principalProjectionSql().text}) p ON p.id=COALESCE(json_extract(h.record,'$.actor_id'),json_extract(h.record,'$.author_id')) WHERE h.scope_id=e.scope_id AND ((h.kind='activity' AND json_extract(h.record,'$.entity_id')=e.id) OR (h.kind='wiki_revisions' AND json_extract(h.record,'$.page_id')=e.id) OR (h.kind IN('issue_resolution_events','issue_gate_rejections') AND json_extract(h.record,'$.issue_id')=e.id)) ORDER BY COALESCE(json_extract(h.record,'$.created_at'),json_extract(h.record,'$.occurred_at')),h.kind,h.id LIMIT 10 OFFSET ?))),'page',?,'historyTotal',(SELECT count(*) FROM imported_entities h WHERE h.scope_id=e.scope_id AND ((h.kind='activity' AND json_extract(h.record,'$.entity_id')=e.id) OR (h.kind='wiki_revisions' AND json_extract(h.record,'$.page_id')=e.id) OR (h.kind IN('issue_resolution_events','issue_gate_rejections') AND json_extract(h.record,'$.issue_id')=e.id)))) FROM imported_entities e WHERE kind=? AND id=? AND scope_id=? AND (e.kind<>'issues' OR EXISTS(SELECT 1 FROM issues current_issue WHERE current_issue.id=e.id AND current_issue.project_id=e.scope_id AND current_issue.workspace_id=e.workspace_id))`,(page-1)*10,page,kind,id,scope);
  return authorized(db,auth,scope,data);
}

export async function readDirectory(db:AuthDB,auth:Authenticated):Promise<unknown>{
 const credential=currentCredentialSql(auth),allowed=currentViewScopesSql(auth);
  // Project access exposes workspace-shared definitions, never another project's private definitions.
  const q=sql(`WITH allowed AS (${allowed.text}) SELECT json_object('projects',json((SELECT json_group_array(json_object('id',id,'workspaceId',workspace_id,'key',key,'slug',slug,'name',name,'description',description)) FROM projects WHERE id IN(SELECT scope FROM allowed))),'workspaces',json((SELECT json_group_array(json_object('id',id,'scopeId','workspace:'||id,'name',name)) FROM workspaces WHERE 'workspace:'||id IN(SELECT scope FROM allowed))),'definitions',json((SELECT json_group_array(json_object('sourceTable',kind,'scopeId',scope_id,'record',json(record))) FROM imported_entities WHERE ((kind IN('task_statuses','task_types','custom_field_definitions') AND (scope_id IN(SELECT scope FROM allowed) OR (scope_id='workspace:'||workspace_id AND workspace_id IN(SELECT workspace_id FROM projects WHERE id IN(SELECT scope FROM allowed))))) OR (kind IN('user_groups','user_group_members','group_project_grants','workspace_members') AND scope_id IN(SELECT scope FROM allowed)))))) data`,...allowed.values);
  const guarded=sql(`SELECT (${credential.text}) authenticated,CASE WHEN (${credential.text}) THEN (${q.text}) END data`,...credential.values,...credential.values,...q.values);
  const row=await db.prepare(guarded.text).bind(...guarded.values).first<{authenticated:number;data:string|null}>();
  if(!row?.authenticated||row.data===null)throw new ApiError(401,'unauthenticated');
  return JSON.parse(row.data) as unknown;
}

export async function resolveLegacyUrl(db:AuthDB,auth:Authenticated,reference:LegacyReference):Promise<unknown>{
 const candidate=reference.kind==='issue-number'?sql("SELECT i.id,i.project_id scope,'issue' content FROM issues i JOIN projects p ON p.id=i.project_id WHERE p.key=? AND i.number=?",reference.projectKey,reference.number):reference.kind==='project-slug'?sql("SELECT id,id scope,'project' content FROM projects WHERE slug=?",reference.slug):sql("SELECT id,scope_id scope,'wiki' content FROM content_documents WHERE kind='wiki' AND slug=?",reference.slug);
 const credential=currentCredentialSql(auth),scopes=currentViewScopesSql(auth);
 // Resolve and count only currently authorized candidates in one guarded statement.
 // An inaccessible legacy URL does not disclose existence or ambiguity.
 const q=sql(`WITH candidates AS (${candidate.text}),allowed AS (${scopes.text}) SELECT (${credential.text}) authenticated,CASE WHEN (${credential.text}) THEN (SELECT json_group_array(json_object('id',id,'scope',scope,'content',content)) FROM (SELECT * FROM candidates WHERE scope IN(SELECT scope FROM allowed) LIMIT 2)) ELSE NULL END data`,...candidate.values,...scopes.values,...credential.values,...credential.values);
 const row=await db.prepare(q.text).bind(...q.values).first<{authenticated:number;data:string|null}>();
 if(!row?.authenticated||row.data===null)throw new ApiError(401,'unauthenticated');
 const rows=JSON.parse(row.data) as {id:string;scope:string;content:'issue'|'wiki'|'project'}[];
 if(rows.length!==1)throw new ApiError(rows.length?409:404,rows.length?'ambiguous_legacy_url':'not_found');
 const target=rows[0],query=new URLSearchParams({project:target.scope,content:target.content==='project'?'issue':target.content});if(target.content!=='project')query.set(target.content,target.id);
 return {url:'/?'+query.toString(),id:target.id,scopeId:target.scope,content:target.content};
}
