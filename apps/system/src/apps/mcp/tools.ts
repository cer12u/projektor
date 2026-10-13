// @module delivery
// @role mcp-adapter
import type {OperationPreparation} from "../../modules/prepared-operations";
import {protocolFailure,readValue,resultValue,resultFailureBody} from "../http/outcomes";
import {decodeLegacyReference} from "../../modules/work/public";
import type {ActorServices} from "../contracts";
import type {IdentityFacts} from "../../modules/identity/public";
import {contentPage,listQuery} from "../http/query";
import { McpServer,type CallToolResult,type Tool } from '@modelcontextprotocol/server';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/server/validators/cf-worker';
import { z } from 'zod';
import { ISSUE_STATES } from "../../modules/work/planning-contracts";
import { ApiError } from "../../adapters/protocol-errors";
import { MutationError } from "../../adapters/d1/persistence/public";

import { commentContext,commentCreate,commentId,commentUpdate,contentHistoryOutput,document,durableOperation,currentDurableOperation,errorResult,execution,executionChange,executionReport,historyInput,identifier,issue,issueCreate,issueHistory,issueId,issueUpdate,mutationReceipt,natural,nullableText,operationResource,operationSummary,pageInput,principal,receipt,record,reports,reportSnapshot,scope,text,wikiCreate,wikiId,wikiUpdate } from "./schema";
function result(value:Record<string,unknown>,isError=false):CallToolResult {
  return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value,...(isError?{isError:true}:{})};
}
function domainError(error:unknown,auth:IdentityFacts,metadataUrl:string|undefined,operationId?:string,mutation=false):CallToolResult {
  const protocol=protocolFailure(error);
  const value=protocol?{...protocol.body,status:protocol.status}:error instanceof ApiError?{error:error.code,status:error.status,...(error.fields?{fields:error.fields}:{})}:
    error instanceof MutationError?{error:error.code,status:error.status,...(error.reason?{reason:error.reason}:{}),...(error.current!==undefined?{current:error.current}:{}),...(error.mutationOutcome?{mutationOutcome:error.mutationOutcome}:{})}:
    {error:'temporarily_unavailable',status:503};
  const reauthenticate=auth.authentication==='federated'&&metadataUrl!==undefined&&value.status===401&&typeof auth.assertion_expires_at==='number'&&auth.assertion_expires_at<=Math.floor(Date.now()/1000);
  // A live assertion with revoked/expired application authority needs an administrator, not an OAuth loop.
  const classified=auth.authentication==='federated'&&value.status===401&&!reauthenticate?{...value,status:403,error:'federation_forbidden'}:value;
  const correlated=operationId?{...resultFailureBody(classified,operationId),status:classified.status}:classified;
  // Only a concrete domain certificate may describe this mutation attempt as not applied.
  if(mutation&&operationId&&'mutationOutcome' in classified&&classified.mutationOutcome&&typeof classified.mutationOutcome==='object'&&'operationId' in classified.mutationOutcome&&classified.mutationOutcome.operationId===operationId){
   Object.assign(correlated,{mutationOutcome:classified.mutationOutcome});delete (correlated as Record<string,unknown>).application;
  }
  return {...result(errorResult.parse(correlated),true),...(reauthenticate?{_meta:{'mcp/www_authenticate':[`Bearer resource_metadata="${metadataUrl}", error="invalid_token", error_description="Access assertion expired; recover the original operation result before any replay"`]}}:{})};
}

type PublicToolDescriptor=Tool&{securitySchemes?:{type:'oauth2';scopes:string[]}[]};
// Only the fixed catalogue's public JSON is retained. No Zod/validator instances,
// handlers, principal, grants, metadata URL, request or server enter this cache.
const publicDescriptorCache:Partial<Record<'api'|'federated',readonly PublicToolDescriptor[]>>={};
function freezePublicJson(value:unknown):void {
  if(value===null||typeof value!=='object'||Object.isFrozen(value))return;
  for(const child of Object.values(value as Record<string,unknown>))freezePublicJson(child);
  Object.freeze(value);
}

