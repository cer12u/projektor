// @module identity
// @role private-d1
import type {AuthDB} from '../primitives';
import {sql} from '../primitives';
import {guardedBatch} from '../persistence/guarded-batch';
import {ApiError} from '../../protocol-errors';
import type {RecipientContextCommit,RecipientPasswordCommit} from '../../../modules/identity/ports';
import type {RecipientSetupStatus,SetupPurpose} from '../../../modules/identity/public';
import {preparePasswordSetupValue,commitPasswordSetup} from './password-setup-completion';
const invalid=()=>new ApiError(403,'recipient_setup_unavailable');
export function recipientContextStore(db:AuthDB){
 async function status(hash:string,csrf:string):Promise<RecipientSetupStatus>{
  const context=await db.prepare('SELECT request_id requestId,expires_at expiresAt,right_id rightId FROM recipient_setup_contexts WHERE context_hash=? AND csrf_hash=? AND revoked_at IS NULL AND expires_at>unixepoch()').bind(hash,csrf).first<{requestId:string;expiresAt:number;rightId:string|null}>();
  if(!context)throw invalid();
  if(context.rightId===null)return{requestId:context.requestId,state:'waiting',expiresAt:context.expiresAt};
  const row=await db.prepare(`SELECT rc.request_id requestId,min(rc.expires_at,r.expires_at) expiresAt,rc.principal_id principalId,p.login_id loginId,p.display_name displayName,rc.purpose,rc.operation_id operationId,rc.issuer_id issuerId,rc.issuer_display_name issuerDisplayName,rc.target_auth_version targetAuthVersion,r.completed_auth_version completedAuthVersion,
   CASE WHEN r.consumed_at IS NULL THEN 'ready' ELSE 'completed' END state
   FROM recipient_setup_contexts rc JOIN password_setup_rights r ON r.id=rc.right_id JOIN principals p ON p.id=rc.principal_id JOIN password_setup_states s ON s.principal_id=p.id
   WHERE rc.context_hash=? AND rc.csrf_hash=? AND rc.revoked_at IS NULL AND rc.expires_at>unixepoch()
   AND r.principal_id=rc.principal_id AND r.purpose=rc.purpose AND r.target_auth_version=rc.target_auth_version
   AND r.revoked_at IS NULL AND r.expires_at>unixepoch() AND s.latest_right_id=r.id AND p.kind='human' AND p.active=1
   AND ((r.consumed_at IS NULL AND p.auth_version=r.target_auth_version) OR (r.consumed_at IS NOT NULL AND r.completed_operation_id=rc.operation_id AND p.auth_version=r.completed_auth_version))`).bind(hash,csrf).first<{requestId:string;expiresAt:number;principalId:string;loginId:string;displayName:string;purpose:SetupPurpose;operationId:string;issuerId:string;issuerDisplayName:string;targetAuthVersion:number;completedAuthVersion:number|null;state:'ready'|'completed'}>();
  if(!row)throw invalid();const {completedAuthVersion,...rest}=row;return{...rest,...(completedAuthVersion===null?{}:{completedAuthVersion})};
 }
 async function reserve(c:RecipientContextCommit):Promise<{requestId:string;expiresAt:number}>{
  if((!c.existing&&(c.expectedRequestId!==undefined||c.requestId===null))||(c.existing&&c.requestId!==null))throw invalid();
  await db.prepare('DELETE FROM recipient_setup_contexts WHERE context_hash IN (SELECT context_hash FROM recipient_setup_contexts WHERE right_id IS NULL AND replaces_context_hash IS NULL AND expires_at<=unixepoch() ORDER BY expires_at LIMIT 32)').run();
  const challenge=sql('EXISTS(SELECT 1 FROM login_challenges WHERE token_hash=? AND csrf_hash=? AND consumed_at IS NULL AND expires_at>unixepoch())',c.challengeHash,c.csrfHash);
  // Bound contexts must still be live and current before even their CSRF is refreshed.
  const condition=c.existing?sql(`EXISTS(SELECT 1 FROM recipient_setup_contexts rc WHERE rc.context_hash=? AND (? IS NULL OR rc.request_id=?) AND rc.revoked_at IS NULL AND rc.expires_at>unixepoch()
   AND (rc.right_id IS NULL OR EXISTS(SELECT 1 FROM password_setup_rights r JOIN principals p ON p.id=r.principal_id JOIN password_setup_states s ON s.principal_id=p.id
    WHERE r.id=rc.right_id AND r.principal_id=rc.principal_id AND r.revoked_at IS NULL AND r.expires_at>unixepoch() AND s.latest_right_id=r.id AND p.active=1 AND p.kind='human'
    AND ((r.consumed_at IS NULL AND p.auth_version=r.target_auth_version) OR (r.consumed_at IS NOT NULL AND r.completed_operation_id=rc.operation_id AND p.auth_version=r.completed_auth_version)))))`,c.contextHash,c.expectedRequestId??null,c.expectedRequestId??null):sql('(SELECT count(*) FROM recipient_setup_contexts WHERE right_id IS NULL AND expires_at>unixepoch())<1024');
  const replacement=c.replacesContextHash?sql('NOT EXISTS(SELECT 1 FROM recipient_setup_contexts WHERE context_hash=? AND (revoked_at IS NULL OR request_id<>?)) AND NOT EXISTS(SELECT 1 FROM recipient_setup_contexts WHERE replaces_context_hash=?)',c.replacesContextHash,c.replacesRequestId??null,c.replacesContextHash):sql('1');
  const guard=sql(`(${challenge.text}) AND (${condition.text}) AND (${replacement.text})`,...challenge.values,...condition.values,...replacement.values);
  const change=c.existing?sql('UPDATE recipient_setup_contexts SET csrf_hash=? WHERE context_hash=?',c.csrfHash,c.contextHash):sql('INSERT INTO recipient_setup_contexts(context_hash,request_id,replaces_context_hash,csrf_hash,created_at,expires_at) VALUES(?,?,?,?,unixepoch(),unixepoch()+?)',c.contextHash,c.requestId,c.replacesContextHash??null,c.csrfHash,c.lifetimeSeconds);
  try{await db.batch(guardedBatch(db,guard,[{statement:change,expectedChanges:1},{statement:sql('UPDATE login_challenges SET consumed_at=unixepoch() WHERE token_hash=? AND csrf_hash=? AND consumed_at IS NULL AND expires_at>unixepoch()',c.challengeHash,c.csrfHash),expectedChanges:1}]));}
  catch{
   // Same capability/CSRF readback only; no second creation or renewal attempt.
   const recovered=await db.prepare('SELECT request_id requestId,expires_at expiresAt FROM recipient_setup_contexts WHERE context_hash=? AND csrf_hash=? AND (? IS NULL OR request_id=?) AND revoked_at IS NULL AND expires_at>unixepoch()').bind(c.contextHash,c.csrfHash,c.expectedRequestId??null,c.expectedRequestId??null).first<{requestId:string;expiresAt:number}>();
   if(recovered){await status(c.contextHash,c.csrfHash);return recovered;}throw invalid();
  }
  const result=await status(c.contextHash,c.csrfHash);return{requestId:result.requestId,expiresAt:result.expiresAt};
 }
 async function abandon(c:{expectedRequestId:string;contextHash:string;challengeHash:string;csrfHash:string}):Promise<boolean>{
  const existing=await db.prepare('SELECT request_id requestId FROM recipient_setup_contexts WHERE context_hash=?').bind(c.contextHash).first<{requestId:string}>();if(!existing)return false;if(existing.requestId!==c.expectedRequestId)throw invalid();
  const inactive=sql(`EXISTS(SELECT 1 FROM recipient_setup_contexts rc WHERE rc.context_hash=? AND rc.request_id=? AND
   (rc.right_id IS NULL OR rc.revoked_at IS NOT NULL OR rc.expires_at<=unixepoch() OR NOT EXISTS(
    SELECT 1 FROM password_setup_rights r JOIN principals p ON p.id=r.principal_id JOIN password_setup_states s ON s.principal_id=p.id
    WHERE r.id=rc.right_id AND r.principal_id=rc.principal_id AND r.revoked_at IS NULL AND r.consumed_at IS NULL AND r.expires_at>unixepoch() AND p.active=1 AND p.auth_version=r.target_auth_version AND s.latest_right_id=r.id)))`,c.contextHash,c.expectedRequestId);
  const challenge=sql('EXISTS(SELECT 1 FROM login_challenges WHERE token_hash=? AND csrf_hash=? AND consumed_at IS NULL AND expires_at>unixepoch())',c.challengeHash,c.csrfHash);
  const guard=sql(`(${inactive.text}) AND (${challenge.text})`,...inactive.values,...challenge.values);
  try{await db.batch(guardedBatch(db,guard,[{statement:sql('UPDATE recipient_setup_contexts SET revoked_at=COALESCE(revoked_at,unixepoch()) WHERE context_hash=?',c.contextHash),expectedChanges:1},{statement:sql('UPDATE login_challenges SET consumed_at=unixepoch() WHERE token_hash=? AND csrf_hash=? AND consumed_at IS NULL AND expires_at>unixepoch()',c.challengeHash,c.csrfHash),expectedChanges:1}]));}
  catch{
   if(await db.prepare('SELECT 1 FROM recipient_setup_contexts WHERE context_hash=? AND request_id=? AND revoked_at IS NOT NULL').bind(c.contextHash,c.expectedRequestId).first())return true;
   const allowed=await db.prepare(`SELECT (${inactive.text}) allowed`).bind(...inactive.values).first<{allowed:number}>();
   if(!allowed?.allowed)throw new ApiError(403,'recipient_setup_still_active');throw invalid();
  }
  return true;
 }
 async function complete(c:RecipientPasswordCommit){
  const bound=sql(`EXISTS(SELECT 1 FROM recipient_setup_contexts rc JOIN password_setup_states s ON s.principal_id=rc.principal_id AND s.latest_right_id=rc.right_id
   WHERE rc.context_hash=? AND rc.csrf_hash=? AND rc.request_id=? AND rc.operation_id=? AND rc.principal_id=? AND rc.issuer_id=? AND rc.purpose=? AND rc.revoked_at IS NULL AND rc.expires_at>unixepoch())`,c.contextHash,c.csrfHash,c.requestId,c.operationId,c.principalId,c.issuerId,c.purpose);
  const row=await db.prepare(`SELECT r.token_hash FROM recipient_setup_contexts rc JOIN password_setup_rights r ON r.id=rc.right_id WHERE rc.context_hash=? AND (${bound.text})`).bind(c.contextHash,...bound.values).first<{token_hash:string}>();
  if(!row)throw invalid();
  const result=await commitPasswordSetup(db,await preparePasswordSetupValue(db,row.token_hash,c.operationId,c.inputHash,c.encodedPassword,bound));
  const current=await status(c.contextHash,c.csrfHash);if(current.state==='waiting')throw invalid();return{...current,source:result.source};
 }
 return{reserve,status,complete,abandon};
}
