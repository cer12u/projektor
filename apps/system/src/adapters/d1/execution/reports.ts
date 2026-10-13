// @module execution
// @role private-d1
import type {AuthDB} from "../primitives";
import type {Authenticated} from "../identity/authorization";
import { executionCurrentSql,liveExecutionSql,compileExecution,expectedHeadSql,expectedTimingSql } from "./lifecycle";
import {validateIssueIdentity as validateIssueRoute,issueVisibleSql,issueAssignedSql} from "../work/transaction";
import {executionPermissions,reportKinds,EXECUTION_INPUT_LIMIT} from "../../../modules/execution/rules";
import type {ReportPlan} from '../../../modules/execution/rules';
import type {ReportCommand,ReportInput,FailedReportInput,ExecutionReports,ReportHistory} from "../../../modules/execution/public";
export type {ReportAction} from "../../../modules/execution/public";
import {currentCredentialSql,currentPermissionsSql} from "../identity/authorization";
import {readMutationReceipt,type MutationAdapter,type MutationCommand,type MutationTarget,type ReadPolicyFor} from "../persistence/transaction";
import {MutationError,type Json} from "../persistence/public";
import {sql,type Sql} from "../primitives";
import { digest } from "../../crypto/sha256";

const kinds=reportKinds;
const visible=(t:MutationTarget)=>issueVisibleSql(sql('?',t.projectId),sql('?',t.targetId));
const assigned=(auth:Authenticated,project:string,issue:string)=>issueAssignedSql(sql('?',project),sql('?',issue),sql('?',auth.id));
export function reportPolicies(projectId:string):ReadPolicyFor {
  return kind=>kinds.includes(kind)?{visible:t=>t.projectId===projectId?visible(t):sql('0')}:undefined;
}
function reportJson(a:string):string {return `json_object('sequence',${a}.sequence,'principalId',${a}.principal_id,'operationId',${a}.operation_id,
  'issueId',${a}.issue_id,'projectId',${a}.project_id,'attemptId',${a}.attempt_id,'kind',${a}.report_kind,'message',${a}.message,
  'failureReason',${a}.failure_reason,'references',json(${a}.references_json),'recordedAt',${a}.recorded_at)`;}
function confirmationJson(a:string):string {return `json_object('sequence',${a}.sequence,'principalId',${a}.principal_id,'operationId',${a}.operation_id,
  'issueId',${a}.issue_id,'projectId',${a}.project_id,'attemptId',${a}.attempt_id,'leaseVersion',${a}.lease_version,'outcome',${a}.outcome,
  'externalOperationId',${a}.external_operation_id,'references',json(${a}.references_json),'message',${a}.message,'recordedAt',${a}.recorded_at,
  'newAttemptId',(SELECT u.new_attempt_id FROM issue_execution_confirmation_uses u WHERE u.principal_id=${a}.principal_id AND u.confirmation_operation_id=${a}.operation_id))`;}
const current=(t:MutationTarget):Sql=>{
  const execution=executionCurrentSql(t);
  return sql(`SELECT json_object('execution',json((${execution.text})),
    'reports',json((SELECT json_group_array(json(entry)) FROM (SELECT ${reportJson('r')} entry FROM issue_execution_reports r
      WHERE r.issue_id=? AND r.project_id=? AND r.attempt_id=(SELECT attempt_id FROM issue_execution_heads WHERE issue_id=?) ORDER BY r.sequence DESC LIMIT 50))),
    'confirmations',json((SELECT json_group_array(json(entry)) FROM (SELECT ${confirmationJson('c')} entry FROM issue_execution_confirmations c
      WHERE c.issue_id=? AND c.project_id=? AND c.attempt_id=(SELECT attempt_id FROM issue_execution_heads WHERE issue_id=?) ORDER BY c.sequence DESC LIMIT 50))))`,
    ...execution.values,t.targetId,t.projectId,t.targetId,t.targetId,t.projectId,t.targetId);
};
const noFinal=(attemptId:string)=>sql("NOT EXISTS(SELECT 1 FROM issue_execution_reports WHERE attempt_id=? AND report_kind IN ('completed','imported'))",attemptId);
const event=(auth:Authenticated,project:string,issue:string,attempt:string,op:string,kind:string,snapshot:Sql)=>({expectedChanges:1,
  statement:sql(`INSERT INTO issue_execution_report_events(principal_id,operation_id,issue_id,attempt_id,event_kind,recorded_at,snapshot)
    SELECT ?,?,?,?,?,unixepoch(),(${snapshot.text})`,auth.id,op,issue,attempt,kind,...snapshot.values)});
const insertReport=(auth:Authenticated,project:string,issue:string,attempt:string,op:string,kind:string,input:ReportInput|FailedReportInput)=>({expectedChanges:1,
  statement:sql(`INSERT INTO issue_execution_reports(principal_id,operation_id,issue_id,project_id,attempt_id,report_kind,message,failure_reason,references_json,recorded_at)
    VALUES(?,?,?,?,?,?,?,?,?,unixepoch())`,auth.id,op,issue,project,attempt,kind,input.message,('failureReason' in input?input.failureReason:null),JSON.stringify(input.references))});

