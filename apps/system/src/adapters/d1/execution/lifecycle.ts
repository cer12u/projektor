// @module execution
// @role private-d1
import type {AuthDB} from "../primitives";
import type {Authenticated} from "../identity/authorization";
import {validateIssueIdentity as validateIssueRoute,issueVisibleSql,issueAssignedSql} from "../work/transaction";
import {executionPermissions,executionKinds,observeExecutionAttempt,EXECUTION_INPUT_LIMIT,EXECUTION_LEASE_SECONDS,EXECUTION_RENEW_SECONDS} from "../../../modules/execution/rules";
import type {ExecutionPlan,AttemptExpectation,ExecutionPlanningState} from '../../../modules/execution/rules';
import type {ExecutionCommand,ExecutionAttempt} from "../../../modules/execution/public";
export type {ExecutionAction} from "../../../modules/execution/public";
import {currentCredentialSql,currentPermissionsSql} from "../identity/authorization";
import {readMutationReceipt,type Json,type CheckedWrite,type MutationAdapter,type MutationCommand,type MutationReceipt,type MutationTarget,type ReadPolicyFor} from "../persistence/transaction";
import {MutationError} from "../persistence/public";
import {sql,type Sql} from "../primitives";
import { digest } from "../../crypto/sha256";

const kinds=executionKinds;
const visible=(t:MutationTarget)=>issueVisibleSql(sql('?',t.projectId),sql('?',t.targetId));
const assigned=(auth:Authenticated,projectId:string,issueId:string)=>issueAssignedSql(sql('?',projectId),sql('?',issueId),sql('?',auth.id));
export function executionPolicies(projectId:string):ReadPolicyFor {
  return kind=>kinds.includes(kind)?{visible:t=>t.projectId===projectId?visible(t):sql('0')}:undefined;
}
/** P4-02 must put this predicate in its own common mutation batch, never check then write. */
export function liveExecutionSql(auth:Authenticated,projectId:string,issueId:string,attemptId:string):Sql {
  const credential=currentCredentialSql(auth),rights=currentPermissionsSql(auth,projectId,['view','execute']),assignment=assigned(auth,projectId,issueId);
  return sql(`(${credential.text}) AND (${rights.text}) AND (${assignment.text}) AND EXISTS(
    SELECT 1 FROM issue_execution_heads h JOIN issue_execution_attempts a ON a.attempt_id=h.attempt_id
    WHERE h.issue_id=? AND a.issue_id=h.issue_id AND a.project_id=? AND a.attempt_id=? AND a.principal_id=?
    AND a.state='running' AND a.expires_at>unixepoch())`,...credential.values,...rights.values,...assignment.values,issueId,projectId,attemptId,auth.id);
}
function attemptJson(alias:string,observed:boolean):string {
  const a=alias;
  return `json_object('attemptId',${a}.attempt_id,'issueId',${a}.issue_id,'projectId',${a}.project_id,
    'principalId',${a}.principal_id,'startOperationId',${a}.start_operation_id,'startedAt',${a}.started_at,
    'updatedAt',${a}.updated_at,'expiresAt',${a}.expires_at,'leaseVersion',${a}.lease_version,
    'storedState',${a}.state,'state',${observed?`CASE WHEN ${a}.state='running' AND ${a}.expires_at<=unixepoch() THEN 'interrupted' ELSE ${a}.state END`:`${a}.state`},
    'endedAt',${observed?`CASE WHEN ${a}.state='running' AND ${a}.expires_at<=unixepoch() THEN ${a}.expires_at ELSE ${a}.ended_at END`:`${a}.ended_at`},
    'endReason',${observed?`CASE WHEN ${a}.state='running' AND ${a}.expires_at<=unixepoch() THEN 'expired' ELSE ${a}.end_reason END`:`${a}.end_reason`},
    'renewIntervalSeconds',${EXECUTION_RENEW_SECONDS},'leaseSeconds',${EXECUTION_LEASE_SECONDS})`;
}
export const executionCurrentSql=(t:MutationTarget,observed=true)=>sql(`SELECT ${attemptJson('a',observed)} FROM issue_execution_heads h
  JOIN issue_execution_attempts a ON a.attempt_id=h.attempt_id WHERE h.issue_id=? AND a.project_id=?`,t.targetId,t.projectId);
