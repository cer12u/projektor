import {WIKI_CURSOR_MAX_LENGTH} from '../src/wiki.mjs';
// One dispatcher over the established command/query services. No alternate SQL,
// actor arguments, operation IDs, retries, permission rules or receipt journal.
import {commandTools} from '../src/adapters.mjs';
import {executeCommand,validate,failure,operationGet,queryIssues,queryProjects,queryIssueEntries,queryContentRevisions} from '../src/shared-core.mjs';
import {queryMyIssues} from '../src/my-issues.mjs';
import {queryClaim,queryResolutionRecords,queryCapabilities,queryAttemptCheckpoint,queryIssueAlias} from '../src/agent-workflow.mjs';
import {wikiQuery,wikiQueryFields} from '../src/wiki-surface.mjs';
const uuid={type:'string',pattern:'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'};
const integer={type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER};
const common={workspaceId:uuid,workspaceEpoch:uuid};
const object=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const nullableId={anyOf:[uuid,{type:'null'}]},string={type:'string'},short={type:'string',maxLength:4096},markdown={type:'string',maxLength:262144};
const scope={oneOf:[object({kind:{const:'project'},projectId:uuid}),object({kind:{const:'workspace_shared'}})]};
const ref=object({type:{enum:['issue','wiki']},id:uuid});
const targets={type:'array',minItems:1,maxItems:100,items:object({id:uuid,expectedVersion:integer})};
const claim=object({claimId:uuid,fencingToken:{type:'string',pattern:'^[1-9][0-9]{0,77}$'},runtimeInstanceId:uuid,attemptId:uuid});
const reason=object({text:markdown,code:{type:'string',maxLength:200}},['text']);
const outcome=object({artifactIds:{type:'array',items:uuid,maxItems:100,uniqueItems:true},summary:markdown},['artifactIds']);
const map={type:'array',maxItems:4096,items:object({priorOccurrenceId:uuid,bindingId:uuid,bindingVersion:integer,newOrdinal:{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER}})};
const payloads={
 'Issue.UpdateTitle':object({title:short}),
 'Issue.Create':object({projectId:uuid,title:short,description:markdown,assigneeId:nullableId,priority:{enum:[null,'P0','P1','P2','P3','P4']},parentId:nullableId,initialStatus:{enum:['backlog','ready']}}),
 'Issue.UpdateBody':object({description:markdown,linkOccurrenceMap:map},['description']),
 'Issue.Assign':object({assigneeId:nullableId}), 'Issue.SetPriority':object({priority:{enum:[null,'P0','P1','P2','P3','P4']}}),
 'Issue.AddComment':object({commentId:uuid,bodyMarkdown:markdown}), 'Issue.EditComment':object({commentId:uuid,expectedCommentVersion:integer,bodyMarkdown:markdown}),
 'Issue.Claim':object({payloadVersion:{const:1},attemptId:uuid,runtimeInstanceId:uuid,agentDefinition:object({id:{type:'string',minLength:1,maxLength:200},revision:{type:'string',minLength:1,maxLength:200}}),expectedClaimVersion:{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER}}),
 'Issue.RenewClaim':object({payloadVersion:{const:1},claim}), 'Issue.ReleaseClaim':object({payloadVersion:{const:1},claim,reason:short}),
 'Issue.AppendProgress':object({payloadVersion:{const:2},entryId:uuid,bodyMarkdown:markdown,reason,result:outcome,claim,effectCheckpoint:object({effectId:uuid,state:{enum:['external_outcome_unknown','reconciled']},reference:short})},['payloadVersion','entryId','bodyMarkdown']),
 'Issue.Transition':object({payloadVersion:{const:2},entryId:uuid,toStatus:{enum:['backlog','ready','in_progress','blocked','done','canceled']},reason,waitingFor:markdown,nextStep:markdown,result:outcome,claim},['payloadVersion','entryId','toStatus']),
 'Issue.Reparent':object({payloadVersion:{const:1},parentId:nullableId,expectedParentVersion:integer},['payloadVersion','parentId']),
 'Issue.MoveTree':object({payloadVersion:{const:1},targetProjectId:uuid,targets}),
 'Wiki.Create':object({pageId:uuid,scope,parentId:nullableId,title:short,slug:short,contentMarkdown:markdown,summary:short},['pageId','scope','parentId','title','slug','contentMarkdown']),
 'Wiki.Edit':{...object({title:short,contentMarkdown:markdown,summary:short,linkOccurrenceMap:map},[]),anyOf:[{required:['title']},{required:['contentMarkdown']},{required:['summary']}]},
 'Wiki.Rename':object({title:short,slug:short}), 'Wiki.MoveTree':object({targetScope:scope,targetParentId:nullableId,targets}),
 'Wiki.Trash':object({reason:short}), 'Wiki.Restore':object({}), 'Wiki.RestoreRevision':object({revisionId:uuid,summary:short}),
 'Content.ResolveLink':object({occurrenceId:uuid,sourceRevisionId:uuid,expectedBindingVersion:integer,targetResource:ref,sourceResource:ref},['occurrenceId','sourceRevisionId','expectedBindingVersion','targetResource'])
};
if(Object.values(commandTools).includes('SetResourceAccess'))payloads.SetResourceAccess=object({resource:ref,expectedPolicyVersion:integer,policy:object({mode:{enum:['inherit','restricted']},readerPrincipalIds:{type:'array',items:uuid,maxItems:4096,uniqueItems:true},writerPrincipalIds:{type:'array',items:uuid,maxItems:4096,uniqueItems:true}})});
const queries={
 issue_get:{query:queryIssues,required:['entityId'],fields:['entityId']},issue_list:{query:queryIssues,required:[],fields:[]},
 project_get:{query:queryProjects,required:['entityId'],fields:['entityId']},project_list:{query:queryProjects,required:[],fields:[]},
 my_issues:{query:queryMyIssues,required:[],fields:['status','projectId','limit','cursor']},
 issue_entries_list:{query:queryIssueEntries,required:['entityId'],fields:['entityId','limit','cursor']},
 content_revision_get:{query:queryContentRevisions,required:['entityId','revisionId'],fields:['entityId','revisionId']},
 content_revision_list:{query:queryContentRevisions,required:['entityId'],fields:['entityId','limit','cursor']},
 operation_get:{query:operationGet,required:['operationId'],fields:['operationId']},
 claim_get:{query:queryClaim,required:['entityId'],fields:['entityId']},
 resolution_records_list:{query:queryResolutionRecords,required:['entityId'],fields:['entityId','limit','cursor']},
 capabilities_get:{query:queryCapabilities,required:[],fields:[]},
 attempt_checkpoint_get:{query:queryAttemptCheckpoint,required:['entityId'],fields:['entityId']},
 issue_alias_get:{query:queryIssueAlias,required:['projectId','number'],fields:['projectId','number']},
 ...Object.fromEntries(Object.entries(wikiQueryFields).map(([name,fields])=>[name,{query:(db,actor,args)=>wikiQuery(db,actor,name,args),fields,required:{wiki_get:['entityId'],wiki_list:[],wiki_revision_get:['entityId','revisionId'],wiki_revision_list:['entityId'],wiki_resolve:['scope','kind','rawKey'],links_list:['resource'],backlinks_list:['resource']}[name]}]))
};
const fields={entityId:uuid,revisionId:uuid,operationId:uuid,projectId:uuid,number:integer,resourceVersion:integer,linkViewId:uuid,limit:{type:'integer',minimum:1,maximum:100},cursor:{type:'string',minLength:1,maxLength:2048},status:{enum:['unresolved','all']},scope,search:string,includeDeleted:{type:'boolean'},kind:{enum:['slug','title','legacy_url']},rawKey:string,resource:ref};
const tools=Object.freeze([
 ...Object.entries(commandTools).map(([name,type])=>({name,description:`${type}: uses the shared command contract and current authorization. Persist operationId before sending; reuse exactly that ID and envelope for recovery. JSON-RPC id identifies only this attempt. Text byte limits and cross-field conditions are enforced by the same domain validator as REST.`,inputSchema:{$schema:'https://json-schema.org/draft/2020-12/schema',...object({...common,schemaVersion:{const:1},operationId:uuid,commandType:{const:type},entityId:uuid,expectedVersion:type==='Issue.Create'||type==='Wiki.Create'?{const:0}:integer,payload:payloads[type]})}})),
 ...Object.entries(queries).map(([name,q])=>({name,description:`${name}: current-authorized shared Store query. Denied resources are not disclosed. Large results require structuredContent support; a duplicate text copy may be replaced by an explicit notice. Text-only clients should use limit=1 for paginated queries.`,inputSchema:{$schema:'https://json-schema.org/draft/2020-12/schema',...object({...common,...Object.fromEntries(q.fields.map(k=>[k,name==='my_issues'&&k==='projectId'?nullableId:k==='cursor'&&Object.hasOwn(wikiQueryFields,name)?{...fields.cursor,maxLength:WIKI_CURSOR_MAX_LENGTH}:fields[k]]))},[...Object.keys(common),...q.required])}}))
].sort((a,b)=>a.name.localeCompare(b.name,'en')));
if(Object.keys(commandTools).length!==Object.keys(payloads).length||Object.values(commandTools).some(t=>!payloads[t]))throw Error('MCP command contract coverage mismatch');
export const listMCPTools=()=>structuredClone(tools);
export function callMCPTool(db,actor,name,args){
 if(Object.hasOwn(commandTools,name)){
  if(args?.commandType==='Issue.UpdateTitle'&&new TextEncoder().encode(JSON.stringify(args)).length>16384)return failure('BODY_TOO_LARGE');
  const invalid=validate(args);if(invalid||args.commandType!==commandTools[name])return failure(invalid??'VALIDATION');
  return executeCommand(db,actor,args);
 }
 const q=queries[name];
 if(!q||!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>![...Object.keys(common),...q.fields].includes(k))||[...Object.keys(common),...q.required].some(k=>args[k]===undefined))return failure('VALIDATION');
 const result=q.query(db,actor,args);
 return result.data&&['issue_get','issue_list','project_get','project_list','issue_entries_list','content_revision_get','content_revision_list'].includes(name)?{...result,meta:{...result.meta,workspaceId:args.workspaceId,workspaceEpoch:args.workspaceEpoch,actorId:actor.principalId}}:result;
}
