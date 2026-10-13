// @module execution
// @role persistence-contract
import type {StoredOperationFence} from '../prepared-operations';
import type {ExecutionPlanningState,ExecutionPlan,ReportPlan} from './rules';
import type {ReadOutcome,ResultOutcome,ChangeOutcome} from "../change-outcomes";
import type {ExecutionQuery,OperationQuery,ExecutionCommand,ReportCommand,ExecutionAttempt,ExecutionReports,ReportHistory,ReportSnapshot} from './public';
/** Bound to one verified actor. Implementations recheck current authority at every disclosure and commit.
 * Commit is one atomic change+history+receipt, including current assignment/head/lease/confirmation.
 * An observed planning state is never authorization; no arbitrary SQL/callback crosses this port. */
export type PlanningObservation<T,C>={status:'state';state:ExecutionPlanningState}|{status:'outcome';outcome:ChangeOutcome<T,C>};
export interface ExecutionPersistence {
 readCurrent(query:ExecutionQuery):Promise<ReadOutcome<ExecutionAttempt|null>>;
 readReports(query:ExecutionQuery):Promise<ReadOutcome<ExecutionReports>>;
 readHistory(query:ExecutionQuery&{after:number}):Promise<ReadOutcome<ReportHistory>>;
 readExecutionResult(query:OperationQuery):Promise<ResultOutcome<ExecutionAttempt>>;
 readReportResult(query:OperationQuery):Promise<ResultOutcome<ReportSnapshot>>;
 inspectExecution(command:ExecutionCommand):Promise<PlanningObservation<ExecutionAttempt,ExecutionAttempt|null>>;
 inspectReport(command:ReportCommand):Promise<PlanningObservation<ReportSnapshot,ExecutionReports>>;
 rejectExecution(command:ExecutionCommand,reason:string):Promise<ChangeOutcome<ExecutionAttempt,ExecutionAttempt|null>>;
 rejectReport(command:ReportCommand,reason:string):Promise<ChangeOutcome<ReportSnapshot,ExecutionReports>>;
 commitExecution(command:ExecutionCommand,plan:ExecutionPlan,fence?:StoredOperationFence):Promise<ChangeOutcome<ExecutionAttempt,ExecutionAttempt|null>>;
 commitReport(command:ReportCommand,plan:ReportPlan,fence?:StoredOperationFence):Promise<ChangeOutcome<ReportSnapshot,ExecutionReports>>;
}
