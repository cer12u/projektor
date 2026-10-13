// @module execution
// @role domain-rules
/** Pure command semantics. No persistence, provider, or clock is consulted here. */
import {parseContentReferences,type ContentReference} from "../work/reference-contracts";
import {InputError} from "../change-outcomes";
import {validContentId} from "../work/content-identifiers";
import type {ExecutionAttempt,ExecutionAction,ExecutionCommand,ExecutionQuery,ReportAction,ReportInput,FailedReportInput,ConfirmationInput,RestartInput,ReportCommand,ConfirmationOutcome} from './public';
export const EXECUTION_LEASE_SECONDS=300;
export const EXECUTION_RENEW_SECONDS=60;
export const EXECUTION_INPUT_LIMIT=16384;
export const EXECUTION_ACTIONS=['acquire','renew','end','interrupt'] as const;
export const REPORT_ACTIONS=['progress','failed','completed','reconcile','restart'] as const;
export const executionPermissions=['execute'] as const;
export const executionKinds=EXECUTION_ACTIONS.map(action=>'execution.'+action);
export const reportKinds=REPORT_ACTIONS.map(action=>'execution-report.'+action);
const identifier=/^[A-Za-z0-9_-]{1,128}$/;
const attemptIdentifier=/^A_[a-f0-9]{64}$/;
function validateProjectId(projectId:string):void {
 if(typeof projectId!=='string'||!identifier.test(projectId))throw new InputError('invalid_input',{projectId:'ASCII project ID required'});
}
export function validateExecutionQuery(query:ExecutionQuery):void {
 validateProjectId(query.projectId);
 if(typeof query.issueId!=='string'||!validContentId({kind:'issue'},query.issueId))throw new InputError('invalid_input',{issueId:'Issue ID required'});
}
export function validateOperationQuery(query:{projectId:string;operationId:string}):void {
 validateProjectId(query.projectId);
 if(typeof query.operationId!=='string'||!identifier.test(query.operationId))throw new InputError('invalid_input',{operationId:'ASCII operation ID required'});
}
export function parseExecutionInput(value:unknown,action:ExecutionAction):{operationId:string;attemptId?:string;leaseVersion?:number} {
  if(!EXECUTION_ACTIONS.includes(action))throw new InputError('invalid_input',{action:'defined execution action required'});
  if(!value||typeof value!=='object'||Array.isArray(value))throw new InputError('invalid_input',{body:'object required'});
  const v=value as Record<string,unknown>,fields:Record<string,string>={};
  const allowed=action==='acquire'?['operationId']:['operationId','attemptId','leaseVersion'];
  for(const key of Object.keys(v))if(!allowed.includes(key))Object.defineProperty(fields,key,{value:'unknown field',enumerable:true});
  if(typeof v.operationId!=='string'||!identifier.test(v.operationId))fields.operationId='1–128 ASCII identifier';
  if(action!=='acquire'){
    if(typeof v.attemptId!=='string'||!attemptIdentifier.test(v.attemptId))fields.attemptId='server attempt ID required';
    if(typeof v.leaseVersion!=='number'||!Number.isSafeInteger(v.leaseVersion)||v.leaseVersion<1||v.leaseVersion>=Number.MAX_SAFE_INTEGER)fields.leaseVersion='positive safe integer';
  }
  if(Object.keys(fields).length)throw new InputError('invalid_input',fields);
  return action==='acquire'?{operationId:v.operationId as string}:{operationId:v.operationId as string,attemptId:v.attemptId as string,leaseVersion:v.leaseVersion as number};
}
const operationIdPattern=identifier;
const attemptIdPattern=attemptIdentifier;
const validText=(v:unknown,max:number):v is string=>typeof v==='string'&&v.trim().length>0&&
  !/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(v)&&new TextEncoder().encode(v).length<=max;
