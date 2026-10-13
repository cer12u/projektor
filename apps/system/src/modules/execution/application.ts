// @module execution
// @role application
import {InputError,type Failure,type ReadOutcome,type ResultOutcome,type ChangeOutcome} from "../change-outcomes";
import type {Execution,ExecutionAttempt,ExecutionReports,ReportSnapshot} from './public';
import type {ExecutionPersistence} from './ports';
import {decodeExecutionCommand,decodeReportCommand,validateExecutionQuery,validateOperationQuery,planExecution,planReport} from './rules';
const invalid=(error:unknown):Failure=>{
 if(!(error instanceof InputError))throw error;
 return {kind:'invalid',code:error.code,...(error.fields?{fields:error.fields}:{})};
};
/** Use cases own normalization and evidence propagation; persistence owns atomic authority checks. */
export function createExecution(port:ExecutionPersistence):Execution {
 async function read<T>(validate:()=>void,run:()=>Promise<ReadOutcome<T>>):Promise<ReadOutcome<T>>{
  try{validate();return await run();}catch(error){return {status:'invalid',failure:invalid(error)};}
 }
 async function result<T>(validate:()=>void,run:()=>Promise<ResultOutcome<T>>):Promise<ResultOutcome<T>>{
  try{validate();return await run();}catch(error){return {status:'invalid',failure:invalid(error)};}
 }
 function rejected<T,C>(operationId:string,error:unknown):ChangeOutcome<T,C>{
  return {application:'unknown',disclosure:'withheld',operationId,failure:invalid(error)};
 }
 return {
  current:query=>read(()=>validateExecutionQuery(query),()=>port.readCurrent(query)),
  reports:query=>read(()=>validateExecutionQuery(query),()=>port.readReports(query)),
  reportHistory:query=>read(()=>{validateExecutionQuery(query);if(!Number.isSafeInteger(query.after)||query.after<0)throw new InputError('invalid_input',{after:'nonnegative safe integer'});},()=>port.readHistory(query)),
  result:query=>result(()=>validateOperationQuery(query),()=>port.readExecutionResult(query)),
  reportResult:query=>result(()=>validateOperationQuery(query),()=>port.readReportResult(query)),
  async change(command,fence){
   try{
    const normalized=decodeExecutionCommand({projectId:command.projectId,issueId:command.issueId},command.action,command.input);
    const observed=await port.inspectExecution(normalized);
    if(observed.status==='outcome')return observed.outcome;
    const decision=planExecution(normalized,observed.state);
    return decision.status==='conflict'?await port.rejectExecution(normalized,decision.reason):await port.commitExecution(normalized,decision.plan,fence);
   }
   catch(error){return rejected<ExecutionAttempt,ExecutionAttempt|null>(command.input.operationId,error);}
  },
  async report(command,fence){
   try{
    const normalized=decodeReportCommand({projectId:command.projectId,issueId:command.issueId},command.action,command.input);
    const observed=await port.inspectReport(normalized);
    if(observed.status==='outcome')return observed.outcome;
    const decision=planReport(normalized,observed.state);
    return decision.status==='conflict'?await port.rejectReport(normalized,decision.reason):await port.commitReport(normalized,decision.plan,fence);
   }
   catch(error){return rejected<ReportSnapshot,ExecutionReports>(command.input.operationId,error);}
  },
 };
}
