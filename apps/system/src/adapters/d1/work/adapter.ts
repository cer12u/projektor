// @module work
// @role private-d1
/** Concrete actor-bound Work persistence. Atomic prepare/commit/authorized receipt stays below the port. */
import type {AuthDB} from "../primitives";
import type {D1OperationDefinition} from "../persistence/transaction";
import {WORK_KINDS,WORK_INPUT_LIMITS} from "../../../modules/work/rules";
import {workRecovery} from "./recovery-policy";
import type {Authenticated} from "../identity/authorization";
import {MutationError} from "../persistence/public";
import {executeMutation,recoverMutation,intentFenceSql} from "../persistence/transaction";
import {observeRead,observeChange,observeResult,failedChange} from "../persistence/outcomes";
import {getIssue,getIssueHistory,prepareIssue,readIssueResult,issueMutationCommand,issuePolicies,readIssuePlanningState,readIssueChangeCurrent} from "./issues";
import {listIssues,listAssignees} from "./lists";
import {getContent,contentHistory,contentResult,listContent,prepareContent} from "./content";
import {readDirectory,readImportedSource,resolveLegacyUrl} from "./model";
import type {WorkContentPort} from "../../../modules/work/ports";
import type {IssueView,IssueListPage,AssigneePage,IssueHistoryPage,ContentView,ContentListPage,ContentHistoryPage,DirectoryView,LegacyResolution,ImportedSourcePage} from "../../../modules/work/public";
export function createD1WorkPort(db:AuthDB,auth:Authenticated):WorkContentPort {
 return {
  listIssues:x=>observeRead(async()=>await listIssues(db,auth,x.projectId,x.query) as IssueListPage),
  listAssignees:x=>observeRead(async()=>await listAssignees(db,auth,x.projectId) as AssigneePage),
  getIssue:x=>observeRead(async()=>await getIssue(db,auth,x.projectId,x.issueId) as unknown as IssueView),
  getIssueHistory:x=>observeRead(async()=>await getIssueHistory(db,auth,x.projectId,x.issueId,x.afterRevision,x.limit) as unknown as IssueHistoryPage),
  async inspectIssueChange(x){
   try{
    const command=await issueMutationCommand(auth,x),recovered=await recoverMutation(db,auth,command,issuePolicies(x.projectId),WORK_INPUT_LIMITS.issue);
    if(recovered)return {kind:'outcome',outcome:{application:'confirmed',disclosure:'allowed',source:'recovered',receipt:{operationId:x.input.operationId,snapshot:recovered.snapshot as unknown as IssueView}}};
    return {kind:'state',state:await readIssuePlanningState(db,auth,x)};
   }catch(error){return {kind:'outcome',outcome:failedChange(x.input.operationId,error)};}
  },
  rejectIssueChange:(x,reason)=>observeChange<IssueView>(x.input.operationId,async()=>{
   const command=await issueMutationCommand(auth,x),recovered=await recoverMutation(db,auth,command,issuePolicies(x.projectId),WORK_INPUT_LIMITS.issue);
   if(recovered)return {operationId:x.input.operationId,snapshot:recovered.snapshot as unknown as IssueView,source:'recovered'};
   const current=x.kind==='edit'?await readIssueChangeCurrent(db,auth,x):undefined;
   throw new MutationError(409,'precondition_conflict',reason,current as unknown as import('../persistence/public').Json);
  }),
  commitIssueChange:(x,plan,fence)=>observeChange<IssueView>(x.input.operationId,async()=>{
   const p=await prepareIssue(auth,x,plan);
   const result=await executeMutation(db,auth,p.command,p.adapter,p.policyFor,fence?{valid:intentFenceSql(auth.id,fence,p.command),requiredPermissions:fence.permissions}:undefined);
   // executeMutation returns only its postcommit, current-authorized stored receipt.
   return {operationId:p.command.operationId,snapshot:result.snapshot as unknown as IssueView,source:result.source};
  }),
  issueResult:x=>observeResult<IssueView>(x.operationId,async()=>{const r=await readIssueResult(db,auth,x.projectId,x.operationId);return {operationId:r.operationId,snapshot:r.snapshot as unknown as IssueView};}),
  listContent:x=>observeRead(async()=>await listContent(db,auth,x.projectId,x.resource,x.page,x.pageSize) as unknown as ContentListPage),
  getContent:x=>observeRead(async()=>await getContent(db,auth,x.projectId,x.resource,x.id) as unknown as ContentView),
  contentHistory:x=>observeRead(async()=>await contentHistory(db,auth,x.projectId,x.resource,x.id,x.afterRevision,x.limit) as unknown as ContentHistoryPage),
  commitContentChange:(x,plan,fence)=>observeChange<ContentView>(x.input.operationId,async()=>{
   const p=await prepareContent(auth,x,plan);
   const result=await executeMutation(db,auth,p.command,p.adapter,p.policyFor,fence?{valid:intentFenceSql(auth.id,fence,p.command),requiredPermissions:fence.permissions}:undefined);
   return {operationId:p.command.operationId,snapshot:result.snapshot as unknown as ContentView,source:result.source};
  }),
  contentResult:x=>observeResult<ContentView>(x.operationId,async()=>{const r=await contentResult(db,auth,x.projectId,x.resource,x.operationId);return {operationId:r.operationId,snapshot:r.snapshot as unknown as ContentView};}),
  directory:()=>observeRead(async()=>await readDirectory(db,auth) as DirectoryView),
  resolveLegacy:x=>observeRead(async()=>await resolveLegacyUrl(db,auth,x) as LegacyResolution),
  importedSource:x=>observeRead(async()=>await readImportedSource(db,auth,x.scopeId,x.kind,x.id,x.page) as ImportedSourcePage)
 };
}

/** SQL policies only; command decoding and dispatch belong to the application. */
export function createD1WorkDefinitions():readonly D1OperationDefinition[]{
 return (['issue','wiki','comment'] as const).map(tag=>({routeTag:tag,operationKinds:WORK_KINDS[tag],recovery:row=>workRecovery(tag,row)}));
}
