// @module composition
// @role command-codec
/** Closed normalized envelopes and journal descriptions. No DB, clock, SQL or callbacks. */
import {InputError} from '../../modules/change-outcomes';
import type {OperationPreparation,OperationRoute,OperationJson,PreparedCommand,PreparedDescription} from '../../modules/prepared-operations';
import {decodeIssueChange,decodeContentChange,workPermissions,WORK_INPUT_LIMITS} from '../../modules/work/public';
import {decodeExecutionCommand,decodeReportCommand,executionPermissions,EXECUTION_INPUT_LIMIT} from '../../modules/execution/public';
export function decodePreparedCommand(value:OperationPreparation):PreparedCommand {
 const invalid=()=>new InputError('invalid_input',{operation:'closed business route and input required'});
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['route','input'].includes(k)))throw invalid();
 const r=value.route;
 if(!r||typeof r!=='object'||Array.isArray(r))throw invalid();
 const fields=r.kind==='execution'||r.kind==='report'?['kind','projectId','issueId','action']:['kind','projectId','id',...(r.kind==='comment'?['parentKind','parentId']:[])];
 if(Object.keys(r).some(k=>!fields.includes(k))||('id' in r&&typeof r.id!=='string'))throw invalid();
 switch(r.kind){
  case 'issue':return {kind:'issue',command:decodeIssueChange(r.projectId,r.id,value.input)};
  case 'wiki':return {kind:'content',command:decodeContentChange(r.projectId,{kind:'wiki'},r.id,value.input)};
  case 'comment':return {kind:'content',command:decodeContentChange(r.projectId,{kind:'comment',parentKind:r.parentKind,parentId:r.parentId},r.id,value.input)};
  case 'execution':return {kind:'execution',command:decodeExecutionCommand({projectId:r.projectId,issueId:r.issueId},r.action,value.input)};
  case 'report':return {kind:'report',command:decodeReportCommand({projectId:r.projectId,issueId:r.issueId},r.action,value.input)};
  default:throw invalid();
 }
}

export function describePreparedCommand(envelope:PreparedCommand):PreparedDescription {
 const c=envelope.command;
 if(envelope.kind==='execution'||envelope.kind==='report'){
  const x=envelope.command,kind=envelope.kind==='execution'?'execution.':'execution-report.';
  return {route:{kind:envelope.kind,projectId:x.projectId,issueId:x.issueId,action:x.action} as OperationRoute,input:x.input as unknown as OperationJson,
   operationId:x.input.operationId,kind:kind+x.action,projectId:x.projectId,target:{id:x.issueId},mutationInput:x.input as unknown as OperationJson,
   canonicalInputLimit:EXECUTION_INPUT_LIMIT,permissions:[...executionPermissions]};
 }
 if(envelope.kind==='issue'){
  const x=envelope.command,{operationId,...input}=x.input,kind='issue.'+x.kind;
  return {route:{kind:'issue',projectId:x.projectId,...(x.kind==='edit'?{id:x.issueId}:{})},input:x.input as unknown as OperationJson,
   operationId,kind,projectId:x.projectId,target:x.kind==='edit'?{id:x.issueId}:{prefix:'I_'},mutationInput:input as OperationJson,
   canonicalInputLimit:WORK_INPUT_LIMITS.issue,permissions:workPermissions(kind,input)};
 }
 const x=envelope.command,r=x.resource,{operationId,...input}=x.input,kind=r.kind+'.'+x.kind;
 return {route:{...r,projectId:x.projectId,...(x.kind==='edit'?{id:x.id}:{})},input:c.input as unknown as OperationJson,
  operationId,kind,projectId:x.projectId,target:x.kind==='edit'?{id:x.id}:{prefix:r.kind==='wiki'?'W_':'C_'},
  mutationInput:{...input,...(r.kind==='comment'?{parentKind:r.parentKind,parentId:r.parentId}:{})},
  canonicalInputLimit:WORK_INPUT_LIMITS[r.kind],permissions:workPermissions(kind,input)};
}
