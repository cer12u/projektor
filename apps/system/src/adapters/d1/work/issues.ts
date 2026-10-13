// @module work
// @role private-d1
import {workTargetVisible} from "./recovery-policy";
import {workPermissions,WORK_KINDS,WORK_INPUT_LIMITS,validateIssueRoute,validateHistoryPage,validateOperationId} from "../../../modules/work/rules";
import type {IssueChange,IssueView} from "../../../modules/work/public";
import type {IssueChangePlan,IssueChangeState} from "../../../modules/work/ports";
import type {Permission} from "../../../modules/identity/dto";
import type {PlannedIssue} from "../../../modules/work/planning-contracts";
import { digest } from "../../crypto/sha256";
import type {AuthDB} from "../primitives";
import type {Authenticated} from "../identity/authorization";
import {currentCredentialSql,currentPermissionsSql,principalProjectionSql,activeViewMembersSql} from "../identity/authorization";
import {readMutationReceipt,type MutationAdapter,type MutationCommand,type MutationReceipt,type MutationTarget,type ReadPolicyFor} from "../persistence/transaction";
import {MutationError,type Json} from "../persistence/public";
import {sql,type Sql} from "../primitives";
import { requirePermission } from "../identity/authorization";

export type Issue=PlannedIssue;
export function issueJson(alias:string):string {
 const c=(column:string)=>alias+'.'+column;
 return `json_object('id',${c('id')},'projectId',${c('project_id')},'workspaceId',${c('workspace_id')},'number',${c('number')},'parentId',${c('parent_id')},'typeId',${c('type_id')},'statusId',${c('status_id')},'createdById',${c('created_by_id')},'priorityKey',${c('priority_key')},'metadata',json(${c('metadata_json')}),'title',${c('title')},'body',${c('body')},'references',json(${c('references_json')}),'revision',${c('revision')},'revisionOrigin',CASE WHEN EXISTS(SELECT 1 FROM imported_entities e WHERE e.kind='issues' AND e.id=${c('id')}) THEN 'new-import-baseline' ELSE 'native' END,'createdAt',${c('created_at')},'updatedAt',${c('updated_at')},'priority',${c('priority')},'assigneeId',${c('assignee_id')},'assignee',json((SELECT json_object('id',p.id,'kind',p.kind,'displayName',p.display_name,'active',json(CASE WHEN p.active=1 THEN 'true' ELSE 'false' END)) FROM (${principalProjectionSql().text}) p WHERE p.id=${c('assignee_id')})),'state',${c('state')},'resolvedAt',${c('resolved_at')},'resolution',json(${c('resolution_json')}),'schedule',json(${c('schedule_json')}))`;
}
const targetVisible=(t:MutationTarget)=>workTargetVisible(t.kind,sql('?',t.projectId),sql('?',t.targetId),sql('NULL'),sql('NULL'),true);
function snapshot(t:MutationTarget):Sql {
  return sql(`SELECT ${issueJson('i')} FROM issues i WHERE id=? AND project_id=?`,t.targetId,t.projectId);
}
export function issuePolicies(projectId:string):ReadPolicyFor {
  return kind=>(WORK_KINDS.issue as readonly string[]).includes(kind)?{authority:'project',
    visible:t=>t.projectId===projectId?targetVisible(t):sql('0')}:undefined;
}
/** Encoding only: the application has normalized the command and selected a Work plan. */
export async function issueMutationCommand(auth:Authenticated,x:IssueChange):Promise<MutationCommand>{
 const {operationId,...input}=x.input;
 return {kind:'issue.'+x.kind,operationId,targetId:x.kind==='edit'?x.issueId:`I_${await digest(JSON.stringify([auth.id,operationId]))}`,projectId:x.projectId,input:input as unknown as Json};
}
export async function prepareIssue(auth:Authenticated,x:IssueChange,plan:IssueChangePlan) {
 const command=await issueMutationCommand(auth,x),projectId=x.projectId,edit=x.kind==='edit',parsed=x.input as typeof x.input&Partial<import("../../../modules/work/public").IssueEditInput>,revision=edit?x.input.revision:undefined,targetId=command.targetId,fields=plan.fields;
 const permissions=plan.permissions;
 const assignments:string[]=[`before_body=body`,`before_meta_json=${issueJson('issues')}`,`revision=revision+1`,`updated_at=max(updated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`],values:(string|number|null)[]=[];
 if(fields.includes('references')){assignments.push('references_json=?');values.push(JSON.stringify(parsed.references));}
 if(fields.includes('body')){assignments.push('body=?');values.push(parsed.body!);}if(fields.includes('title')){assignments.push('title=?');values.push(parsed.title!);}if(fields.includes('priority')){assignments.push('priority=?','priority_key=?');values.push(parsed.priority!,plan.priorityKey!);}for(const k of['parentId','typeId']as const)if(fields.includes(k)){assignments.push((k==='parentId'?'parent_id':'type_id')+'=?');values.push(parsed[k]!);}if(fields.includes('assigneeId')){assignments.push('assignee_id=?');values.push(parsed.assigneeId!);}if(fields.includes('schedule')){assignments.push('schedule_json=?');values.push(JSON.stringify(parsed.schedule));}
 if(plan.transition){
  const t=plan.transition;
  if(t.status.kind==='replace'){assignments.push('status_id=?');values.push(t.status.id);}
  if(t.resolution==='stamp')assignments.push("resolved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')","resolution_json=json_object('kind','instant','at',strftime('%Y-%m-%dT%H:%M:%fZ','now'))");
  if(t.resolution==='clear')assignments.push('resolved_at=NULL','resolution_json=NULL');
  assignments.push('state=?');values.push(t.nextState);
 }
 const assignmentCandidates=activeViewMembersSql(sql('?',projectId));
 const adapter:MutationAdapter={authority:'project',commandPolicy:{canonicalMaxBytes:WORK_INPUT_LIMITS.issue,certifyPreDispatchDenial:!edit},permissions,visible:t=>workTargetVisible(t.kind,sql('?',t.projectId),sql('?',t.targetId),sql('NULL'),sql('NULL'),false),
 preconditions:c=>[
  {reason:edit?'revision_conflict':'issue_exists',valid:edit?sql('EXISTS(SELECT 1 FROM issues WHERE id=? AND project_id=? AND revision=?)',c.targetId,c.projectId,revision!):sql('NOT EXISTS(SELECT 1 FROM issues WHERE id=?)',c.targetId)},
  ...(plan.transition?[{reason:'issue_state_changed',valid:sql('EXISTS(SELECT 1 FROM issues WHERE id=? AND project_id=? AND revision=? AND state=? AND (metadata_json IS NOT NULL)=?)',targetId,projectId,plan.transition.expectedRevision,plan.transition.expectedState,plan.transition.expectedImported?1:0)},
   ...(plan.transition.status.kind==='replace'?[{reason:'status_definition_unavailable',valid:sql("(SELECT count(*) FROM imported_entities WHERE kind='task_statuses' AND scope_id=(SELECT 'workspace:'||workspace_id FROM projects WHERE id=?) AND json_extract(record,'$.key')=?)=1 AND EXISTS(SELECT 1 FROM imported_entities WHERE kind='task_statuses' AND scope_id=(SELECT 'workspace:'||workspace_id FROM projects WHERE id=?) AND id=? AND json_extract(record,'$.key')=?)",projectId,plan.transition.status.key,projectId,plan.transition.status.id,plan.transition.status.key)}]:[])]:[]),
  ...plan.related.map(requirement=>{
   switch(requirement.kind){
    case 'workspace_type':return {reason:'type_unavailable',valid:sql("EXISTS(SELECT 1 FROM imported_entities WHERE kind='task_types' AND id=? AND scope_id=(SELECT 'workspace:'||workspace_id FROM projects WHERE id=?))",requirement.id,projectId)};
    case 'acyclic_parent':return {reason:'parent_unavailable',valid:sql("EXISTS(SELECT 1 FROM issues WHERE id=? AND project_id=?) AND NOT EXISTS(WITH RECURSIVE ancestors(id,parent_id) AS(SELECT id,parent_id FROM issues WHERE id=? UNION SELECT i.id,i.parent_id FROM issues i JOIN ancestors a ON i.id=a.parent_id) SELECT 1 FROM ancestors WHERE id=?)",requirement.id,projectId,requirement.id,targetId)};
    case 'eligible_assignee':return {reason:'assignee_unavailable',valid:sql(`EXISTS(SELECT 1 FROM (${assignmentCandidates.text}) p WHERE p.id=?)`,...assignmentCandidates.values,requirement.id)};
   }
  })],
 updates:c=>[{expectedChanges:1,statement:edit?sql(`UPDATE issues SET ${assignments.join(',')} WHERE id=? AND project_id=? AND revision=?`,...values,c.targetId,c.projectId,revision!):sql("INSERT INTO issues(id,project_id,body,title,references_json,created_by_id,workspace_id,number,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,(SELECT workspace_id FROM projects WHERE id=?),(SELECT COALESCE(max(number),0)+1 FROM issues WHERE project_id=?),1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))",c.targetId,c.projectId,parsed.body!,parsed.title??'',JSON.stringify(parsed.references??[]),c.principalId,c.projectId,c.projectId)}],
 history:c=>[{expectedChanges:1,statement:sql(`INSERT INTO issue_history(issue_id,project_id,revision,operation_id,actor_id,actor_name,change_kind,before_body,after_body,created_at,before_snapshot,after_snapshot,changed_fields)
 SELECT i.id,i.project_id,i.revision,?,p.id,p.display_name,?,i.before_body,i.body,i.updated_at,i.before_meta_json,${issueJson('i')},? FROM issues i JOIN (${principalProjectionSql().text}) p ON p.id=? WHERE i.id=? AND i.project_id=?
 AND (? IS NULL OR EXISTS(SELECT 1 FROM issue_resolution_events e WHERE e.issue_id=i.id AND e.revision=i.revision AND e.event_kind=?))`,c.operationId,c.kind,JSON.stringify(fields),c.principalId,c.targetId,c.projectId,plan.transition?.resolutionEvent??null,plan.transition?.resolutionEvent??null)}],snapshot,current:snapshot};
 return {command,adapter,policyFor:issuePolicies(projectId)};
}
async function readAuthorized(db:AuthDB,auth:Authenticated,target:MutationTarget,data:Sql,permissions:readonly Permission[]=['view']):Promise<Json> {
  // Current credentials, permission and target visibility are checked in this data SELECT.
  const credential=currentCredentialSql(auth),rights=currentPermissionsSql(auth,target.projectId,['view',...permissions]),visible=targetVisible(target);
  const q=sql(`SELECT (${credential.text}) AS authenticated,(${rights.text}) AS permitted,(${visible.text}) AS visible,
    CASE WHEN (${credential.text}) AND (${rights.text}) AND (${visible.text}) THEN (${data.text}) ELSE NULL END AS data`,
    ...credential.values,...rights.values,...visible.values,...credential.values,...rights.values,...visible.values,...data.values);
  const row=await db.prepare(q.text).bind(...q.values).first<{authenticated:number;permitted:number;visible:number;data:string|null}>();
  if(!row?.authenticated)throw new MutationError(401,'unauthenticated');
  if(!row.permitted)throw new MutationError(403,'forbidden');
  if(!row.visible||row.data===null)throw new MutationError(404,'not_found');
  return JSON.parse(row.data) as Json;
}
/** The snapshot and referenced status definitions are disclosed in one current-authorized SELECT. */
export async function readIssuePlanningState(db:AuthDB,auth:Authenticated,command:Extract<IssueChange,{kind:'edit'}>):Promise<IssueChangeState>{
 const target={kind:'issue.edit',targetId:command.issueId,projectId:command.projectId};
 const data=sql(`SELECT json_object('current',${issueJson('i')},'statusDefinitions',json((SELECT json_group_array(json_object('id',e.id,'key',json_extract(e.record,'$.key'))) FROM imported_entities e WHERE e.kind='task_statuses' AND e.scope_id=(SELECT 'workspace:'||workspace_id FROM projects WHERE id=i.project_id)))) FROM issues i WHERE i.id=? AND i.project_id=?`,command.issueId,command.projectId);
 return await readAuthorized(db,auth,target,data,workPermissions('issue.edit',command.input)) as unknown as IssueChangeState;
}
export async function readIssueChangeCurrent(db:AuthDB,auth:Authenticated,command:Extract<IssueChange,{kind:'edit'}>):Promise<IssueView>{
 const target={kind:'issue.edit',targetId:command.issueId,projectId:command.projectId};
 return await readAuthorized(db,auth,target,snapshot(target),workPermissions('issue.edit',command.input)) as unknown as IssueView;
}
export async function getIssue(db:AuthDB,auth:Authenticated,projectId:string,issueId:string):Promise<Json> {
  validateIssueRoute(projectId,issueId);const target={kind:'issue.edit',targetId:issueId,projectId};
  return readAuthorized(db,auth,target,snapshot(target));
}
export async function getIssueHistory(db:AuthDB,auth:Authenticated,projectId:string,issueId:string,afterRevision:number,limit:number):Promise<Json> {
  validateIssueRoute(projectId,issueId);
  validateHistoryPage(afterRevision,limit);
  const data=sql(`WITH h AS(SELECT revision,json_object('issueId',issue_id,'projectId',project_id,'revision',revision,'operationId',operation_id,'actorId',actor_id,'actorName',actor_name,'kind',change_kind,'beforeBody',before_body,'afterBody',after_body,'beforeTitle',json_extract(before_snapshot,'$.title'),'afterTitle',json_extract(after_snapshot,'$.title'),'beforeReferences',json_extract(before_snapshot,'$.references'),'afterReferences',json_extract(after_snapshot,'$.references'),'createdAt',created_at,'changedFields',json(changed_fields),'before',json(before_snapshot),'after',json(after_snapshot)) AS entry FROM issue_history WHERE issue_id=? AND project_id=? AND revision>? ORDER BY revision LIMIT ?),
    e AS(SELECT revision,json_object('revision',revision,'kind',event_kind,'time',json(time_json),'recordedAt',recorded_at) AS entry FROM issue_resolution_events WHERE issue_id=? AND revision>? ORDER BY revision LIMIT ?)
    SELECT json_object('history',json((SELECT json_group_array(json(entry)) FROM h)),'resolutionEvents',json((SELECT json_group_array(json(entry)) FROM e)),
    'nextAfterRevision',CASE WHEN EXISTS(SELECT 1 FROM issue_history WHERE issue_id=? AND project_id=? AND revision>COALESCE((SELECT max(revision) FROM h),?)) THEN (SELECT max(revision) FROM h) ELSE NULL END,
    'nextResolutionAfterRevision',CASE WHEN EXISTS(SELECT 1 FROM issue_resolution_events WHERE issue_id=? AND revision>COALESCE((SELECT max(revision) FROM e),?)) THEN (SELECT max(revision) FROM e) ELSE NULL END)`,
    issueId,projectId,afterRevision,limit,issueId,afterRevision,limit,issueId,projectId,afterRevision,issueId,afterRevision);
  return readAuthorized(db,auth,{kind:'issue.edit',targetId:issueId,projectId},data);
}
export async function readIssueResult(db:AuthDB,auth:Authenticated,projectId:string,operationId:string):Promise<MutationReceipt> {
  validateIssueRoute(projectId);
  validateOperationId(operationId);
  try{return await readMutationReceipt(db,auth,operationId,issuePolicies(projectId));}
  catch(error){if(error instanceof MutationError&&error.status===404)await requirePermission(db,auth,projectId,'view');throw error;}
}
