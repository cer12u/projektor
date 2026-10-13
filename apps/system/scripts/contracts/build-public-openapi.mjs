// @module tooling.contracts
// @role public-schema
import {addDirectoryContract} from './directory-openapi.mjs';
import {addOperationIntentContract} from './operation-openapi.mjs';
import {readFile,writeFile} from 'node:fs/promises';
const doc=JSON.parse(await readFile(new URL("../../docs/openapi-base.json",import.meta.url))),S=doc.components.schemas;
const ref=n=>({$ref:'#/components/schemas/'+n}),str={type:'string'},integer={type:'integer'},id={type:'string',pattern:'^[A-Za-z0-9_-]{1,128}$'},rev={type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER-1},nullable=x=>({anyOf:[x,{type:'null'}]}),arr=x=>({type:'array',items:x}),obj=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false}),permissions=arr({enum:['view','edit','assign','transition','execute','manage']}),security=[{sessionCookie:[]},{individualApiBearer:[]}];
const response=(schema,description='JSON; Cache-Control: no-store')=>({description,headers:{'Cache-Control':{schema:{const:'no-store'}}},content:{'application/json':{schema}}});
const input=schema=>({required:true,content:{'application/json':{schema}}});
const query=(name,schema,required=false)=>({name,in:'query',required,schema});
const route=(path,method,operationId,schema,body,description='')=>{doc.paths[path]??={};return doc.paths[path][method]={operationId,security,description,parameters:[],...(body?{requestBody:input(body)}:{}),responses:{200:response(schema)}}};
const patchSuccess=(path,method,schema)=>doc.paths[path][method].responses['200']=response(schema);
const scopeId={type:'string',pattern:'^(?:[A-Za-z0-9_-]{1,128}|workspace:[a-fA-F0-9-]{36})$'};
S.Identifier=id;S.ScopeIdentifier=scopeId;S.Permission=permissions.items;
S.Project.properties.id=scopeId;
S.JsonValue={description:'Preserved original JSON value, intentionally not a generated operation, normalized revision, or new authentication assertion.',oneOf:[{type:'null'},{type:'boolean'},{type:'number'},str,arr(ref('JsonValue')),{type:'object',additionalProperties:ref('JsonValue')}]};
S.ContentReference={oneOf:[obj({kind:{const:'link'},url:{...str,minLength:1,'x-max-utf8-bytes':2048},label:{...str,'x-max-utf8-bytes':512}},['kind','url']),obj({kind:{const:'library'},libraryFileId:{...str,pattern:'^libfile_[A-Za-z0-9_-]+$','x-max-utf8-bytes':256},versionId:{...str,pattern:'^[A-Za-z0-9_.:-]+$','x-max-utf8-bytes':128},fileId:{...str,pattern:'^[A-Za-z0-9_.:-]+$','x-max-utf8-bytes':256},url:{...str,minLength:1,'x-max-utf8-bytes':2048},label:{...str,'x-max-utf8-bytes':512}},['kind','libraryFileId','versionId'])]};
S.ContentReferences={...arr(ref('ContentReference')),maxItems:32,'x-max-json-utf8-bytes':4096,description:'Exact values retained; versionId remains a string. Stored URL need not be navigable. Rendering independently permits safe HTTP(S) only.'};
for(const n of ['Issue','BodyDocument','CreateIssueInput','EditIssueInput'])S[n].properties.references=ref('ContentReferences');
S.EditIssueInput.anyOf.push({required:['references']});
// Read snapshots include imported blank/long bodies; mutation constraints do not constrain historical data.
for(const n of ['Issue','BodyDocument']){S[n].properties.body=str;S[n].required=Object.keys(S[n].properties).filter(k=>k!=='resolutionEvents');}
S.IssueHistory.properties.issueId=S.Issue.properties.id;S.IssueHistory.properties.afterBody=str;
for(const n of ['IssueHistory','ContentHistory']){Object.assign(S[n].properties,{beforeReferences:nullable(ref('ContentReferences')),afterReferences:nullable(ref('ContentReferences')),beforeTitle:nullable(str),afterTitle:str});}
S.BodyDocument.properties.parentKind={enum:['issue','wiki',null]};S.BodyDocument.properties.parentId=nullable(id);S.BodyDocument.properties.kind={enum:['wiki','comment']};
S.BodyDocument.required=Object.keys(S.BodyDocument.properties);delete S.BodyDocument.allOf;
S.ContentMutationResult.required=['operationId','snapshot','source'];S.ContentMutationResult.additionalProperties=false;
for(const n of ['ContentHistory','ContentList','ContentHistoryPage','Principal','Project','Identity','Error'])S[n].additionalProperties=false;
S.ContentHistoryPage.properties.resolutionEvents={type:'array',maxItems:0};S.ContentHistoryPage.properties.nextResolutionAfterRevision={type:'null'};
const wikiBody={...str,'x-max-utf8-bytes':32768,'x-max-json-utf8-bytes':49152,description:'Valid Unicode; no NUL; blank allowed.'},commentBody={...str,minLength:1,'x-max-utf8-bytes':8192,'x-max-json-utf8-bytes':12288,description:'Valid Unicode; no NUL; must contain non-whitespace.'};
for(const [name,body,isWiki] of [['Wiki',wikiBody,true],['Comment',commentBody,false]])for(const edit of [false,true]){const p={operationId:id,...(edit?{revision:rev}:{}),body,...(isWiki?{title:{...str,'x-max-utf8-bytes':4096,'x-max-json-utf8-bytes':6144},references:ref('ContentReferences')}:{})};S[(edit?'Edit':'Create')+name+'Input']={...obj(p,edit?['operationId','revision']:['operationId','body']),...(edit?{anyOf:(isWiki?['body','title','references']:['body']).map(k=>({required:[k]}))}:{})};}
for(const [path,item] of Object.entries(doc.paths))if(/\/(wikis|comments)(\/|$)/.test(path)||/\/(wiki|comment)-operations\//.test(path)){
 const comment=path.includes('/comments')||path.includes('/comment-operations'),name=comment?'Comment':'Wiki';
 for(const [method,o]of Object.entries(item)){if(method==='post'||method==='patch')o.requestBody=input(ref((method==='post'?'Create':'Edit')+name+'Input'));if(method==='get'&&path.endsWith('}')){if(path.includes('-operations/'))o.responses['200']=response(obj({operationId:id,snapshot:ref('BodyDocument')}));else o.responses['200']=response(obj({document:ref('BodyDocument')}));}}
}
S.ManagementPrincipal=obj({principalId:id,kind:{enum:['human','agent']},displayName:str,active:{enum:[0,1]},authVersion:integer,globalAdministrator:{enum:[0,1]},revision:rev});
S.ManagementMembership=obj({principalId:id,projectId:scopeId,revision:{...rev,minimum:0},permissions,relationExists:{const:false}},['principalId','projectId','revision','permissions']);
S.ManagementMembership.allOf=[{if:{properties:{revision:{const:0}}},then:{required:['relationExists']}}];
S.ManagementCredential=obj({credentialId:id,principalId:id,expiresAt:integer,revokedAt:nullable(integer),revision:rev});
S.ManagementScope=obj({...S.ManagementCredential.properties,projectId:scopeId,permissions,relationExists:{const:false}},[...S.ManagementCredential.required,'projectId','permissions']);
S.ManagementSnapshot={oneOf:['ManagementPrincipal','ManagementMembership','ManagementCredential','ManagementScope'].map(ref)};
const mgResult=s=>obj({operationId:id,snapshot:s,source:{enum:['committed','recovered']}});
const relationInput=membership=>{const value=obj({operationId:id,revision:membership?{...rev,minimum:0}:rev,permissions,createRelation:{const:true}},['operationId','revision','permissions']);if(membership)value.allOf=[{if:{required:['createRelation']},then:{properties:{revision:{const:0}}},else:{properties:{revision:rev}}}];return value;};
const principalInput=obj({operationId:id,revision:rev,displayName:nullable({...str,'x-max-utf8-bytes':256}),active:nullable({type:'boolean'})},['operationId','revision']);principalInput.anyOf=[{required:['displayName'],properties:{displayName:{...str,pattern:'\\S'}}},{required:['active'],properties:{active:{type:'boolean'}}}];
for(const [p,m,n,b]of [
 ['/api/management/principals/{principalId}','patch','ManagementPrincipal',principalInput],
 ['/api/management/credentials/{credentialId}/revoke','post','ManagementCredential',obj({operationId:id,revision:rev})],
 ['/api/projects/{projectId}/memberships/{principalId}','put','ManagementMembership',relationInput(true)],
 ['/api/projects/{projectId}/credential-scopes/{credentialId}','put','ManagementScope',relationInput(false)]]){doc.paths[p][m].requestBody=input(b);patchSuccess(p,m,mgResult(ref(n)));}
