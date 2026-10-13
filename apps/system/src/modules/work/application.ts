// @module work
// @role application
import {InputError,type Failure,type ReadOutcome,type ChangeOutcome,type ResultOutcome} from "../change-outcomes";
import type {WorkContent} from './public';
import {needsIssueState,decideIssueChange,decideContentChange} from "./decisions";
import type {WorkContentPort} from './ports';
import {normalizeIssueChange,normalizeContentChange,validateIssueRoute,validateContentRoute,validateIssueListQuery,validateContentPage,validateHistoryPage,validateOperationId,validateImportedSource,validateLegacyReference} from './rules';
const failure=(error:unknown):Failure=>error instanceof InputError?{kind:'invalid',code:error.code,...(error.fields?{fields:error.fields}:{})}:{kind:'unavailable'};
async function read<T>(validate:()=>void,run:()=>Promise<ReadOutcome<T>>):Promise<ReadOutcome<T>>{
 try{validate();return await run();}catch(error){const f=failure(error);return {status:f.kind==='invalid'?'invalid':'unavailable',failure:f};}
}
async function result<T>(validate:()=>void,run:()=>Promise<ResultOutcome<T>>):Promise<ResultOutcome<T>>{
 try{validate();return await run();}catch(error){const f=failure(error);return {status:f.kind==='invalid'?'invalid':'unavailable',failure:f};}
}
async function change<T>(operationId:string,run:()=>Promise<ChangeOutcome<T>>):Promise<ChangeOutcome<T>>{
 try{return await run();}catch(error){return {application:'unknown',disclosure:'withheld',operationId,failure:failure(error)};}
}
/** The application knows commands and persistence evidence, not SQL, credentials or a DB implementation. */
export function createWorkContent(port:WorkContentPort):WorkContent {
 return {
  listIssues:x=>read(()=>{validateIssueRoute(x.projectId);validateIssueListQuery(x.query);},()=>port.listIssues(x)),
  listAssignees:x=>read(()=>validateIssueRoute(x.projectId),()=>port.listAssignees(x)),
  getIssue:x=>read(()=>validateIssueRoute(x.projectId,x.issueId),()=>port.getIssue(x)),
  getIssueHistory:x=>read(()=>{validateIssueRoute(x.projectId,x.issueId);validateHistoryPage(x.afterRevision,x.limit);},()=>port.getIssueHistory(x)),
  changeIssue:(x,fence)=>change(x.input?.operationId??'',async()=>{
   const command=normalizeIssueChange(x);
   let state;
   if(needsIssueState(command)){
    const inspection=await port.inspectIssueChange(command);
    if(inspection.kind==='outcome')return inspection.outcome;
    state=inspection.state;
   }
   const decision=decideIssueChange(command,state);
   return decision.kind==='reject'?port.rejectIssueChange(command,decision.reason):port.commitIssueChange(command,decision.plan,fence);
  }),
  issueResult:x=>result(()=>{validateIssueRoute(x.projectId);validateOperationId(x.operationId);},()=>port.issueResult(x)),
  listContent:x=>read(()=>{validateContentRoute(x.projectId,x.resource);validateContentPage(x.page,x.pageSize);},()=>port.listContent(x)),
  getContent:x=>read(()=>validateContentRoute(x.projectId,x.resource,x.id),()=>port.getContent(x)),
  contentHistory:x=>read(()=>{validateContentRoute(x.projectId,x.resource,x.id);validateHistoryPage(x.afterRevision,x.limit);},()=>port.contentHistory(x)),
  changeContent:(x,fence)=>change(x.input?.operationId??'',()=>{const command=normalizeContentChange(x);return port.commitContentChange(command,decideContentChange(command),fence);}),
  contentResult:x=>result(()=>{validateContentRoute(x.projectId,x.resource);validateOperationId(x.operationId);},()=>port.contentResult(x)),
  directory:()=>read(()=>{},()=>port.directory()),
  resolveLegacy:x=>read(()=>validateLegacyReference(x),()=>port.resolveLegacy(x)),
  importedSource:x=>read(()=>validateImportedSource(x),()=>port.importedSource(x))
 };
}