const current=executionCurrentSql;

/** Trusted P4-02 extension only: no new public acquire input or authority. */
export interface ConfirmedExecutionRecovery {
  attemptId:string; leaseVersion:number; storedState:'running'|'interrupted';
  confirmation:Sql; recordUse:CheckedWrite;
}

/** SQL compilation consumes a domain-selected plan; it never chooses a transition by reading state. */
export async function compileExecution(auth:Authenticated,commandInput:ExecutionCommand,plan:ExecutionPlan,recovery?:ConfirmedExecutionRecovery) {
  const {projectId,issueId,action,input}=commandInput;
  if(plan.action!==action)throw new Error('execution_plan_mismatch');
  const attemptId=action==='acquire'?'A_'+await digest(JSON.stringify([auth.id,input.operationId])):(input as {attemptId:string}).attemptId;
  const leaseVersion='leaseVersion' in input?input.leaseVersion:0;
  const command:MutationCommand={operationId:input.operationId,kind:'execution.'+action,targetId:issueId,projectId,input:input as unknown as Json};
  const selected=sql(`SELECT ${attemptJson('a',false)} FROM issue_execution_attempts a WHERE a.attempt_id=? AND a.issue_id=? AND a.project_id=?`,attemptId,issueId,projectId);
  const owns=sql(`EXISTS(SELECT 1 FROM issue_execution_heads h JOIN issue_execution_attempts a ON a.attempt_id=h.attempt_id
    WHERE h.issue_id=? AND a.issue_id=h.issue_id AND a.project_id=? AND a.attempt_id=? AND a.principal_id=? AND a.lease_version=? AND a.state='running')`,
    issueId,projectId,attemptId,auth.id,leaseVersion);
  const adapter:MutationAdapter={commandPolicy:{canonicalMaxBytes:EXECUTION_INPUT_LIMIT},permissions:executionPermissions,visible,current,
    preconditions:()=>[
      {reason:'assignment_conflict',valid:assigned(auth,projectId,issueId)},
      {reason:recovery?'recovery_head_conflict':action==='acquire'?'execution_unavailable':'attempt_conflict',valid:expectedHeadSql(projectId,issueId,plan.expectedHead)},
      ...('timing' in plan?[{reason:'lease_expired',valid:expectedTimingSql(plan.expectedHead,plan.timing)}]:[]),
      ...(action==='acquire'?(recovery?[
        {reason:'recovery_head_conflict',valid:sql(`EXISTS(SELECT 1 FROM issue_execution_heads h JOIN issue_execution_attempts a ON a.attempt_id=h.attempt_id
          WHERE h.issue_id=? AND a.issue_id=h.issue_id AND a.project_id=? AND a.attempt_id=? AND a.lease_version=? AND a.state=?
          AND (a.state='interrupted' OR a.expires_at<=unixepoch()))`,issueId,projectId,recovery.attemptId,recovery.leaseVersion,recovery.storedState)},
        {reason:'confirmation_conflict',valid:recovery.confirmation}
      ]:[{reason:'execution_unavailable',valid:sql(`NOT EXISTS(SELECT 1 FROM issue_execution_heads h
        JOIN issue_execution_attempts a ON a.attempt_id=h.attempt_id WHERE h.issue_id=? AND a.state<>'ended')`,issueId)}]):[
        {reason:'attempt_conflict',valid:owns},
        ...(action==='interrupt'?[]:[{reason:'lease_expired',valid:liveExecutionSql(auth,projectId,issueId,attemptId)}]),
        ...(action==='renew'?[{reason:'renew_too_early',valid:sql(`EXISTS(SELECT 1 FROM issue_execution_attempts WHERE attempt_id=? AND updated_at<=unixepoch()-${EXECUTION_RENEW_SECONDS})`,attemptId)}]:[])
      ])
    ],
    updates:()=>action==='acquire'?[
      ...(recovery?.storedState==='running'?[{expectedChanges:1,statement:sql(`UPDATE issue_execution_attempts SET state='interrupted',ended_at=expires_at,
        end_reason='expired',lease_version=lease_version+1 WHERE attempt_id=? AND state='running' AND expires_at<=unixepoch() AND lease_version=?`,recovery.attemptId,recovery.leaseVersion)}]:[]),
      {expectedChanges:1,statement:sql(`INSERT INTO issue_execution_attempts(attempt_id,issue_id,project_id,principal_id,start_operation_id,
        started_at,updated_at,expires_at,lease_version,state) VALUES(?,?,?,?,?,unixepoch(),unixepoch(),unixepoch()+${EXECUTION_LEASE_SECONDS},1,'running')`,attemptId,issueId,projectId,auth.id,input.operationId)},
      {expectedChanges:1,statement:sql(`INSERT INTO issue_execution_heads(issue_id,attempt_id) VALUES(?,?)
        ON CONFLICT(issue_id) DO UPDATE SET attempt_id=excluded.attempt_id`,issueId,attemptId)},
      ...(recovery?[recovery.recordUse]:[])
    ]:[{expectedChanges:1,statement:action==='renew'?sql(`UPDATE issue_execution_attempts SET updated_at=unixepoch(),expires_at=unixepoch()+${EXECUTION_LEASE_SECONDS},lease_version=lease_version+1
        WHERE attempt_id=? AND state='running' AND expires_at>unixepoch() AND updated_at<=unixepoch()-${EXECUTION_RENEW_SECONDS} AND lease_version=?`,attemptId,leaseVersion):
      sql(`UPDATE issue_execution_attempts SET state=?,ended_at=${plan.action==='interrupt'&&plan.timing==='expired'?'expires_at':'unixepoch()'},
        end_reason=${action==='interrupt'?(plan.action==='interrupt'&&plan.timing==='expired'?"'expired'":"'disconnected'"): "'released'"},lease_version=lease_version+1
        WHERE attempt_id=? AND state='running' AND lease_version=? ${action==='end'?'AND expires_at>unixepoch()':''}`,
        action==='end'?'ended':'interrupted',attemptId,leaseVersion)}],
    history:()=>[{expectedChanges:1,statement:sql(`INSERT INTO issue_execution_events(principal_id,operation_id,attempt_id,event_kind,recorded_at,snapshot)
      SELECT ?,?,?,?,unixepoch(),(${selected.text})`,auth.id,input.operationId,attemptId,command.kind,...selected.values)}],
    snapshot:()=>selected
  };
  return {command,adapter,policyFor:executionPolicies(projectId)};
}
export async function getExecution(db:AuthDB,auth:Authenticated,projectId:string,issueId:string,requireExecute=false):Promise<ExecutionAttempt|null> {
  validateIssueRoute(projectId,issueId);
  const t={kind:'execution.acquire',targetId:issueId,projectId},credential=currentCredentialSql(auth),rights=currentPermissionsSql(auth,projectId,requireExecute?['view','execute']:['view']),target=visible(t),data=executionCurrentSql(t,false);
  const q=sql(`SELECT unixepoch() AS observedAt,(${credential.text}) AS authenticated,(${rights.text}) AND (${target.text}) AS permitted,
    CASE WHEN (${credential.text}) AND (${rights.text}) AND (${target.text}) THEN COALESCE((${data.text}),'null') ELSE NULL END AS snapshot`,
    ...credential.values,...rights.values,...target.values,...credential.values,...rights.values,...target.values,...data.values);
  const row=await db.prepare(q.text).bind(...q.values).first<{observedAt:number;authenticated:number;permitted:number;snapshot:string|null}>();
  if(!row?.authenticated)throw new MutationError(401,'unauthenticated');
  if(!row.permitted||row.snapshot===null)throw new MutationError(403,'forbidden');
  return observeExecutionAttempt(JSON.parse(row.snapshot) as ExecutionAttempt|null,row.observedAt);
}
export async function readExecutionResult(db:AuthDB,auth:Authenticated,projectId:string,operationId:string):Promise<MutationReceipt> {
  validateIssueRoute(projectId);
  return readMutationReceipt(db,auth,operationId,executionPolicies(projectId));
}