patchSuccess('/api/management/operations/{operationId}','get',obj({snapshot:ref('ManagementSnapshot')}));
patchSuccess('/api/projects/{projectId}/principals/{principalId}/display','get',obj({id,kind:{enum:['human','agent']},displayName:str,active:{type:'boolean'}}));
S.InitialProject=obj({projectId:scopeId,permissions:{...permissions,maxItems:6,uniqueItems:true}},['projectId','permissions']);
const register=obj({operationId:id,principalId:id,kind:{enum:['human','agent']},displayName:{...str,minLength:1,maxLength:128,'x-max-utf8-bytes':256,pattern:'\\S'},loginId:nullable({...str,pattern:'^[a-z0-9][a-z0-9._-]{0,63}$'}),projects:{...arr(ref('InitialProject')),maxItems:64}});register.allOf=[{if:{properties:{kind:{const:'agent'}}},then:{properties:{loginId:{type:'null'}}},else:{properties:{loginId:{type:'string'}}}}];
route('/api/management/principals','post','registerPrincipal',mgResult(ref('ManagementPrincipal')),register,'Explicit registration: current global administrator plus view/manage for every initial project. No credential issuance, administrator assignment, automatic enrollment, or delete API. Nonempty permission arrays include view; project IDs unique.');
route('/api/management/context','get','getManagementContext',obj({globalAdministrator:{type:'boolean'},projects:arr(ref('Project'))}));
const kind={enum:['principal','membership','credential','scope']},filters=[query('kind',kind,true),query('projectId',scopeId)];
route('/api/management/records','get','listManagementRecords',obj({records:{...arr(ref('ManagementSnapshot')),maxItems:50},nextAfter:nullable(id)})).parameters=[...filters,query('after',{...str,pattern:'^[A-Za-z0-9_-]{0,128}$'})];
route('/api/management/records/{targetId}','get','getManagementRecord',obj({snapshot:ref('ManagementSnapshot')})).parameters=filters;
S.ManagementHistoryEntry=obj({actorId:id,actorName:str,operationId:id,kind:{enum:['management.principal.create','management.principal.update','management.membership.set','management.credential.revoke','management.credential.scope']},beforeRevision:integer,afterRevision:integer,before:nullable(ref('ManagementSnapshot')),after:nullable(ref('ManagementSnapshot')),recordedAt:integer,initialProjects:arr(ref('InitialProject'))},['actorId','actorName','operationId','kind','beforeRevision','afterRevision','before','after','recordedAt']);
route('/api/management/history','get','getManagementHistory',obj({history:{...arr(ref('ManagementHistoryEntry')),maxItems:50},nextAfter:nullable({type:'string',pattern:'^[1-9][0-9]{0,14}$'})})).parameters=[...filters,query('targetId',id,true),query('after',{type:'string',pattern:'^(?:|[1-9][0-9]{0,14})$'})];
for(const p of ['/api/management/records','/api/management/records/{targetId}','/api/management/history'])doc.paths[p].get.description='Current authority rechecked on each disclosure. principal/credential require global administrator; projectId omitted, empty, or GLOBAL. membership/scope require explicit projectId and current global administrator or view/manage plus credential grants and session ceiling. Missing relations return relationExists:false only for an existing Work scope and existing Identity target. First membership uses revision 0; first credential scope retains the current credential-wide revision. PUT requires explicit createRelation:true for either first relation. New rights require current actor rights (global administrator may bootstrap) within its credential/session ceiling; new API grants also require target principal memberships. Existing higher rights may be retained or revoked. Unknown/repeated query rejected. Stable ascending ID pages (records) or audit row cursor (history); page size fixed at 50.';
S.DirectoryProject=obj({id,workspaceId:nullable(str),key:nullable(str),slug:nullable(str),name:str,description:str});
S.DirectoryWorkspace=obj({id,scopeId:str,name:str});
S.DirectoryDefinition=obj({sourceTable:{enum:['task_statuses','task_types','custom_field_definitions','user_groups','user_group_members','group_project_grants','workspace_members']},scopeId:str,record:ref('JsonValue')});
patchSuccess('/api/directory','get',obj({projects:arr(ref('DirectoryProject')),workspaces:arr(ref('DirectoryWorkspace')),definitions:arr(ref('DirectoryDefinition'))}));
patchSuccess('/api/resolve','get',obj({url:str,id,scopeId:str,content:{enum:['project','issue','wiki']}}));
for(const [p,item]of Object.entries(doc.paths))if(p.includes('/source/')){item.get.parameters=[query('page',{type:'integer',minimum:1,maximum:100000,default:1})];item.get.responses['200']=response(obj({record:ref('JsonValue'),history:arr(obj({sourceTable:{enum:['activity','wiki_revisions','issue_resolution_events']},sourceId:id,actorName:nullable(str),record:ref('JsonValue')})),page:integer,historyTotal:integer}));item.get.description='Read original imported record and original history, never fabricated operation IDs or revisions. Current scope view required. Ten history records per page sorted by original created_at/occurred_at, source table and ID. Unknown/repeated queries rejected. Missing visible source yields 404.';}
S.OwnerSetupStatus=obj({principalId:id,operationId:id,state:{enum:['ready','completed']},expiresAt:integer,completedAuthVersion:integer},['principalId','operationId','state','expiresAt']);
const ownerBase='/api/auth/password-setup/owner-initial';
const ownerRoutes=[
 ['/context','prepareOwnerSetupContext',obj({expiresAt:integer}),obj({operationId:id},[]),'Prepare a protected browser context before issuance. A resume operationId requires the existing context. Refresh changes CSRF binding only, never the capability binding or expiry.'],
 ['','beginOwnerInitialSetup',ref('OwnerSetupStatus'),obj({operationId:id}),'Issue or recover the fixed-owner initial setup grant for the existing protected context and exact operationId. Independently verify configured external identity. No setup bearer secret is returned.'],
 ['/status','getOwnerInitialSetupStatus',ref('OwnerSetupStatus'),obj({operationId:id}),'Recover the same grant or completion under the protected context and current authority. Missing receipt does not certify nonapplication.'],
 ['/complete','completeOwnerInitialSetup',obj({...S.OwnerSetupStatus.properties,state:{const:'completed'},source:{enum:['committed','recovered']}},[...S.OwnerSetupStatus.required,'completedAuthVersion','source']),obj({operationId:id,password:str}),'Consume the bound grant, update password/auth version, and record result atomically. Same operationId and password recover the prior result. Password stays in memory.']
];
for(const [suffix,name,schema,body,description]of ownerRoutes){
 const o=route(ownerBase+suffix,'post',name,schema,body,description+' HTTPS and exact Origin/CSRF required. No redirects or automatic reissuance.');
 o.security=suffix==='/context'?[{loginChallengeCookie:[]}]:suffix===''?[{ownerContextCookie:[],ownerAccessAssertion:[]}]:[{ownerContextCookie:[]}];
 for(const status of [400,401,403,404,405,409,413,415,429,503])o.responses[status]=response(ref('PublicError'),'Request rejected or unavailable; an error alone does not certify nonapplication.');
}
doc.components.securitySchemes.ownerContextCookie={type:'apiKey',in:'cookie',name:'__Host-projektor_owner_setup',description:'HttpOnly Secure host-only browser capability; only its hash is persisted. Bound to owner, operation, target version and one grant. Not an ordinary setup bearer.'};
doc.components.securitySchemes.ownerAccessAssertion={type:'apiKey',in:'header',name:'Cf-Access-Jwt-Assertion',description:'Explicit fixed-owner bridge only; independently verified signed assertion, never normal API authentication.'};
for(const p of ['/api/auth/password-setup/context','/api/auth/password-setup/complete','/api/auth/password-setup/result','/api/auth/browser-session/context'])doc.paths[p].post.security=[{loginChallengeCookie:[]}];
doc.components.securitySchemes.browserExchangeCookie={type:'apiKey',in:'cookie',name:'__Host-projektor_exchange'};
doc.paths['/api/auth/browser-session/redeem'].post.security=[{browserExchangeCookie:[]}];
// New administrator issuance binds a recipient-established capability; never returns a bearer.
const setupIssuePath='/api/management/principals/{principalId}/password-setup/issue';
const setupSchema=doc.paths[setupIssuePath].post.responses['200'].content['application/json'].schema;
S.SetupMetadata={...setupSchema.properties.snapshot,additionalProperties:false};
doc.paths[setupIssuePath].post.requestBody=input(obj({operationId:id,revision:rev,purpose:{enum:['initial','reset']},recipientRequestId:{...str,pattern:'^[A-Za-z0-9_-]{43}$'}}));
for(const path of [setupIssuePath,'/api/management/principals/{principalId}/password-setup/revoke'])patchSuccess(path,'post',mgResult(ref('SetupMetadata')));
doc.paths[setupIssuePath].post.description='Current global administrator atomically binds a recipient-established unexpired context to the exact target, purpose, auth version and operation ID. recipientRequestId is not a secret and cannot authorize completion. A replay must retain the same requestId; issuance and receipt recovery return only metadata, never a setup bearer.';
for(const path of ['/api/auth/password-setup/context','/api/auth/password-setup/complete','/api/auth/password-setup/result'])doc.paths[path].post.description='Migration compatibility for previously issued unbound bearer grants only. Context-bound owner/recipient grants are rejected. No new issuance uses this flow. '+doc.paths[path].post.description;
const requestId={...str,pattern:'^[A-Za-z0-9_-]{43}$'},recipientBase='/api/auth/password-setup/recipient';
const recipientFields={requestId,expiresAt:integer,principalId:id,loginId:str,displayName:str,purpose:{enum:['initial','reset']},operationId:id,issuerId:id,issuerDisplayName:str,targetAuthVersion:rev};
S.RecipientSetupWaiting=obj({requestId,state:{const:'waiting'},expiresAt:integer});
S.RecipientSetupReady=obj({...recipientFields,state:{const:'ready'}});
S.RecipientSetupCompleted=obj({...recipientFields,state:{const:'completed'},completedAuthVersion:rev});
S.RecipientSetupStatus={oneOf:['RecipientSetupWaiting','RecipientSetupReady','RecipientSetupCompleted'].map(ref)};
S.RecipientSetupCompletion=obj({...S.RecipientSetupCompleted.properties,source:{enum:['committed','recovered']}});
const recipientRoutes=[
 ['/context','prepareRecipientSetupContext',obj({requestId,expiresAt:integer}),{...obj({requestId,replaceAbandoned:{const:true},replacesRequestId:requestId},[]),dependentRequired:{replaceAbandoned:['replacesRequestId'],replacesRequestId:['replaceAbandoned']},not:{required:['requestId','replaceAbandoned']}},'Establish a server-generated host-only HttpOnly context before administrator issuance. With requestId this is resume-only and requires the matching existing cookie. Fresh challenge consumption may rotate CSRF, never context lifetime or grant binding. Explicit replaceAbandoned:true requires replacesRequestId matching the retired context and cannot accompany requestId and may replace only a revoked/orphaned capability with a new unbound context; never call it during resume.'],
 ['/status','readRecipientSetupStatus',ref('RecipientSetupStatus'),obj({}),'Discover the bound target, purpose, issuer and operation under the original capability; no lost administrator operation ID is needed. A requestId alone has no authority.'],
 ['/complete','completeRecipientSetup',ref('RecipientSetupCompletion'),obj({operationId:id,principalId:id,issuerId:id,purpose:{enum:['initial','reset']},password:{...str,minLength:12,'x-max-utf8-bytes':1024}}),'Recipient must explicitly confirm the displayed target, purpose and issuer and repeat their identifiers. Atomically consume the same grant and save password/version/receipt. Completed status recovery checks current principal version, capability lifetime and latest grant; denial returns only error, submitted operationId and unknown application certainty.'],
 ['/abandon','abandonRecipientSetupContext',{oneOf:[obj({abandoned:{const:true}}),obj({abandoned:{const:false},reason:{const:'context_missing'}})]},obj({requestId}),'Explicit recovery action, never automatic during reload: consume a fresh login challenge, atomically match submitted requestId to the current cookie context, and abandon only an unbound, completed, expired or otherwise invalid context. A live uncompleted bound grant blocks abandonment and needs administrator resolution. No Set-Cookie header is sent, so a stale abandon response cannot clear a newer cookie. A separate explicit context replaceAbandoned request is needed to replace the revoked capability; no new context or grant is issued here. Missing capability returns abandoned:false/context_missing and makes no revocation claim; local marker retirement must remain explicit.']
];
for(const [suffix,name,schema,body,description]of recipientRoutes){const o=route(recipientBase+suffix,'post',name,schema,body,description+' Exact Origin/CSRF required; all query strings rejected.');o.security=[suffix==='/context'||suffix==='/abandon'?{loginChallengeCookie:[]}:{recipientContextCookie:[]}];}
doc.components.securitySchemes.recipientContextCookie={type:'apiKey',in:'cookie',name:'__Host-projektor_recipient_setup',description:'Server-generated HttpOnly Secure host-only recipient capability. Request IDs and administrator operation IDs never replace it.'};
// Every operation has a concrete request/response/security contract, never wildcard allow.
for(const [p,item]of Object.entries(doc.paths))for(const [method,o]of Object.entries(item)){
 if(!['get','post','put','patch','delete'].includes(method))continue;
 o.operationId??=method+p.replace(/[^A-Za-z0-9]+/g,'_');o.security??=security;o.parameters??=[];
 for(const match of p.matchAll(/\{([^}]+)\}/g)){
  const name=match[1];o.parameters=o.parameters.filter(v=>!(v.in==='path'&&v.name===name));let schema=id;
  if(name==='projectId'&&(/\/(?:memberships|credential-scopes)\//.test(p)||p.endsWith('/principals/{principalId}/display')))schema=scopeId;
  if(name==='sourceTable')schema={enum:['issues','wiki_pages','issue_comments','projects']};
  if(['workspace','workspaceId'].includes(name)&&p.includes('/wikis'))schema={type:'string',pattern:'^[a-fA-F0-9-]{36}$'};
  if(['issueId','content','parent'].includes(name)){const prefix=name==='issueId'||(name==='parent'&&p.includes('/issues/'))?'I_':name==='content'&&p.includes('/comments/')?'C_':'W_';schema={type:'string',pattern:'^(?:'+prefix+'[a-f0-9]{64}|[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})$'};}
  o.parameters.push({name,in:'path',required:true,schema});
 }
 const authRoute=p.startsWith('/api/auth/'),setupRoute=p.includes('/password-setup');
 o['x-reachability']={importing:authRoute||setupRoute||p==='/api/health'?'route evaluated':'503 import_in_progress before authentication',stopped:['get'].includes(method)||authRoute?'route evaluated': 'common mutations reject 503 write_stopped; no commit'};
 const write=method!=='get';if(write){for(const name of ['Origin','X-CSRF-Token']){o.parameters=o.parameters.filter(v=>!(v.in==='header'&&v.name===name));o.parameters.push({name,in:'header',required:authRoute&&!p.endsWith('/tickets'),schema:str,description:'Required for browser/session writes. Exact configured same origin; CSRF matches current session or scoped login challenge. Bearer writes do not use browser CSRF.'});}}
 
 const statuses=write?[400,401,403,405,409,413,415,500,503]:[400,401,403,404,405,503];
 for(const status of statuses)o.responses[status]??={description:status===503?'Unavailable, import gate or stopped write gate; operation outcome must be recovered with same operation ID.':'Rejected request'};
 for(const [status,r]of Object.entries(o.responses))if(status!=='200'&&!r.content)Object.assign(r,response(ref('PublicError'),r.description));
 o['x-permissions']=p.startsWith('/api/management')?{authority:p==='/api/management/context'?'authenticated':p.includes('/operations/')?'recorded operation authority':p.includes('/records')||p.endsWith('/history')?'conditional management kind':'global-administrator'}:p.includes('/password-setup')||authRoute||p==='/api/health'?{authority:'route-specific'}:{authority:'project-or-workspace',required:write?['view','edit']:p.includes('-operations/')?['view','recorded-operation-permissions']:['view']};
 if(p.includes('/memberships/')||p.includes('/credential-scopes/'))o['x-permissions']={authority:'global-administrator-or-scoped-manager',required:['view','manage'],grantCeiling:'new permissions only; current actor rights or global administrator, always within credential/session ceiling; API grants also within target principal memberships'};
 if(p.endsWith('/issues/{issueId}')&&method==='patch')o['x-permissions']={authority:'project',required:['view'],byField:{body:['edit'],title:['edit'],references:['edit'],parentId:['edit'],typeId:['edit'],priority:['edit'],schedule:['edit'],assigneeId:['assign'],state:['transition']}};
 for(const q of o.parameters)if(q.in==='query'&&q.name==='page'&&!(p.includes('/source/')))q.schema={...q.schema,maximum:999999};
}

// Remove impossible generic statuses on authentication endpoints; index has no 405 handler for these exact routes.
const authStatuses={
 '/api/health':[503],'/api/auth/context':[403,429,503],'/api/auth/login':[400,401,403,413,415,429,503],'/api/auth/me':[400,401,503],'/api/auth/logout':[400,401,403,503],
 '/api/auth/browser-session/context':[400,401,403,405,413,415,429,503],'/api/auth/browser-session/tickets':[400,401,403,405,413,415,503],'/api/auth/browser-session/redeem':[400,401,403,405,413,415,503],
 '/api/auth/password-setup/context':[400,401,403,405,413,415,503],'/api/auth/password-setup/complete':[400,401,403,405,409,413,415,503],'/api/auth/password-setup/result':[400,401,403,404,405,413,415,503]
};
for(const [p,statuses]of Object.entries(authStatuses))for(const o of Object.values(doc.paths[p]))for(const status of Object.keys(o.responses))if(status!=='200'&&!statuses.includes(Number(status)))delete o.responses[status];
for(const p of ['/api/auth/browser-session/context','/api/auth/browser-session/tickets','/api/auth/browser-session/redeem'])doc.paths[p].post.description+=' Unknown or repeated query parameters are rejected; all query strings forbidden.';
for(const [p,item]of Object.entries(doc.paths))for(const [method,o]of Object.entries(item)){
 if(p.endsWith('/source/{sourceTable}/{sourceId}')||p==='/api/resolve'||p==='/api/management/operations/{operationId}')o.responses['404']=response(ref('PublicError'),'Visible source/legacy target or owned operation not found');
 if(p==='/api/resolve')o.responses['409']=response(ref('PublicError'),'ambiguous_legacy_url: more than one preserved target matches');
 if(method==='get'&&p.includes('/source/'))delete o.responses['409'];
 if(p==='/api/health')o.security=[];
 if(p==='/api/auth/browser-session/tickets')o.parameters=o.parameters.filter(v=>!['Origin','X-CSRF-Token'].includes(v.name));
 if(p.endsWith('/issues')||p.includes('/comments')||p.includes('/wikis'))if(method==='post'||method==='patch')o.requestBody['x-max-utf8-bytes']=p.includes('/wikis')&&!p.includes('/comments')?65536:32768;
 if(o.requestBody&&!o.requestBody['x-max-utf8-bytes'])o.requestBody['x-max-utf8-bytes']=4096;
 if(p.includes('/password-setup')&&p.startsWith('/api/management'))o.description=(o.description??'')+' Evaluated before importing read gate; mutations still require common write gate open.';
 if(p==='/api/projects/{projectId}/access')o.description+=' Project ID is the exact identity scope ID; route cannot represent colon-prefixed workspace scopes.';
}
patchSuccess('/api/health','get',obj({phase:{const:'P1a'},database:{const:'ok'}}));
patchSuccess('/api/auth/context','get',obj({csrfToken:{...str,pattern:'^[A-Za-z0-9_-]{43}$'}}));
patchSuccess('/api/auth/login','post',obj({authenticated:{const:true}}));patchSuccess('/api/auth/logout','post',obj({authenticated:{const:false}}));
S.PublicError=obj({error:str,operationId:id,application:{const:'unknown'},fields:{type:'object',additionalProperties:str},reason:str,current:ref('JsonValue')},['error']);
Object.assign(S.Error.properties,{operationId:id,application:{const:'unknown'}});
doc.info={...doc.info,version:'architecture-spec-integrated-contract',description:'Executable current API contract. JSON response schemas distinguish immutable receipts, current snapshots, and preserved source history. No deletion, wildcard route, external agent integration or credential issuance added.'};
try{const fragment=JSON.parse(await readFile(new URL("../../docs/execution-openapi-fragment.json",import.meta.url)));for(const p of Object.keys(fragment.paths))if(doc.paths[p])throw Error('Duplicate fragment route '+p);Object.assign(doc.paths,fragment.paths);for(const [n,s]of Object.entries(fragment.components?.schemas??{})){if(S[n]&&JSON.stringify(S[n])!==JSON.stringify(s))throw Error('Schema collision '+n);S[n]=s;}}catch(e){if(e.code!=='ENOENT')throw e;}

// Typed failure evidence is orthogonal to the domain-specific conflict payload.
for(const name of ['IssueError','ExecutionApiError'])if(S[name])Object.assign(S[name].properties,{operationId:id,application:{const:'unknown'}});

for(const [path,item]of Object.entries(doc.paths))for(const [method,o]of Object.entries(item)){

 if(method==='get'&&path!=='/api/resolve')delete o.responses['409'];
 if(path==='/api/management/password-setup/operations/{operationId}')o.responses['404']=response(ref('PublicError'),'operation_not_found: no receipt for authenticated principal and operation ID');
 for(const r of Object.values(o.responses))r.description=r.description.replace('; Retry-After: 1','; Retry-After is present only when emitted by the outer routing boundary');
 o['x-response-policy']={cacheControl:'no-store',contentType:'application/json',redirects:false};
 if(o.responses['503'])o.responses['503'].description+=' Outer importing gate carries Retry-After: 1; caught domain failures do not promise this header.';
 if(path.includes('/execution')){
 o['x-reachability']={importing:'503 import_in_progress before authentication',stopped:method==='get'?'route evaluated':'common mutation rejects 503 write_stopped; no commit'};
 o['x-permissions']={authority:'project',required:method==='get'&&!path.includes('-operations/')?['view']:['view','execute'],...(method==='post'?{assignment:'Current assignee must equal authenticated principal; action-specific attempt ownership and lease checks apply.'}:{})};
 if(o.requestBody)o.requestBody['x-max-utf8-bytes']=path.includes('execution-reports')?16384:4096;
 }
 if(path==='/api/directory')o['x-permissions']={authority:'authenticated',required:[],disclosure:'Only scopes with current view grant are returned; empty directory succeeds.'};
 for(const code of ['401','403'])if(o.responses[code])o.responses[code].content['application/json'].schema={allOf:[o.responses[code].content['application/json'].schema,{not:{anyOf:['current','snapshot','body','issue','document'].map(k=>({required:[k]}))}}]};
}
// Only a create POST may carry this attempt-scoped negative acknowledgement.
// Bare 403, post-dispatch failures and result GETs never certify nonapplication.
S.IssueCreationNotApplied=obj({error:{const:'forbidden'},mutationOutcome:obj({operationId:id,status:{const:'not_applied'},phase:{const:'pre_dispatch'}})});
const createDenied=doc.paths['/api/projects/{projectId}/issues'].post.responses['403'];
createDenied.content['application/json'].schema={anyOf:[createDenied.content['application/json'].schema,ref('IssueCreationNotApplied')]};
createDenied.description+=' A mutationOutcome with the exact request operationId, status not_applied and phase pre_dispatch certifies this HTTP attempt was rejected before dispatch, with no stored operation observed. A client may resume corrected creation only after atomically retiring a single-attempt journal; another overlapping attempt may still commit. Bare 403 or a result-lookup failure does not establish nonapplication.';
addDirectoryContract(doc);
addOperationIntentContract(doc);
await writeFile(new URL("../../docs/openapi.json",import.meta.url),JSON.stringify(doc,null,2)+'\n');console.log('Generated '+Object.keys(doc.paths).length+' paths');
