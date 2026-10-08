import {WORKFLOW_COMMANDS,validateWorkflow,executeWorkflowCommand} from './agent-workflow.mjs';
export {queryClaim,queryResolutionRecords,queryCapabilities,queryAttemptCheckpoint,queryIssueAlias} from './agent-workflow.mjs';
import { CONTENT_COMMANDS, validateContent, executeContentCommand, issueProjection, captureAccess } from './issue-content.mjs';
import { currentRead, currentWrite, receiptScope } from './resource-access.mjs';
export { currentRead, currentWrite, historicRead, receiptScope } from './resource-access.mjs';
export { queryProjects, queryIssueEntries, queryContentRevisions, queryArchiveRecord } from './issue-content.mjs';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
export const HASH_VERSION='command-json-v1';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const validId=x=>typeof x==='string'&&uuid.test(x);
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
export const failure=(code,outcome='unknown')=>({error:{code,outcome,retryable:code==='UNAVAILABLE',...(outcome==='unknown'?{}:{effectApplied:false})}});
export function validate(c){
  if(!plain(c))return 'VALIDATION';
  const keys=['schemaVersion','workspaceId','workspaceEpoch','operationId','commandType','entityId','expectedVersion','payload'];
  if(Object.keys(c).some(k=>!keys.includes(k)))return 'VALIDATION';
  if(c.schemaVersion!==1)return 'SCHEMA_UNSUPPORTED';
  if(!['workspaceId','workspaceEpoch','operationId','entityId'].every(k=>validId(c[k]))||!['Issue.UpdateTitle',...CONTENT_COMMANDS,...WORKFLOW_COMMANDS].includes(c.commandType))return 'VALIDATION';
  if(c.expectedVersion===undefined)return 'PRECONDITION_REQUIRED';
  if(WORKFLOW_COMMANDS.includes(c.commandType))return validateWorkflow(c);
  if(CONTENT_COMMANDS.includes(c.commandType))return validateContent(c);
  if(!Number.isSafeInteger(c.expectedVersion)||c.expectedVersion<1)return 'VALIDATION';
  if(!plain(c.payload)||Object.keys(c.payload).length!==1||typeof c.payload.title!=='string'||!c.payload.title.isWellFormed()||Buffer.byteLength(c.payload.title)>4096)return 'VALIDATION';
  return null;
}
export function canonical(value){
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(plain(value))return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
export function fingerprint(actor,c){return createHash('sha256').update(canonical({hashVersion:HASH_VERSION,principalId:actor.principalId,command:c})).digest('hex');}
const get=(db,sql,...args)=>db.prepare(sql).get(...args);
const run=(db,sql,...args)=>db.prepare(sql).run(...args);
function one(db,sql,...args){const result=run(db,sql,...args);if(result.changes!==1)throw new Error('Required write count invariant violated');return result;}
export function authorized(db,actor,workspaceId,epoch,now){
  const w=get(db,'SELECT * FROM workspace WHERE id=?',workspaceId);
  if(!w||actor?.workspaceId!==workspaceId)return 'WORKSPACE_MISMATCH';
  if(!w.active)return 'STORE_FENCED';
  if(epoch!==w.epoch)return 'EPOCH_MISMATCH';
  if(!validId(actor.principalId)||!validId(actor.credentialId)||!Number.isSafeInteger(actor.credentialExpiresAt))return 'UNAUTHENTICATED';
  const cred=get(db,'SELECT * FROM credential WHERE id=? AND principal_id=?',actor.credentialId,actor.principalId);
  const member=get(db,'SELECT * FROM membership WHERE principal_id=?',actor.principalId);
  if(!cred||!member||member.kind!==actor.actorKind)return 'UNAUTHENTICATED';
  if(now>=actor.credentialExpiresAt||now>=cred.expires_at)return 'EXPIRED';
  if(cred.revoked||member.revoked)return 'FORBIDDEN';
  return null;
}
export function resourceReadable(db,actor,issueId){
 return currentRead(db,actor,{type:'issue',id:issueId});
}
function can(db,actor,project,mode){
 const cred=get(db,'SELECT * FROM credential WHERE id=?',actor.credentialId);
 const grant=get(db,'SELECT * FROM project_grant WHERE principal_id=? AND project_id=?',actor.principalId,project);
 return Boolean(cred?.['can_'+mode]&&grant?.['can_'+mode]);
}
function visibleReceipt(db,actor,row){
 const scoped=receiptScope(db,actor,row);if(scoped!==null)return scoped;
 if(!get(db,'SELECT read_own FROM membership WHERE principal_id=?',actor.principalId)?.read_own)return false;
 const current=get(db,'SELECT * FROM issue WHERE id=?',row.entity_id);
 if(row.project_at_commit===null)return Boolean(get(db,'SELECT can_read FROM credential WHERE id=?',actor.credentialId)?.can_read);
 return Boolean(current&&!current.deleted&&resourceReadable(db,actor,current.id)&&can(db,actor,current.project_id,'read')&&can(db,actor,row.project_at_commit,'read'));
}
export class StorageFailure extends Error {
 constructor(outcome){super('Storage operation failed');this.outcome=outcome;}
}
export function transaction(db,fn){
 if(db.transactionSync)return db.transactionSync(fn);
 try{db.exec('BEGIN IMMEDIATE');}catch{throw new StorageFailure('not_committed');}
 try{const result=fn();db.exec('COMMIT');return result;}
 catch{try{db.exec('ROLLBACK');}catch{throw new StorageFailure('unknown');}throw new StorageFailure('not_committed');}
}
export const MUTATION_STEPS=['before_issue','after_issue','after_sequence','after_activity','after_fts_delete','after_fts_insert','after_outbox','after_receipt'];
export function executeCommand(db,actor,c,{now,fault=()=>{},contentLinks=null}={}){
 const invalid=validate(c);if(invalid)return failure(invalid);
 if(!actor||typeof actor!=='object')return failure('UNAUTHENTICATED');
 if(WORKFLOW_COMMANDS.includes(c.commandType))return executeWorkflowCommand(db,actor,c,{now,fault});
 if(CONTENT_COMMANDS.includes(c.commandType))return executeContentCommand(db,actor,c,{now,fault,contentLinks});
 const hash=fingerprint(actor,c);
 return transaction(db,()=>{
  fault('before_authorization');
  now ??= Date.now(); // Observe expiry after acquiring the SQLite write lock.
  const denied=authorized(db,actor,c.workspaceId,c.workspaceEpoch,now);if(denied)return failure(denied,'unknown');
  const old=get(db,'SELECT * FROM operation WHERE workspace_id=? AND principal_id=? AND operation_id=?',c.workspaceId,actor.principalId,c.operationId);
  if(old){
   if(!visibleReceipt(db,actor,old))return failure('FORBIDDEN','unknown');
   if(old.hash_version!==HASH_VERSION||old.payload_hash!==hash)return failure('KEY_REUSE');
   return JSON.parse(old.result_json);
  }
  const currentCredential=get(db,'SELECT can_read,can_write FROM credential WHERE id=?',actor.credentialId);
  if(!currentCredential.can_read||!currentCredential.can_write)return failure('FORBIDDEN');
  const issue=get(db,'SELECT * FROM issue WHERE id=?',c.entityId);
  const save=(result,receiptProject=issue?.project_id??null)=>{one(db,'INSERT INTO operation VALUES(?,?,?,?,?,?,?,?)',c.workspaceId,actor.principalId,c.operationId,HASH_VERSION,hash,c.entityId,receiptProject,JSON.stringify(result));if(receiptProject&&get(db,'SELECT 1 FROM resource_access WHERE resource_type=? AND resource_id=?','issue',c.entityId)){const a=captureAccess(db,{type:'issue',id:c.entityId});one(db,'INSERT INTO operation_scope VALUES(?,?,?,?,?,?,?,0)',c.workspaceId,actor.principalId,c.operationId,'issue',c.entityId,JSON.stringify(a.originalScope),a.accessSnapshotId);}return result;};
  // No target details are returned for permission rejection.
  if(issue&&(!resourceReadable(db,actor,issue.id)||!can(db,actor,issue.project_id,'read')))return save(failure('NOT_FOUND','rejected'),null);
  // Restricted-resource write contracts are not implemented by this read-only slice.
  if(issue&&(get(db,'SELECT restricted_read FROM issue_queue WHERE issue_id=?',issue.id)?.restricted_read||!currentWrite(db,actor,{type:'issue',id:issue.id})))return save(failure('FORBIDDEN','rejected'));
  if(issue&&!can(db,actor,issue.project_id,'write'))return save(failure('FORBIDDEN','rejected'));
  if(!issue||issue.deleted)return save(failure('NOT_FOUND','rejected'),null);
  if(c.payload.title.trim().length===0)return save(failure('TITLE_EMPTY','rejected'));
  if(issue.version!==c.expectedVersion)return save(failure('VERSION_CONFLICT','rejected'));
  fault('before_issue');
  const update=run(db,'UPDATE issue SET title=?,version=version+1 WHERE id=? AND version=?',c.payload.title,c.entityId,c.expectedVersion);
  if(update.changes!==1)throw new Error('CAS invariant violated');
  fault('after_issue');
  one(db,'UPDATE workspace SET change_seq=change_seq+1 WHERE id=?',c.workspaceId);
  const seq=get(db,'SELECT change_seq FROM workspace WHERE id=?',c.workspaceId).change_seq;
  fault('after_sequence');
  one(db,'INSERT INTO activity VALUES(?,?,?,?,?,?,?)',seq,c.entityId,c.operationId,actor.principalId,issue.title,c.payload.title,issue.version+1);
  fault('after_activity');
  run(db,'DELETE FROM issue_fts WHERE issue_id=?',c.entityId);fault('after_fts_delete');
  one(db,'INSERT INTO issue_fts(issue_id,title) VALUES(?,?)',c.entityId,c.payload.title.normalize('NFKC').toLowerCase());fault('after_fts_insert');
  one(db,'INSERT INTO outbox VALUES(?,?,?,?)',`${actor.principalId}:${c.operationId}`,seq,JSON.stringify({issueId:c.entityId,version:issue.version+1}),'pending');fault('after_outbox');
  const result=save({data:{outcome:'committed',effectApplied:true,entityId:c.entityId,committedVersion:issue.version+1,commitSeq:seq,serverTime:now},meta:{workspaceId:c.workspaceId,actorId:actor.principalId,operationId:c.operationId}});
  fault('after_receipt');return result;
 });
}
export function operationGet(db,actor,{workspaceId,workspaceEpoch,operationId},now){
 if(![workspaceId,workspaceEpoch,operationId].every(validId))return failure('VALIDATION');
 return transaction(db,()=>{now ??= Date.now();const denied=authorized(db,actor,workspaceId,workspaceEpoch,now);if(denied)return failure(denied,'unknown');
 const row=get(db,'SELECT * FROM operation WHERE workspace_id=? AND principal_id=? AND operation_id=?',workspaceId,actor.principalId,operationId);
 if(!row)return {data:{outcome:'not_observed',absenceIsProofOfNonExecution:false}};
 return visibleReceipt(db,actor,row)?JSON.parse(row.result_json):failure('FORBIDDEN','unknown');});
}
export function queryIssues(db,actor,{workspaceId,workspaceEpoch,entityId},now){
 if(!validId(workspaceId)||!validId(workspaceEpoch)||(entityId!==undefined&&!validId(entityId)))return failure('VALIDATION');
 return transaction(db,()=>{now ??= Date.now();const denied=authorized(db,actor,workspaceId,workspaceEpoch,now);if(denied)return failure(denied,'unknown');
 if(!get(db,'SELECT can_read FROM credential WHERE id=?',actor.credentialId)?.can_read)return failure('FORBIDDEN');
 const rows=db.prepare('SELECT * FROM issue WHERE deleted=0 ORDER BY id').all().filter(r=>resourceReadable(db,actor,r.id)&&can(db,actor,r.project_id,'read'));
 if(entityId){const row=rows.find(r=>r.id===entityId);return row?{data:issueProjection(db,row)}:failure('NOT_FOUND');}
 return {data:{items:rows.map(row=>issueProjection(db,row)),nextCursor:null}};});
}
