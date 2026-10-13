// @module execution
// @role public-contract
/** Execution commands and evidence. Actor/credential binding belongs to request composition. */
import type {ContentReference} from "../work/reference-contracts";
import type {ReadOutcome,ResultOutcome,ChangeOutcome} from "../change-outcomes";
export {decodeExecutionCommand,decodeReportCommand,executionPermissions,EXECUTION_INPUT_LIMIT} from './rules';
import type {StoredOperationFence} from '../prepared-operations';
export type ExecutionAction='acquire'|'renew'|'end'|'interrupt';
export type ReportAction='progress'|'failed'|'completed'|'reconcile'|'restart';
export type ConfirmationOutcome='not_performed'|'applied'|'unknown';
export interface ExecutionQuery {projectId:string;issueId:string}
export interface OperationQuery {projectId:string;operationId:string}
export interface AcquireInput {operationId:string}
export interface LeaseInput extends AcquireInput {attemptId:string;leaseVersion:number}
export type ExecutionCommand=ExecutionQuery&({action:'acquire';input:AcquireInput}|{action:'renew'|'end'|'interrupt';input:LeaseInput});
export interface ReportInput {operationId:string;attemptId:string;leaseVersion:number;message:string;references:ContentReference[]}
export interface FailedReportInput extends ReportInput {failureReason:string}
export interface ConfirmationInput extends ReportInput {outcome:ConfirmationOutcome;externalOperationId?:string}
export interface RestartInput {operationId:string;attemptId:string;leaseVersion:number;confirmationOperationId:string}
export type ReportCommand=ExecutionQuery&(
 {action:'progress'|'completed';input:ReportInput}|
 {action:'failed';input:FailedReportInput}|
 {action:'reconcile';input:ConfirmationInput}|
 {action:'restart';input:RestartInput});
export type AttemptState='running'|'ended'|'interrupted';
export interface ExecutionAttempt {
 attemptId:string;issueId:string;projectId:string;principalId:string;startOperationId:string;
 startedAt:number;updatedAt:number;expiresAt:number;leaseVersion:number;storedState:AttemptState;state:AttemptState;
 endedAt:number|null;endReason:'released'|'disconnected'|'expired'|null;renewIntervalSeconds:number;leaseSeconds:number;
}
export interface ExecutionReport {
 sequence:number;principalId:string;operationId:string;issueId:string;projectId:string;attemptId:string;
 kind:'progress'|'failed'|'completed'|'imported';message:string;failureReason:string|null;references:ContentReference[];recordedAt:number;
}
export interface ExecutionConfirmation {
 sequence:number;principalId:string;operationId:string;issueId:string;projectId:string;attemptId:string;leaseVersion:number;
 outcome:ConfirmationOutcome;externalOperationId:string|null;references:ContentReference[];message:string;recordedAt:number;newAttemptId:string|null;
}
export interface ReconciliationSnapshot {confirmation:ExecutionConfirmation;importedReport:ExecutionReport|null;nextAction:'remain_interrupted'|'restart'|'existing_result_imported';execution:ExecutionAttempt}
export interface RestartSnapshot {attempt:ExecutionAttempt;confirmation:ExecutionConfirmation;nextAction:'execute_new_attempt'}
export type ReportSnapshot=ExecutionReport|ReconciliationSnapshot|RestartSnapshot;
export interface ExecutionReports {execution:ExecutionAttempt|null;reports:ExecutionReport[];confirmations:ExecutionConfirmation[]}
export interface ReportHistory {events:{sequence:number;principalId:string;operationId:string;attemptId:string;kind:`execution-report.${ReportAction}`;recordedAt:number;snapshot:ReportSnapshot}[];nextAfter:number|null}
export interface Execution {
 current(query:ExecutionQuery):Promise<ReadOutcome<ExecutionAttempt|null>>;
 change(command:ExecutionCommand,fence?:StoredOperationFence):Promise<ChangeOutcome<ExecutionAttempt,ExecutionAttempt|null>>;
 result(query:OperationQuery):Promise<ResultOutcome<ExecutionAttempt>>;
 reports(query:ExecutionQuery):Promise<ReadOutcome<ExecutionReports>>;
 reportHistory(query:ExecutionQuery&{after:number}):Promise<ReadOutcome<ReportHistory>>;
 report(command:ReportCommand,fence?:StoredOperationFence):Promise<ChangeOutcome<ReportSnapshot,ExecutionReports>>;
 reportResult(query:OperationQuery):Promise<ResultOutcome<ReportSnapshot>>;
}
