import {wikiCommandTools,wikiMCP,wikiQuery} from './wiki-surface.mjs';
export {wikiMCP as mcpWiki};
import {queryClaim,queryResolutionRecords,queryCapabilities,queryAttemptCheckpoint,queryIssueAlias} from './agent-workflow.mjs';
import { queryMyIssues } from './my-issues.mjs';
import { executeCommand, failure, operationGet, queryIssues, queryProjects, queryIssueEntries, queryContentRevisions, StorageFailure } from './shared-core.mjs';
// ActorContext is supplied by a trusted fixture authenticator, never request JSON.
const status={VALIDATION:400,SCHEMA_UNSUPPORTED:400,TITLE_EMPTY:400,BODY_TOO_LARGE:400,LINK_INTEGRATION_UNAVAILABLE:400,CONTENT_EMPTY:400,ASSIGNEE_INVALID:400,PARENT_INVALID:400,ENTITY_EXISTS:409,COMMENT_EXISTS:409,COMMENT_FORBIDDEN:403,PROJECT_NOT_FOUND:404,PRECONDITION_REQUIRED:428,UNAUTHENTICATED:401,EXPIRED:401,FORBIDDEN:403,NOT_FOUND:404,VERSION_CONFLICT:409,KEY_REUSE:409,EPOCH_MISMATCH:409,STORE_FENCED:503,WORKSPACE_MISMATCH:400,UNAVAILABLE:503,RESPONSE_LOST:503};
function invoke(db,actor,c,options){
 let result;
 try{result=executeCommand(db,actor,c,options);}catch(error){return {...failure('UNAVAILABLE','unknown'),attemptOutcome:error instanceof StorageFailure?error.outcome:'unknown'};}
 // Simulate a transport losing the complete response, never misreport as rollback.
 if(options?.dropResponse)return failure('RESPONSE_LOST','unknown');
 return result;
}
export function restUpdate(db,actor,{workspaceId,entityId,idempotencyKey,body},options){
 const result=workspaceId!==body?.workspaceId||entityId!==body?.entityId||idempotencyKey!==body?.operationId?failure('VALIDATION'):invoke(db,actor,body,options);
 return {status:result.error?(status[result.error.code]??500):200,body:result};
}
export const commandTools=Object.freeze({...wikiCommandTools,
 issue_update_title:'Issue.UpdateTitle',issue_create:'Issue.Create',issue_update_body:'Issue.UpdateBody',
 issue_assign:'Issue.Assign',issue_set_priority:'Issue.SetPriority',issue_add_comment:'Issue.AddComment',issue_edit_comment:'Issue.EditComment',issue_claim:'Issue.Claim',issue_renew_claim:'Issue.RenewClaim',issue_release_claim:'Issue.ReleaseClaim',issue_append_progress:'Issue.AppendProgress',issue_transition:'Issue.Transition',issue_reparent:'Issue.Reparent',issue_move_tree:'Issue.MoveTree'
});
export function mcpUpdate(db,actor,{name,arguments:args},options){
 const result=!Object.hasOwn(commandTools,name)||args?.commandType!==commandTools[name]?failure('VALIDATION'):invoke(db,actor,args,options);
 return {isError:Boolean(result.error),structuredContent:result};
}
function lookup(db,actor,args,now){try{return operationGet(db,actor,args,now);}catch{return failure('UNAVAILABLE','unknown');}}
export function restOperationGet(db,actor,args,now){const body=lookup(db,actor,args,now);return {status:body.error?(status[body.error.code]??500):200,body};}
export function mcpOperationGet(db,actor,args,now){const result=lookup(db,actor,args,now);return {isError:Boolean(result.error),structuredContent:result};}

// Thin query surfaces use the identical authorized SQL service.
export function restMyIssues(db,actor,args,now){let body;try{body=queryMyIssues(db,actor,args,now);}catch{body=failure('UNAVAILABLE');}return {status:body.error?(status[body.error.code]??400):200,body};}
export function mcpMyIssues(db,actor,{name,arguments:args},now){const result=name==='my_issues'?restMyIssues(db,actor,args,now).body:failure('VALIDATION');return {isError:Boolean(result.error),structuredContent:result};}

// Command aliases retain the original adapter shape while naming the expanded
// command set. MCP names are checked against the exact shared envelope type.
export const restCommand=restUpdate;
export const mcpCommand=mcpUpdate;
function read(query,db,actor,args,now){try{return query(db,actor,args,now);}catch{return failure('UNAVAILABLE','unknown');}}
function restRead(query,db,actor,args,now){const body=read(query,db,actor,args,now);return {status:body.error?(status[body.error.code]??400):200,body};}
function mcpRead(query,names,db,actor,{name,arguments:args},now){
 const requiresEntity=['issue_get','project_get','issue_entries_list','content_revision_get','content_revision_list'].includes(name);
 const listOnly=['issue_list','project_list'].includes(name);
 const allowed=['workspaceId','workspaceEpoch',...(requiresEntity?['entityId']:[]),...(name==='content_revision_get'?['revisionId']:[]),...(['issue_entries_list','content_revision_list'].includes(name)?['cursor','limit']:[])];
 const shape=args&&typeof args==='object'&&!Array.isArray(args)&&Object.keys(args).every(k=>allowed.includes(k))&&(!requiresEntity||args.entityId!==undefined)&&(!listOnly||args.entityId===undefined)&&(name!=='content_revision_get'||args.revisionId!==undefined);
 const result=names.includes(name)&&shape?read(query,db,actor,args,now):failure('VALIDATION');return {isError:Boolean(result.error),structuredContent:result};
}
export function restIssues(db,actor,args,now){return restRead(queryIssues,db,actor,args,now);}
export function mcpIssues(db,actor,request,now){return mcpRead(queryIssues,['issue_get','issue_list'],db,actor,request,now);}
export function restProjects(db,actor,args,now){return restRead(queryProjects,db,actor,args,now);}
export function mcpProjects(db,actor,request,now){return mcpRead(queryProjects,['project_get','project_list'],db,actor,request,now);}
export function restIssueEntries(db,actor,args,now){return restRead(queryIssueEntries,db,actor,args,now);}
export function mcpIssueEntries(db,actor,request,now){return mcpRead(queryIssueEntries,['issue_entries_list'],db,actor,request,now);}
export function restContentRevisions(db,actor,args,now){return restRead(queryContentRevisions,db,actor,args,now);}
export function mcpContentRevisions(db,actor,request,now){return mcpRead(queryContentRevisions,['content_revision_get','content_revision_list'],db,actor,request,now);}

export function restClaim(db,actor,args,now){return restRead(queryClaim,db,actor,args,now);}
export function restResolutions(db,actor,args,now){return restRead(queryResolutionRecords,db,actor,args,now);}
export function restCapabilities(db,actor,args,now){return restRead(queryCapabilities,db,actor,args,now);}
export function mcpWorkflowQuery(db,actor,{name,arguments:args},now){const q={claim_get:queryClaim,resolution_records_list:queryResolutionRecords,capabilities_get:queryCapabilities,attempt_checkpoint_get:queryAttemptCheckpoint,issue_alias_get:queryIssueAlias}[name];const result=q?read(q,db,actor,args,now):failure('VALIDATION');return {isError:Boolean(result.error),structuredContent:result};}

export function restWiki(db,actor,{name,arguments:args},now){const body=wikiQuery(db,actor,name,args,now);return {status:body.error?(status[body.error.code]??400):200,body};}