/** Exact observed head and timing are compared again inside the write batch. */
export function expectedHeadSql(projectId:string,issueId:string,head:AttemptExpectation|null):Sql {
 if(!head)return sql('NOT EXISTS(SELECT 1 FROM issue_execution_heads WHERE issue_id=?)',issueId);
 return sql(`EXISTS(SELECT 1 FROM issue_execution_heads h JOIN issue_execution_attempts a ON a.attempt_id=h.attempt_id WHERE h.issue_id=? AND a.issue_id=h.issue_id AND a.project_id=? AND a.attempt_id=? AND a.principal_id=? AND a.lease_version=? AND a.state=? AND a.expires_at=? AND a.updated_at=?)`,issueId,projectId,head.attemptId,head.principalId,head.leaseVersion,head.storedState,head.expiresAt,head.updatedAt);
}
export function expectedTimingSql(head:AttemptExpectation,timing:'live'|'expired'):Sql {
 return sql(`EXISTS(SELECT 1 FROM issue_execution_attempts WHERE attempt_id=? AND expires_at ${timing==='live'?'>':'<='} unixepoch())`,head.attemptId);
}
/** One guarded metadata observation: no titles/bodies, no authority cached beyond this read. */
export async function inspectExecutionState(db:AuthDB,auth:Authenticated,projectId:string,issueId:string,includeReports:boolean):Promise<ExecutionPlanningState>{
 const credential=currentCredentialSql(auth),rights=currentPermissionsSql(auth,projectId,['view','execute']),target=visible({kind:'execution.acquire',projectId,targetId:issueId}),assignment=assigned(auth,projectId,issueId),head=executionCurrentSql({kind:'execution.acquire',projectId,targetId:issueId},false);
 const reportFacts=includeReports?sql(`json_object('finalReportExists',json(CASE WHEN EXISTS(SELECT 1 FROM issue_execution_reports WHERE attempt_id=(SELECT attempt_id FROM issue_execution_heads WHERE issue_id=?) AND report_kind IN ('completed','imported')) THEN 'true' ELSE 'false' END),
 'latestConfirmation',json((SELECT json_object('sequence',c.sequence,'principalId',c.principal_id,'operationId',c.operation_id,'attemptId',c.attempt_id,'leaseVersion',c.lease_version,'outcome',c.outcome,'used',json(CASE WHEN EXISTS(SELECT 1 FROM issue_execution_confirmation_uses u WHERE u.principal_id=c.principal_id AND u.confirmation_operation_id=c.operation_id) THEN 'true' ELSE 'false' END)) FROM issue_execution_confirmations c WHERE c.attempt_id=(SELECT attempt_id FROM issue_execution_heads WHERE issue_id=?) ORDER BY c.sequence DESC LIMIT 1)))`,issueId,issueId):sql(`json_object('finalReportExists',json('false'),'latestConfirmation',NULL)`);
 const q=sql(`SELECT (${credential.text}) authenticated,(${rights.text}) AND (${target.text}) permitted,
 CASE WHEN (${credential.text}) AND (${rights.text}) AND (${target.text}) THEN json_object('actorId',?,'observedAt',unixepoch(),'assignedToActor',json(CASE WHEN (${assignment.text}) THEN 'true' ELSE 'false' END),'head',json((${head.text})),'reports',json(${reportFacts.text})) ELSE NULL END snapshot`,...credential.values,...rights.values,...target.values,...credential.values,...rights.values,...target.values,auth.id,...assignment.values,...head.values,...reportFacts.values);
 const row=await db.prepare(q.text).bind(...q.values).first<{authenticated:number;permitted:number;snapshot:string|null}>();
 if(!row?.authenticated)throw new MutationError(401,'unauthenticated');
 if(!row.permitted||row.snapshot===null)throw new MutationError(403,'forbidden');
 const value=JSON.parse(row.snapshot) as Omit<ExecutionPlanningState,'finalReportExists'|'latestConfirmation'>&{reports:Pick<ExecutionPlanningState,'finalReportExists'|'latestConfirmation'>};
 const {reports,...state}=value;return {...state,...reports};
}
