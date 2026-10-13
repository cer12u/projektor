// @module administration
// @role model
import type {ManagementRecord,ManagementDraft,ManagementSubmission,SetupSubmission,SavedManagementEdit,PrincipalRegistration} from './management-contracts';
import {managementRecord,sameManagementTarget,historyInitialProjects} from './management-response-validation';
import {managementChange} from './management-command';
import {object,identifier,permissions} from './management-validation';
export function draftFrom(record:ManagementRecord):ManagementDraft{return{displayName:record.kind==='principal'?record.snapshot.displayName:'',active:record.kind==='principal'?record.snapshot.active===1:false,permissions:'permissions'in record.snapshot?[...record.snapshot.permissions]:[]};}
export function restoreSubmission(value:unknown):ManagementSubmission {
  const v=object(value),d=object(v.draft);if(!identifier(v.operationId)||typeof d.displayName!=='string'||typeof d.active!=='boolean'||!permissions(d.permissions))throw new Error('invalid_saved_operation');
  const r=object(v.record),record=managementRecord(r.snapshot);if(record.kind!==r.kind)throw new Error('invalid_saved_operation');
  const draft={displayName:d.displayName,active:d.active,permissions:d.permissions};managementChange(record,draft);
  return{operationId:v.operationId,record,draft};
}
export function restoreSetupSubmission(value:unknown):SetupSubmission {
 const v=object(value);
 if(Object.keys(v).some(k=>!['actorId','principalId','operationId','revision','purpose','recipientRequestId'].includes(k))||!identifier(v.actorId)||!identifier(v.principalId)||!identifier(v.operationId)||!Number.isSafeInteger(v.revision)||Number(v.revision)<1||!['initial','reset',null].includes(v.purpose as 'initial'|'reset'|null))throw new Error('invalid_setup_recovery');
 if(v.recipientRequestId!==undefined&&!identifier(v.recipientRequestId))throw new Error('invalid_setup_recovery');
 // Older pending issue markers may still recover their receipt; they cannot issue a new context-bound grant.
 return {actorId:v.actorId,principalId:v.principalId,operationId:v.operationId,revision:v.revision as number,purpose:v.purpose as 'initial'|'reset'|null,...(v.recipientRequestId!==undefined?{recipientRequestId:v.recipientRequestId}:{})};
}
export function restoreManagementEdit(value:unknown):SavedManagementEdit {
 const v=object(value),d=object(v.draft),pending=v.pending?restoreSubmission(v.pending):null;
 const raw=object(v.record??pending?.record),record=managementRecord(raw.snapshot);
 if(raw.kind!==record.kind||typeof d.displayName!=='string'||typeof d.active!=='boolean'||!permissions(d.permissions)||typeof v.operationId!=='string'||(v.operationId!==''&&!identifier(v.operationId)))throw new Error('invalid_saved_draft');
 if(pending&&(!sameManagementTarget(pending.record,record)||pending.operationId!==v.operationId))throw new Error('invalid_saved_draft');
 const setupPending=v.setupPending===undefined||v.setupPending===null?null:restoreSetupSubmission(v.setupPending);
 if(setupPending&&(pending||record.kind!=='principal'||record.snapshot.kind!=='human'||setupPending.principalId!==record.snapshot.principalId))throw new Error('invalid_setup_recovery');
 return{setupPending,operationId:v.operationId,record,draft:{displayName:d.displayName,active:d.active,permissions:[...d.permissions]},pending};
}
export function restoreRegistrationDraft(value:unknown):PrincipalRegistration {
 const v=object(value);
 if(Object.keys(v).some(k=>!['operationId','principalId','kind','displayName','loginId','projects'].includes(k))||!identifier(v.operationId)||typeof v.principalId!=='string'||!['human','agent'].includes(v.kind as string)||typeof v.displayName!=='string'||(v.kind==='human'?typeof v.loginId!=='string':v.loginId!==null))throw new Error('invalid_registration_draft');
 return{operationId:v.operationId,principalId:v.principalId,kind:v.kind as 'human'|'agent',displayName:v.displayName,loginId:v.loginId as string|null,projects:historyInitialProjects(v.projects)};
}
