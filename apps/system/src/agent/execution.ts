// @module agent-sdk
// @role private-execution
/** PTORDEV-33 consumer of the existing 31/32 API. No runner, timer or automatic retry. */
import type {AgentClient} from "./public";
import {validContentId} from "../modules/work/content-contracts";
import type {ContentReference} from "../modules/work/reference-contracts";
export interface Attempt {attemptId:string;issueId:string;projectId:string;principalId:string;startOperationId:string;startedAt:number;updatedAt:number;expiresAt:number;leaseVersion:number;storedState:'running'|'ended'|'interrupted';state:'running'|'ended'|'interrupted';endedAt:number|null;endReason:'released'|'disconnected'|'expired'|null;renewIntervalSeconds:60;leaseSeconds:300}
export interface ExecutionReport {sequence:number;principalId:string;operationId:string;issueId:string;projectId:string;attemptId:string;kind:'progress'|'failed'|'completed'|'imported';message:string;failureReason:string|null;references:ContentReference[];recordedAt:number}
export interface Confirmation {sequence:number;principalId:string;operationId:string;issueId:string;projectId:string;attemptId:string;leaseVersion:number;outcome:'unknown'|'not_performed'|'applied';externalOperationId:string|null;references:ContentReference[];message:string;recordedAt:number;newAttemptId:string|null}
export interface Reconciliation {confirmation:Confirmation;importedReport:ExecutionReport|null;nextAction:'remain_interrupted'|'restart'|'existing_result_imported';execution:Attempt}
export interface Restart {attempt:Attempt;confirmation:Confirmation;nextAction:'execute_new_attempt'}
export interface Receipt<T> {operationId:string;snapshot:T}
export interface MutationReceipt<T> extends Receipt<T> {source:'committed'|'recovered'}
export interface LeaseInput {operationId:string;attemptId:string;leaseVersion:number}
export interface ReportInput {operationId:string;attemptId:string;leaseVersion:number;message:string;references?:ContentReference[]}
export interface ReconcileInput extends ReportInput {outcome:Confirmation['outcome'];externalOperationId?:string}
export type ReportSnapshot=ExecutionReport|Reconciliation|Restart;
export interface Reports {execution:Attempt|null;reports:ExecutionReport[];confirmations:Confirmation[]}
export interface ReportHistory {events:{sequence:number;principalId:string;operationId:string;attemptId:string;kind:string;recordedAt:number;snapshot:ReportSnapshot}[];nextAfter:number|null}
export function withExecution(client:AgentClient){
 const root=(project:string,issue?:string)=>{
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(project)||(issue!==undefined&&!validContentId({kind:'issue'},issue)))throw new Error('client_route_rejected');
  return `/api/projects/${project}`+(issue===undefined?'':`/issues/${issue}`);
 };
 const execution=(p:string,i:string)=>root(p,i)+'/execution';
 const reports=(p:string,i:string)=>root(p,i)+'/execution-reports';
 const current=(p:string,i:string)=>client.api<{execution:Attempt|null}>(execution(p,i));
 const receipt=<T>(p:string,id:string,domain:'execution'|'execution-report')=>{
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(id))throw new Error('client_route_rejected');
  return client.api<Receipt<T>>(root(p)+`/${domain}-operations/${id}`);
 };
 return {...client,current,
  acquire:(p:string,i:string,operationId:string)=>client.api<MutationReceipt<Attempt>>(execution(p,i)+'/acquire','POST',{operationId}),
  renew:(p:string,i:string,input:LeaseInput)=>client.api<MutationReceipt<Attempt>>(execution(p,i)+'/renew','POST',input),
  end:(p:string,i:string,input:LeaseInput)=>client.api<MutationReceipt<Attempt>>(execution(p,i)+'/end','POST',input),
  interrupt:(p:string,i:string,input:LeaseInput)=>client.api<MutationReceipt<Attempt>>(execution(p,i)+'/interrupt','POST',input),
  progress:(p:string,i:string,input:ReportInput)=>client.api<MutationReceipt<ExecutionReport>>(reports(p,i)+'/progress','POST',input),
  failed:(p:string,i:string,input:ReportInput&{failureReason:string})=>client.api<MutationReceipt<ExecutionReport>>(reports(p,i)+'/failed','POST',input),
  completed:(p:string,i:string,input:ReportInput)=>client.api<MutationReceipt<ExecutionReport>>(reports(p,i)+'/completed','POST',input),
  reconcile:(p:string,i:string,input:ReconcileInput)=>client.api<MutationReceipt<Reconciliation>>(reports(p,i)+'/reconcile','POST',input),
  restart:(p:string,i:string,input:LeaseInput&{confirmationOperationId:string})=>client.api<MutationReceipt<Restart>>(reports(p,i)+'/restart','POST',input),
  reports:(p:string,i:string)=>client.api<Reports>(reports(p,i)),
  history:(p:string,i:string,after=0)=>{if(!Number.isSafeInteger(after)||after<0)throw new Error('client_route_rejected');return client.api<ReportHistory>(reports(p,i)+'/history?after='+after);},
  executionReceipt:(p:string,id:string)=>receipt<Attempt>(p,id,'execution'),
  reportReceipt:(p:string,id:string)=>receipt<ReportSnapshot>(p,id,'execution-report'),
  /** Recover the ORIGINAL ID first, then inspect current state separately. Neither replays external work. */
  async recoverExecution(p:string,i:string,id:string){const saved=await receipt<Attempt>(p,id,'execution');if(saved.snapshot.projectId!==p||saved.snapshot.issueId!==i)throw new Error('receipt_target_mismatch');return {receipt:saved,current:(await current(p,i)).execution};},
  async recoverReport(p:string,i:string,id:string){const saved=await receipt<ReportSnapshot>(p,id,'execution-report');const target='attempt' in saved.snapshot?saved.snapshot.attempt:'confirmation' in saved.snapshot?saved.snapshot.confirmation:saved.snapshot;if(target.projectId!==p||target.issueId!==i)throw new Error('receipt_target_mismatch');return {receipt:saved,current:(await current(p,i)).execution};},
 };
}