export function parseReportInput(value:unknown,action:ReportAction):ReportInput|FailedReportInput|ConfirmationInput|RestartInput {
  if(!REPORT_ACTIONS.includes(action))throw new InputError('invalid_input',{action:'defined report action required'});
  if(!value||typeof value!=='object'||Array.isArray(value))throw new InputError('invalid_input',{body:'object required'});
  const v=value as Record<string,unknown>,fields:Record<string,string>={};
  const allowed=['operationId','attemptId',...(action==='restart'?['leaseVersion','confirmationOperationId']:['message','references',
    ...(action==='failed'?['failureReason']:[]),...(action==='reconcile'?['leaseVersion','outcome','externalOperationId']:[])])];
  for(const key of Object.keys(v))if(!allowed.includes(key))Object.defineProperty(fields,key,{value:'unknown field',enumerable:true});
  if(typeof v.operationId!=='string'||!operationIdPattern.test(v.operationId))fields.operationId='ASCII operation ID required';
  if(typeof v.attemptId!=='string'||!attemptIdPattern.test(v.attemptId))fields.attemptId='server attempt ID required';
  if(action==='reconcile'||action==='restart')if(typeof v.leaseVersion!=='number'||!Number.isSafeInteger(v.leaseVersion)||v.leaseVersion<1||v.leaseVersion>=Number.MAX_SAFE_INTEGER)fields.leaseVersion='positive safe integer';
  if(action==='restart'){
    if(typeof v.confirmationOperationId!=='string'||!operationIdPattern.test(v.confirmationOperationId))fields.confirmationOperationId='saved confirmation operation ID required';
  }else{
    if(!validText(v.message,4096))fields.message='nonblank Unicode <=4096 UTF-8 bytes';
    if(action==='failed'&&!validText(v.failureReason,2048))fields.failureReason='nonblank Unicode <=2048 UTF-8 bytes';
  }
  let references:ContentReference[]=[];
  if(action!=='restart'&&Object.hasOwn(v,'references'))try{references=parseContentReferences(v.references);}catch(error){fields.references=error instanceof Error?error.message:'invalid references';}
  if(action==='reconcile'){
    if(!['not_performed','applied','unknown'].includes(v.outcome as string))fields.outcome='not_performed / applied / unknown';
    if(Object.hasOwn(v,'externalOperationId')&&!validText(v.externalOperationId,256))fields.externalOperationId='nonblank Unicode <=256 UTF-8 bytes';
    if(!Object.hasOwn(v,'externalOperationId')&&!references.length)fields.externalOperationId='external operation ID or references required';
    if(v.outcome==='applied'&&!references.length)fields.references='existing result references required for import';
  }
  if(Object.keys(fields).length)throw new InputError('invalid_input',fields);
  if(action==='restart')return {operationId:v.operationId as string,attemptId:v.attemptId as string,leaseVersion:v.leaseVersion as number,confirmationOperationId:v.confirmationOperationId as string};
  const base:ReportInput|FailedReportInput={operationId:v.operationId as string,attemptId:v.attemptId as string,message:v.message as string,references,
    ...(action==='failed'?{failureReason:v.failureReason as string}:{})};
  return action==='reconcile'?{...base,leaseVersion:v.leaseVersion as number,outcome:v.outcome as ConfirmationOutcome,
    ...(Object.hasOwn(v,'externalOperationId')?{externalOperationId:v.externalOperationId as string}:{})}:base;
}

export function decodeExecutionCommand(query:ExecutionQuery,action:ExecutionAction,value:unknown):ExecutionCommand {
 validateExecutionQuery(query);
 const input=parseExecutionInput(value,action);
 if(action==='acquire')return {...query,action,input:{operationId:input.operationId}};
 return {...query,action,input:{operationId:input.operationId,attemptId:input.attemptId!,leaseVersion:input.leaseVersion!}};
}
export function decodeReportCommand(query:ExecutionQuery,action:ReportAction,value:unknown):ReportCommand {
 validateExecutionQuery(query);
 const input=parseReportInput(value,action);
 switch(action){
  case 'restart':return {...query,action,input:input as RestartInput};
  case 'reconcile':return {...query,action,input:input as ConfirmationInput};
  case 'failed':return {...query,action,input:input as FailedReportInput};
  default:return {...query,action,input:input as ReportInput};
 }
}
/** A planning observation is not authority; the adapter must recheck this exact branch atomically. */
export function recoveryBranch(observedState:string|undefined):{expectedStoredState:'running'|'interrupted';markExpired:boolean}{
 return observedState==='running'?{expectedStoredState:'running',markExpired:true}:{expectedStoredState:'interrupted',markExpired:false};
}
export function reconciliationNextAction(outcome:ConfirmationOutcome):'restart'|'existing_result_imported'|'remain_interrupted'{
 return outcome==='not_performed'?'restart':outcome==='applied'?'existing_result_imported':'remain_interrupted';
}
/** Pure lease observation. Persistence must compare again with transaction-time DB time. */
export function leaseExpired(expiresAt:number,now:number):boolean{return expiresAt<=now;}

export function observeExecutionAttempt(attempt:ExecutionAttempt|null,now:number):ExecutionAttempt|null {
 if(!attempt||attempt.storedState!=='running'||!leaseExpired(attempt.expiresAt,now))return attempt;
 return {...attempt,state:'interrupted',endedAt:attempt.expiresAt,endReason:'expired'};
}