/** Encode the already selected domain transition with transaction-time guards. */
export async function compileReport(auth:Authenticated,commandInput:ReportCommand,plan:ReportPlan) {
  const {projectId,issueId,action,input}=commandInput;
  if(plan.action!==action)throw new Error('report_plan_mismatch');
  const command:MutationCommand={operationId:input.operationId,kind:'execution-report.'+action,targetId:issueId,projectId,input:input as unknown as Json};
  const policyFor=reportPolicies(projectId);
  if(action==='restart'&&plan.action==='restart'){
    const v=input;
    const confirmation=sql(`EXISTS(SELECT 1 FROM issue_execution_confirmations c WHERE c.principal_id=? AND c.operation_id=? AND c.issue_id=? AND c.project_id=?
      AND c.attempt_id=? AND c.lease_version=? AND c.sequence=? AND c.outcome='not_performed'
      AND c.sequence=(SELECT max(sequence) FROM issue_execution_confirmations WHERE attempt_id=c.attempt_id)
      AND NOT EXISTS(SELECT 1 FROM issue_execution_confirmation_uses u WHERE u.principal_id=c.principal_id AND u.confirmation_operation_id=c.operation_id)
      AND NOT EXISTS(SELECT 1 FROM issue_execution_reports r WHERE r.attempt_id=c.attempt_id AND r.report_kind IN ('completed','imported')))`,
      auth.id,v.confirmationOperationId,issueId,projectId,v.attemptId,v.leaseVersion,plan.confirmation.sequence);
    const newAttemptId='A_'+await digest(JSON.stringify([auth.id,v.operationId]));
    const p=await compileExecution(auth,{projectId,issueId,action:'acquire',input:{operationId:v.operationId}},{action:'acquire',expectedHead:plan.expectedHead},{attemptId:v.attemptId,leaseVersion:v.leaseVersion,
      storedState:plan.markExpired?'running':'interrupted',confirmation,
      recordUse:{expectedChanges:1,statement:sql(`INSERT INTO issue_execution_confirmation_uses(principal_id,confirmation_operation_id,restart_principal_id,restart_operation_id,new_attempt_id,recorded_at)
        VALUES(?,?,?,?,?,unixepoch())`,auth.id,v.confirmationOperationId,auth.id,v.operationId,newAttemptId)}});
    const selected=p.adapter.snapshot({...p.command,principalId:auth.id,inputHash:''});
    const snapshot=sql(`SELECT json_object('attempt',json((${selected.text})),'confirmation',json((SELECT ${confirmationJson('c')} FROM issue_execution_confirmations c WHERE c.principal_id=? AND c.operation_id=?)),'nextAction','execute_new_attempt')`,...selected.values,auth.id,v.confirmationOperationId);
    const history=p.adapter.history.bind(p.adapter);
    const adapter:MutationAdapter={...p.adapter,current,snapshot:()=>snapshot,history:c=>[...history(c),event(auth,projectId,issueId,newAttemptId,input.operationId,command.kind,snapshot)]};
    return {command,adapter,policyFor};
  }
  const v=input as ReportInput,selected=sql(`SELECT ${reportJson('r')} FROM issue_execution_reports r WHERE r.principal_id=? AND r.operation_id=?`,auth.id,v.operationId);
  let adapter:MutationAdapter={commandPolicy:{canonicalMaxBytes:EXECUTION_INPUT_LIMIT},permissions:executionPermissions,visible,current,
    preconditions:()=>[{reason:'live_attempt_conflict',valid:expectedHeadSql(projectId,issueId,plan.expectedHead)},{reason:'live_attempt_conflict',valid:liveExecutionSql(auth,projectId,issueId,v.attemptId)},{reason:'report_finalized',valid:noFinal(v.attemptId)}],
    updates:()=>[insertReport(auth,projectId,issueId,v.attemptId,v.operationId,action,v)],
    history:()=>[event(auth,projectId,issueId,v.attemptId,v.operationId,command.kind,selected)],snapshot:()=>selected};
  if(action==='reconcile'&&plan.action==='reconcile'){
    const c=input;
    const mark=plan.markExpired?await compileExecution(auth,{projectId,issueId,action:'interrupt',input:{operationId:c.operationId,attemptId:c.attemptId,leaseVersion:c.leaseVersion}},{action:'interrupt',expectedHead:plan.expectedHead,timing:'expired'}):null;
    const confirmation=sql(`SELECT ${confirmationJson('c')} FROM issue_execution_confirmations c WHERE c.principal_id=? AND c.operation_id=?`,auth.id,c.operationId);
    const snapshot=sql(`SELECT json_object('confirmation',json((${confirmation.text})),'importedReport',json((${selected.text})),
      'nextAction',?,'execution',json((${executionCurrentSql(command).text})))`,...confirmation.values,...selected.values,
      plan.nextAction,...executionCurrentSql(command).values);
    adapter={commandPolicy:{canonicalMaxBytes:EXECUTION_INPUT_LIMIT},permissions:executionPermissions,visible,current,
      preconditions:()=>[{reason:'assignment_conflict',valid:assigned(auth,projectId,issueId)},
        {reason:'interrupted_attempt_conflict',valid:expectedHeadSql(projectId,issueId,plan.expectedHead)},
        ...(plan.markExpired?[{reason:'interrupted_attempt_conflict',valid:expectedTimingSql(plan.expectedHead,'expired')}]:[]),
        {reason:'interrupted_attempt_conflict',valid:sql(`EXISTS(SELECT 1 FROM issue_execution_heads h JOIN issue_execution_attempts a ON a.attempt_id=h.attempt_id
          WHERE h.issue_id=? AND a.issue_id=h.issue_id AND a.project_id=? AND a.attempt_id=? AND a.lease_version=? AND a.state=?
          AND (a.state='interrupted' OR a.expires_at<=unixepoch()))`,issueId,projectId,c.attemptId,c.leaseVersion,plan.expectedHead.storedState)},
        ...(plan.importResult?[{reason:'report_finalized',valid:noFinal(c.attemptId)}]:[])],
      updates:context=>[...(mark?mark.adapter.updates(context):[]),{expectedChanges:1,statement:sql(`INSERT INTO issue_execution_confirmations(principal_id,operation_id,issue_id,project_id,attempt_id,lease_version,outcome,external_operation_id,references_json,message,recorded_at)
        SELECT ?,?,?,?,?,a.lease_version,?,?,?,?,unixepoch() FROM issue_execution_attempts a WHERE a.attempt_id=?`,auth.id,c.operationId,issueId,projectId,c.attemptId,c.outcome,c.externalOperationId??null,JSON.stringify(c.references),c.message,c.attemptId)},
        ...(plan.importResult?[insertReport(auth,projectId,issueId,c.attemptId,c.operationId,'imported',c)]:[])],
      history:context=>[...(mark?mark.adapter.history(context):[]),event(auth,projectId,issueId,c.attemptId,c.operationId,command.kind,snapshot)],snapshot:()=>snapshot};
  }
  return {command,adapter,policyFor};
}
async function readAuthorized(db:AuthDB,auth:Authenticated,project:string,issue:string,data:Sql,requireExecute=false):Promise<Json> {
  validateIssueRoute(project,issue);
  const credential=currentCredentialSql(auth),rights=currentPermissionsSql(auth,project,requireExecute?['view','execute']:['view']),target=visible({kind:'execution-report.progress',projectId:project,targetId:issue});
  const q=sql(`SELECT (${credential.text}) authenticated,(${rights.text}) AND (${target.text}) permitted,
    CASE WHEN (${credential.text}) AND (${rights.text}) AND (${target.text}) THEN (${data.text}) ELSE NULL END snapshot`,
    ...credential.values,...rights.values,...target.values,...credential.values,...rights.values,...target.values,...data.values);
  const row=await db.prepare(q.text).bind(...q.values).first<{authenticated:number;permitted:number;snapshot:string|null}>();
  if(!row?.authenticated)throw new MutationError(401,'unauthenticated');
  if(!row.permitted||row.snapshot===null)throw new MutationError(403,'forbidden');
  return JSON.parse(row.snapshot) as Json;
}
export async function getReports(db:AuthDB,auth:Authenticated,project:string,issue:string,requireExecute=false):Promise<ExecutionReports> {return await readAuthorized(db,auth,project,issue,current({kind:'execution-report.progress',targetId:issue,projectId:project}),requireExecute) as unknown as ExecutionReports;}
export async function getReportHistory(db:AuthDB,auth:Authenticated,project:string,issue:string,after:number):Promise<ReportHistory> {
  
  const data=sql(`WITH page AS(SELECT sequence,json_object('sequence',sequence,'principalId',principal_id,'operationId',operation_id,'attemptId',attempt_id,
    'kind',event_kind,'recordedAt',recorded_at,'snapshot',json(snapshot)) entry FROM issue_execution_report_events WHERE issue_id=? AND sequence>? ORDER BY sequence LIMIT 50)
    SELECT json_object('events',json((SELECT json_group_array(json(entry)) FROM page)),
    'nextAfter',CASE WHEN EXISTS(SELECT 1 FROM issue_execution_report_events WHERE issue_id=? AND sequence>COALESCE((SELECT max(sequence) FROM page),?)) THEN (SELECT max(sequence) FROM page) ELSE NULL END)`,issue,after,issue,after);
  return await readAuthorized(db,auth,project,issue,data) as unknown as ReportHistory;
}
export function readReportResult(db:AuthDB,auth:Authenticated,project:string,operationId:string) {validateIssueRoute(project);return readMutationReceipt(db,auth,operationId,reportPolicies(project));}