/** One server per HTTP request. Only this closure owns the verified principal; no caller supplies auth. */
export function createDomainMcpServer(services:ActorServices,metadataUrl:string|undefined):McpServer {
  const server=new McpServer({name:'projektor',version:'1.0.0'}, {jsonSchemaValidator:new CfWorkerJsonSchemaValidator(),maxToolInputElements:512,capabilities:{tools:{listChanged:false}}});
  const descriptorBuilders:(()=>PublicToolDescriptor)[]=[];
  function register<S extends z.ZodType<Record<string,unknown>>, O extends z.ZodType<Record<string,unknown>>>(
    name:string,description:string,inputSchema:S,outputSchema:O,run:(input:z.output<S>)=>Promise<unknown>,
    options:{mutation?:boolean;destructive?:boolean;identity?:boolean}={}
  ) {
    const registeredInput:z.ZodType<Record<string,unknown>>=inputSchema;
    const securitySchemes:{type:'oauth2';scopes:string[]}[]=[{type:'oauth2',scopes:[]}];
    const annotations={readOnlyHint:!options.mutation,destructiveHint:options.destructive??false,idempotentHint:true,openWorldHint:false};
    const metadata=metadataUrl?{securitySchemes}:{};
    descriptorBuilders.push(()=>({name,description,inputSchema:{...record.parse(JSON.parse(JSON.stringify(z.toJSONSchema(inputSchema,{io:'input',target:'draft-2020-12'})))),type:'object'},outputSchema:record.parse(JSON.parse(JSON.stringify(z.toJSONSchema(outputSchema,{io:'output',target:'draft-2020-12'})))),annotations,...(metadataUrl?{securitySchemes}:{}),_meta:metadata}));
    server.registerTool(name,{description,inputSchema:registeredInput,outputSchema,_meta:metadata,annotations},async (input:unknown)=>{
      const args=inputSchema.parse(input);
      const operationId=typeof args.operationId==='string'?args.operationId:options.mutation&&typeof args.input==='object'&&args.input!==null&&'operationId' in args.input&&typeof args.input.operationId==='string'?args.input.operationId:undefined;
      try {
        // Same import exclusion as REST; stopped-mode mutation decisions remain atomic in the domain batch.
        if(!options.identity)await services.assertAvailable();
        // Never cancel a dispatched domain mutation or infer nonapplication from a lost response.
        return result(outputSchema.parse(await run(args)));
      } catch(error) {return domainError(error,services.actor,metadataUrl,operationId,options.mutation===true);}
    });
  }
  const prepareOperation=(value:OperationPreparation)=>services.operations.prepare(services.operations.decodePreparation(value));
  register('identity_current','Read the current Agent identity and current project grants.',z.strictObject({}),
    z.strictObject({principal,authentication:z.enum(['api','federated']),projects:z.array(z.strictObject({id:text,permissions:z.array(z.enum(['view','edit','assign','transition','execute','manage']))}))}),
    ()=>services.identity.current(),{identity:true});
  register('directory_get','Read authorized projects, workspaces and their shared definitions.',z.strictObject({}),
    z.strictObject({projects:z.array(z.strictObject({id:text,workspaceId:nullableText,key:nullableText,slug:nullableText,name:text,description:nullableText})),workspaces:z.array(z.strictObject({id:text,scopeId:text,name:text})),definitions:z.array(z.strictObject({sourceTable:text,scopeId:text,record}))}),
    ()=>readValue(services.work.directory()));
  register('legacy_resolve','Resolve one legacy relative project, issue or wiki path under current authorization.',z.strictObject({path:text.min(1).max(4096)}),
    z.strictObject({url:text,id:text,scopeId:text,content:z.enum(['issue','wiki','project'])}),a=>readValue(services.work.resolveLegacy(decodeLegacyReference(a.path))));
  register('source_get','Read an imported source record and one page of its preserved history.',z.strictObject({scopeId:scope,kind:z.enum(['issues','wiki_pages','issue_comments','projects']),id:identifier,page:z.number().int().min(1).max(100000).default(1)}),
    z.strictObject({record,history:z.array(z.strictObject({sourceTable:text,sourceId:text,actorName:nullableText,record})),page:natural,historyTotal:natural}),
    a=>readValue(services.work.importedSource({scopeId:a.scopeId,kind:a.kind,id:a.id,page:a.page})));
  register('issue_list','List permitted issues with existing mine, state, search and pagination filters.',z.strictObject({projectId:identifier,q:text.max(256).default(''),state:z.enum(['',...ISSUE_STATES]).default(''),mine:z.boolean().default(true),...pageInput,order:z.literal('priority').default('priority')}),
    z.strictObject({issues:z.array(issue),total:natural,page:natural,pageSize:natural,order:z.literal('priority')}),
    a=>readValue(services.work.listIssues({projectId:a.projectId,query:listQuery(new URLSearchParams({q:a.q,state:a.state,mine:a.mine?'1':'0',page:String(a.page),pageSize:String(a.pageSize),order:a.order}))})));
  register('issue_get','Read one currently visible issue.',z.strictObject({projectId:identifier,issueId}),z.strictObject({issue}),async a=>({issue:await readValue(services.work.getIssue({projectId:a.projectId,issueId:a.issueId}))}));
  register('issue_history','Read a revision-cursor page of issue changes and resolution events.',z.strictObject({projectId:identifier,issueId,...historyInput}),issueHistory,a=>readValue(services.work.getIssueHistory({projectId:a.projectId,issueId:a.issueId,afterRevision:a.afterRevision,limit:a.limit})));
  register('assignee_list','List active, currently eligible assignees in the project.',z.strictObject({projectId:identifier}),z.strictObject({principals:z.array(principal)}),a=>readValue(services.work.listAssignees({projectId:a.projectId})));
  register('wiki_list','List authorized wiki documents in a project or workspace scope.',z.strictObject({scopeId:scope,...pageInput}),z.strictObject({documents:z.array(document),total:natural,page:natural,pageSize:natural}),a=>{const p=contentPage(new URLSearchParams({page:String(a.page),pageSize:String(a.pageSize)}));return readValue(services.work.listContent({projectId:a.scopeId,resource:{kind:'wiki'},page:p.page,pageSize:p.pageSize}));});
  register('wiki_get','Read one authorized wiki document.',z.strictObject({scopeId:scope,wikiId}),z.strictObject({document}),async a=>({document:await readValue(services.work.getContent({projectId:a.scopeId,resource:{kind:'wiki'},id:a.wikiId}))}));
  register('wiki_history','Read a revision-cursor page of wiki history.',z.strictObject({scopeId:scope,wikiId,...historyInput}),contentHistoryOutput,a=>readValue(services.work.contentHistory({projectId:a.scopeId,resource:{kind:'wiki'},id:a.wikiId,afterRevision:a.afterRevision,limit:a.limit})));
  register('comment_list','List comments on an authorized issue or wiki parent.',z.strictObject({...commentContext,...pageInput}),z.strictObject({documents:z.array(document),total:natural,page:natural,pageSize:natural}),a=>{const p=contentPage(new URLSearchParams({page:String(a.page),pageSize:String(a.pageSize)}));return readValue(services.work.listContent({projectId:a.scopeId,resource:{kind:'comment',parentKind:a.parentKind,parentId:a.parentId},page:p.page,pageSize:p.pageSize}));});
  register('comment_get','Read a comment with its explicit parent context.',z.strictObject({...commentContext,commentId}),z.strictObject({document}),async a=>({document:await readValue(services.work.getContent({projectId:a.scopeId,resource:{kind:'comment',parentKind:a.parentKind,parentId:a.parentId},id:a.commentId}))}));
  register('comment_history','Read a revision-cursor page of comment history with explicit parent context.',z.strictObject({...commentContext,commentId,...historyInput}),contentHistoryOutput,a=>readValue(services.work.contentHistory({projectId:a.scopeId,resource:{kind:'comment',parentKind:a.parentKind,parentId:a.parentId},id:a.commentId,afterRevision:a.afterRevision,limit:a.limit})));
  register('execution_current','Read the issue execution attempt and its currently observed lease state.',z.strictObject({projectId:identifier,issueId}),z.strictObject({execution:execution.nullable()}),async a=>({execution:await readValue(services.execution.current({projectId:a.projectId,issueId:a.issueId}))}));
  register('execution_reports','Read current execution reports and reconciliation records.',z.strictObject({projectId:identifier,issueId}),reports,a=>readValue(services.execution.reports({projectId:a.projectId,issueId:a.issueId})));
  register('execution_report_history','Read the next report-history page after a saved sequence cursor.',z.strictObject({projectId:identifier,issueId,after:natural.default(0)}),
    z.strictObject({events:z.array(z.strictObject({sequence:natural,principalId:text,operationId:text,attemptId:text,kind:text,recordedAt:natural,snapshot:reportSnapshot})),nextAfter:natural.nullable()}),a=>readValue(services.execution.reportHistory({projectId:a.projectId,issueId:a.issueId,after:a.after})));
  register('operation_result','Read an original operation result before any contract-permitted same-ID replay. A missing or denied result is not proof of nonapplication.',z.strictObject({scopeId:scope,operationId:identifier,resource:operationResource}),receipt,a=>{
    switch(a.resource.kind){
      case 'issue':return resultValue(services.work.issueResult({projectId:a.scopeId,operationId:a.operationId}),undefined,a.operationId);
      case 'wiki':return resultValue(services.work.contentResult({projectId:a.scopeId,resource:{kind:'wiki'},operationId:a.operationId}),undefined,a.operationId);
      case 'comment':return resultValue(services.work.contentResult({projectId:a.scopeId,resource:{kind:'comment',parentKind:a.resource.parentKind,parentId:a.resource.parentId},operationId:a.operationId}),undefined,a.operationId);
      case 'execution':return resultValue(services.execution.result({projectId:a.scopeId,operationId:a.operationId}),undefined,a.operationId);
      case 'report':return resultValue(services.execution.reportResult({projectId:a.scopeId,operationId:a.operationId}),undefined,a.operationId);
    }
  });
  register('operation_list','Discover bounded summaries of the current Agent durable operations. Fetch exact input and result with operation_get. A missing receipt remains unknown.',z.strictObject({after:natural.default(0),limit:z.number().int().min(1).max(50).default(20)}),z.strictObject({operations:z.array(operationSummary).max(50),nextAfter:natural.nullable()}),a=>services.operations.list(a));
  register('operation_get','Read one durable prepared input and any confirmed original result under current authorization.',z.strictObject({operationId:identifier}),durableOperation,a=>services.operations.get(a.operationId));
  register('operation_execute','Explicitly execute an already recorded operation using its original ID. Reads the original result first; never creates a new operation or executes external effects.',z.strictObject({operationId:identifier}),mutationReceipt,async a=>(await services.operations.execute(a.operationId)).receipt,{mutation:true,destructive:true});
  register('issue_create_prepare','Durably record issue-creation input only; no issue is created. After recorded:true, explicitly execute the same operationId.',z.strictObject({projectId:identifier,input:issueCreate}),currentDurableOperation,a=>prepareOperation({route:{kind:'issue',projectId:a.projectId},input:a.input}),{mutation:true});
  register('issue_update_prepare','Durably record a revision-checked issue update only. Field-derived permissions cover assignment, status and explicit resolution. Execute separately.',z.strictObject({projectId:identifier,issueId,input:issueUpdate}),currentDurableOperation,a=>prepareOperation({route:{kind:'issue',projectId:a.projectId,id:a.issueId},input:a.input}),{mutation:true});
  register('wiki_create_prepare','Durably record wiki-creation input only. Execute separately with the original operationId.',z.strictObject({scopeId:scope,input:wikiCreate}),currentDurableOperation,a=>prepareOperation({route:{kind:'wiki',projectId:a.scopeId},input:a.input}),{mutation:true});
  register('wiki_update_prepare','Durably record a revision-checked wiki edit only; omitted references remain and an empty array clears them when executed.',z.strictObject({scopeId:scope,wikiId,input:wikiUpdate}),currentDurableOperation,a=>prepareOperation({route:{kind:'wiki',projectId:a.scopeId,id:a.wikiId},input:a.input}),{mutation:true});
  register('comment_create_prepare','Durably record comment-creation input with an authorized parent only. Execute separately.',z.strictObject({...commentContext,input:commentCreate}),currentDurableOperation,a=>prepareOperation({route:{kind:'comment',projectId:a.scopeId,parentKind:a.parentKind,parentId:a.parentId},input:a.input}),{mutation:true});
  register('comment_update_prepare','Durably record a revision-checked comment edit with explicit parent context only. Execute separately.',z.strictObject({...commentContext,commentId,input:commentUpdate}),currentDurableOperation,a=>prepareOperation({route:{kind:'comment',projectId:a.scopeId,parentKind:a.parentKind,parentId:a.parentId,id:a.commentId},input:a.input}),{mutation:true});
  register('execution_change_prepare','Durably record acquire, renew, end or interrupt input with the exact attempt and lease version. Preparation never starts or changes an execution.',z.strictObject({projectId:identifier,issueId,input:executionChange}),currentDurableOperation,a=>{const {action,...input}=a.input;return prepareOperation({route:{kind:'execution',projectId:a.projectId,issueId:a.issueId,action},input});},{mutation:true});
  register('execution_report_prepare','Durably record a report or explicit reconcile/restart input only. Execute separately. A completed report never resolves the issue.',z.strictObject({projectId:identifier,issueId,input:executionReport}),currentDurableOperation,a=>{const {action,...input}=a.input;return prepareOperation({route:{kind:'report',projectId:a.projectId,issueId:a.issueId,action},input});},{mutation:true});
  // SDK 2.3.1's high-level descriptor projection omits the OpenAI securitySchemes
  // extension. Use its supported standard-method handler to expose that declaration,
  // retaining the exact registered Zod schemas and SDK-owned tools/call validation.
  server.server.setRequestHandler('tools/list',()=>{
    // Conversion runs only for the first catalogue request in this isolate. Tool
    // calls keep request-local SDK validation without rebuilding all 29 descriptors.
    const key=metadataUrl?'federated':'api';
    let descriptors=publicDescriptorCache[key];
    if(!descriptors){descriptors=descriptorBuilders.map(build=>build());freezePublicJson(descriptors);publicDescriptorCache[key]=descriptors;}
    return {tools:[...descriptors]};
  });
  return server;
}