/** Facts observed together under current authority. They grant no commit authority. */
export interface ExecutionPlanningState {
 actorId:string; observedAt:number; assignedToActor:boolean; head:ExecutionAttempt|null;
 finalReportExists:boolean;
 latestConfirmation:{sequence:number;principalId:string;operationId:string;attemptId:string;leaseVersion:number;outcome:ConfirmationOutcome;used:boolean}|null;
}
export interface AttemptExpectation {
 attemptId:string;principalId:string;leaseVersion:number;storedState:ExecutionAttempt['storedState'];expiresAt:number;updatedAt:number;
}
export type ExecutionPlan=
 | {action:'acquire';expectedHead:AttemptExpectation|null}
 | {action:'renew'|'end';expectedHead:AttemptExpectation;timing:'live'}
 | {action:'interrupt';expectedHead:AttemptExpectation;timing:'live'|'expired'};
export type ReportPlan=
 | {action:'progress'|'failed'|'completed';expectedHead:AttemptExpectation;timing:'live'}
 | {action:'reconcile';expectedHead:AttemptExpectation;markExpired:boolean;importResult:boolean;nextAction:'restart'|'existing_result_imported'|'remain_interrupted'}
 | {action:'restart';expectedHead:AttemptExpectation;markExpired:boolean;confirmation:NonNullable<ExecutionPlanningState['latestConfirmation']>};
export type PlanningDecision<T>={status:'planned';plan:T}|{status:'conflict';reason:string};
const expected=(head:ExecutionAttempt):AttemptExpectation=>({attemptId:head.attemptId,principalId:head.principalId,leaseVersion:head.leaseVersion,storedState:head.storedState,expiresAt:head.expiresAt,updatedAt:head.updatedAt});
const conflict=(reason:string):{status:'conflict';reason:string}=>({status:'conflict',reason});
export function planExecution(command:ExecutionCommand,state:ExecutionPlanningState):PlanningDecision<ExecutionPlan>{
 if(!state.assignedToActor)return conflict('assignment_conflict');
 const head=state.head;
 if(command.action==='acquire')return head&&head.storedState!=='ended'?conflict('execution_unavailable'):{status:'planned',plan:{action:'acquire',expectedHead:head?expected(head):null}};
 if(!head||head.attemptId!==command.input.attemptId||head.principalId!==state.actorId||head.leaseVersion!==command.input.leaseVersion||head.storedState!=='running')return conflict('attempt_conflict');
 const expired=leaseExpired(head.expiresAt,state.observedAt);
 if(command.action!=='interrupt'&&expired)return conflict('lease_expired');
 if(command.action==='renew'&&head.updatedAt>state.observedAt-EXECUTION_RENEW_SECONDS)return conflict('renew_too_early');
 return {status:'planned',plan:command.action==='interrupt'?{action:'interrupt',expectedHead:expected(head),timing:expired?'expired':'live'}:{action:command.action,expectedHead:expected(head),timing:'live'}};
}
export function planReport(command:ReportCommand,state:ExecutionPlanningState):PlanningDecision<ReportPlan>{
 const head=state.head;
 if(command.action!=='reconcile'&&command.action!=='restart'){
  if(!state.assignedToActor||!head||head.attemptId!==command.input.attemptId||head.principalId!==state.actorId||head.storedState!=='running'||leaseExpired(head.expiresAt,state.observedAt))return conflict('live_attempt_conflict');
  if(state.finalReportExists)return conflict('report_finalized');
  return {status:'planned',plan:{action:command.action,expectedHead:expected(head),timing:'live'}};
 }
 if(!state.assignedToActor)return conflict('assignment_conflict');
 const failure=command.action==='restart'?'recovery_head_conflict':'interrupted_attempt_conflict';
 if(!head||head.attemptId!==command.input.attemptId||head.leaseVersion!==command.input.leaseVersion||!(head.storedState==='interrupted'||head.storedState==='running'&&leaseExpired(head.expiresAt,state.observedAt)))return conflict(failure);
 if(command.action==='reconcile'){
  if(command.input.outcome==='applied'&&state.finalReportExists)return conflict('report_finalized');
  return {status:'planned',plan:{action:'reconcile',expectedHead:expected(head),markExpired:head.storedState==='running',importResult:command.input.outcome==='applied',nextAction:reconciliationNextAction(command.input.outcome)}};
 }
 const confirmation=state.latestConfirmation;
 if(!confirmation||confirmation.principalId!==state.actorId||confirmation.operationId!==command.input.confirmationOperationId||confirmation.attemptId!==head.attemptId||confirmation.leaseVersion!==command.input.leaseVersion||confirmation.outcome!=='not_performed'||confirmation.used||state.finalReportExists)return conflict('confirmation_conflict');
 return {status:'planned',plan:{action:'restart',expectedHead:expected(head),markExpired:head.storedState==='running',confirmation}};
}
