// @module execution
// @role private-d1
/** Actor-bound reads and atomic encoding of domain-selected execution plans. */
import type {AuthDB} from '../primitives';
import type {Authenticated} from '../identity/authorization';
import type {ExecutionPersistence,PlanningObservation} from '../../../modules/execution/ports';
import type {ExecutionAttempt,ExecutionReports,ReportSnapshot,ExecutionCommand,ReportCommand} from '../../../modules/execution/public';
import {observeChange,observeRead,observeResult,failedChange} from '../persistence/outcomes';
import {compileExecution,getExecution,readExecutionResult,executionPolicies,inspectExecutionState} from './lifecycle';
import {compileReport,getReports,getReportHistory,readReportResult,reportPolicies} from './reports';
import type {Receipt} from '../../../modules/change-outcomes';
import type {StoredOperationFence} from '../../../modules/prepared-operations';
import {executeMutation,recoverMutation,intentFenceSql,type D1OperationDefinition,type Json,type MutationCommand} from '../persistence/transaction';
import {MutationError} from '../persistence/public';
import {executionKinds,reportKinds,EXECUTION_INPUT_LIMIT} from '../../../modules/execution/rules';
import {executionRecovery} from './recovery-policy';
function mutation(command:ExecutionCommand|ReportCommand,report:boolean):MutationCommand {
 return {operationId:command.input.operationId,kind:(report?'execution-report.':'execution.')+command.action,targetId:command.issueId,projectId:command.projectId,input:command.input as unknown as Json};
}
export function createExecutionPersistence(db:AuthDB,auth:Authenticated):ExecutionPersistence {
 async function inspect<T,C>(command:ExecutionCommand|ReportCommand,report:boolean):Promise<PlanningObservation<T,C>>{
  try{
   const recovered=await recoverMutation(db,auth,mutation(command,report),report?reportPolicies(command.projectId):executionPolicies(command.projectId),EXECUTION_INPUT_LIMIT);
   if(recovered)return {status:'outcome',outcome:{application:'confirmed',disclosure:'allowed',source:'recovered',receipt:{operationId:command.input.operationId,snapshot:recovered.snapshot as T}}};
   return {status:'state',state:await inspectExecutionState(db,auth,command.projectId,command.issueId,report)};
  }catch(error){return {status:'outcome',outcome:failedChange<T,C>(command.input.operationId,error)};}
 }
 const fence=(command:MutationCommand,value?:StoredOperationFence)=>value?{valid:intentFenceSql(auth.id,value,command),requiredPermissions:value.permissions}:undefined;
 return {
  readCurrent:q=>observeRead(()=>getExecution(db,auth,q.projectId,q.issueId)),
  readReports:q=>observeRead(()=>getReports(db,auth,q.projectId,q.issueId)),
  readHistory:q=>observeRead(()=>getReportHistory(db,auth,q.projectId,q.issueId,q.after)),
  readExecutionResult:q=>observeResult(q.operationId,async()=>await readExecutionResult(db,auth,q.projectId,q.operationId) as unknown as Receipt<ExecutionAttempt>),
  readReportResult:q=>observeResult(q.operationId,async()=>await readReportResult(db,auth,q.projectId,q.operationId) as unknown as Receipt<ReportSnapshot>),
  inspectExecution:c=>inspect<ExecutionAttempt,ExecutionAttempt|null>(c,false),
  inspectReport:c=>inspect<ReportSnapshot,ExecutionReports>(c,true),
  rejectExecution:(c,reason)=>observeChange<ExecutionAttempt,ExecutionAttempt|null>(c.input.operationId,async()=>{throw new MutationError(409,'precondition_conflict',reason,await getExecution(db,auth,c.projectId,c.issueId,true) as unknown as Json);}),
  rejectReport:(c,reason)=>observeChange<ReportSnapshot,ExecutionReports>(c.input.operationId,async()=>{throw new MutationError(409,'precondition_conflict',reason,await getReports(db,auth,c.projectId,c.issueId,true) as unknown as Json);}),
  commitExecution:(c,plan,intent)=>observeChange<ExecutionAttempt,ExecutionAttempt|null>(c.input.operationId,async()=>{
   const p=await compileExecution(auth,c,plan),result=await executeMutation(db,auth,p.command,p.adapter,p.policyFor,fence(p.command,intent));
   return {operationId:c.input.operationId,snapshot:result.snapshot as unknown as ExecutionAttempt,source:result.source};
  }),
  commitReport:(c,plan,intent)=>observeChange<ReportSnapshot,ExecutionReports>(c.input.operationId,async()=>{
   const p=await compileReport(auth,c,plan),result=await executeMutation(db,auth,p.command,p.adapter,p.policyFor,fence(p.command,intent));
   return {operationId:c.input.operationId,snapshot:result.snapshot as unknown as ReportSnapshot,source:result.source};
  }),
 };
}
/** Journal visibility only. Prepared execution uses the same application instance as direct calls. */
export function createExecutionDefinitions():readonly D1OperationDefinition[]{
 return (['execution','report'] as const).map(tag=>({routeTag:tag,operationKinds:tag==='execution'?executionKinds:reportKinds,recovery:row=>executionRecovery(tag,row)}));
}
