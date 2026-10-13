// @module identity
// @role private-completion
import {setupPasswordCount} from "../../../modules/identity/rules";
import type { AuthDB } from './auth-types';
import { ApiError } from "../../protocol-errors";
import { guardedBatch,type CountedWrite } from "../persistence/guarded-batch";
import {sql,type Sql} from "../primitives";
import {type Json} from "../persistence/public";
import { setupSnapshot,type Purpose } from './password-setup-model';
interface RightRow{id:string;principal_id:string;purpose:Purpose;target_auth_version:number;expires_at:number;consumed_at:number|null;revoked_at:number|null;completed_operation_id:string|null;input_hash:string|null;completed_auth_version:number|null;completion_snapshot:string|null;auth_version:number;revision:number;login_id:string;display_name:string;active:number;latest_right_id:string|null}
/** Compatibility only: grants issued before protected contexts existed may use a bearer. */
function legacyBearer(tokenHash:string):Sql{return sql(`NOT EXISTS(SELECT 1 FROM recipient_setup_contexts c JOIN password_setup_rights r ON r.id=c.right_id WHERE r.token_hash=?) AND NOT EXISTS(SELECT 1 FROM owner_setup_contexts c JOIN password_setup_rights r ON r.id=c.right_id WHERE r.token_hash=?)`,tokenHash,tokenHash);}
async function rightByHash(db:AuthDB,tokenHash:string):Promise<RightRow>{
 const r=await db.prepare(`SELECT r.*,p.auth_version,p.active,p.login_id,p.display_name,s.revision,s.latest_right_id FROM password_setup_rights r JOIN principals p ON p.id=r.principal_id JOIN password_setup_states s ON s.principal_id=p.id WHERE r.token_hash=? AND p.kind='human'`).bind(tokenHash).first<RightRow>();if(!r)throw new ApiError(403,'setup_right_unavailable');return r;
}
function unconsumedGuard(r:RightRow):Sql{return sql(`EXISTS(SELECT 1 FROM password_setup_rights r JOIN principals p ON p.id=r.principal_id JOIN password_setup_states s ON s.principal_id=p.id
 WHERE r.id=? AND p.id=? AND p.kind='human' AND p.active=1 AND p.auth_version=r.target_auth_version AND r.target_auth_version=?
 AND r.expires_at>unixepoch() AND r.revoked_at IS NULL AND r.consumed_at IS NULL AND s.latest_right_id=r.id AND s.revision=?
 AND (SELECT count(*) FROM passwords WHERE principal_id=p.id)=${setupPasswordCount(r.purpose)})`,r.id,r.principal_id,r.target_auth_version,r.revision);}
async function permitted(db:AuthDB,guard:Sql):Promise<boolean>{return!!(await db.prepare(`SELECT (${guard.text}) valid`).bind(...guard.values).first<{valid:number}>())?.valid;}
export async function setupRightContext(db:AuthDB,tokenHash:string){const r=await rightByHash(db,tokenHash);const current=unconsumedGuard(r),legacy=legacyBearer(tokenHash);if(!await permitted(db,sql(`(${current.text}) AND (${legacy.text})`,...current.values,...legacy.values)))throw new ApiError(403,'setup_right_unavailable');return{principalId:r.principal_id,loginId:r.login_id,displayName:r.display_name,purpose:r.purpose,expiresAt:r.expires_at};}
export async function setupCompletionResultByHash(db:AuthDB,tokenHash:string,operationId:string,bound:Sql=legacyBearer(tokenHash)){
 const r=await rightByHash(db,tokenHash);
 const row=await db.prepare(`SELECT CASE WHEN p.active=1 AND p.kind='human' AND p.auth_version=r.completed_auth_version
 AND r.expires_at>unixepoch() AND r.revoked_at IS NULL AND r.completed_operation_id=? AND (${bound.text}) THEN r.completion_snapshot ELSE NULL END snapshot
 FROM password_setup_rights r JOIN principals p ON p.id=r.principal_id WHERE r.id=?`).bind(operationId,...bound.values,r.id).first<{snapshot:string|null}>();
 if(!row?.snapshot)throw new ApiError(403,'setup_result_unavailable');return{operationId,snapshot:JSON.parse(row.snapshot) as Json};
}
export async function passwordSetupPhase(db:AuthDB,tokenHash:string,operationId:string,inputHash:string):Promise<'ready'|'completed'>{
 const r=await rightByHash(db,tokenHash);
 if(r.consumed_at!==null){
  // Input equality is receipt information: disclose it only after current authority.
  await setupCompletionResultByHash(db,tokenHash,operationId);
  if(r.input_hash!==inputHash)throw new ApiError(409,'operation_input_mismatch');return 'completed';
 }
 const current=unconsumedGuard(r),legacy=legacyBearer(tokenHash);if(!await permitted(db,sql(`(${current.text}) AND (${legacy.text})`,...current.values,...legacy.values)))throw new ApiError(403,'setup_right_unavailable');return 'ready';
}
export async function preparePasswordSetupValue(db:AuthDB,tokenHash:string,operationId:string,inputHash:string,encoded:string,bound:Sql=legacyBearer(tokenHash)){
 const r=await rightByHash(db,tokenHash);
 if(r.consumed_at!==null){
  const recovered=await setupCompletionResultByHash(db,tokenHash,operationId,bound);
  if(r.input_hash!==inputHash)throw new ApiError(409,'operation_input_mismatch');return{recovered};
 }
 const current=unconsumedGuard(r),guard=sql(`(${current.text}) AND (${bound.text})`,...current.values,...bound.values);
 if(!await permitted(db,guard))throw new ApiError(403,'setup_right_unavailable');
 const stateSnapshot=setupSnapshot(r.principal_id);
 const snapshot=sql(`SELECT json_object('principalId',id,'authVersion',auth_version,'configured',json('true')) FROM principals WHERE id=?`,r.principal_id);
 const writes:CountedWrite[]=[
 {statement:sql(`UPDATE password_setup_states SET before_snapshot=(${stateSnapshot.text}),revision=revision+1 WHERE principal_id=? AND revision=?`,...stateSnapshot.values,r.principal_id,r.revision),expectedChanges:1},
 {statement:sql('INSERT INTO passwords(principal_id,encoded_hash) VALUES(?,?) ON CONFLICT(principal_id) DO UPDATE SET encoded_hash=excluded.encoded_hash',r.principal_id,encoded),expectedChanges:1},
 {statement:sql('UPDATE principals SET auth_version=auth_version+1 WHERE id=? AND active=1 AND auth_version=?',r.principal_id,r.target_auth_version),expectedChanges:1},
 {statement:sql('UPDATE principal_management SET revision=revision+1,before_snapshot=NULL WHERE principal_id=?',r.principal_id),expectedChanges:1},
 // The version transition invalidates all old sessions, including sessions created after preparation.
 {statement:sql(`UPDATE password_setup_rights SET consumed_at=unixepoch(),completed_operation_id=?,input_hash=?,completed_auth_version=?,completion_snapshot=(${snapshot.text}) WHERE id=? AND consumed_at IS NULL AND revoked_at IS NULL`,operationId,inputHash,r.target_auth_version+1,...snapshot.values,r.id),expectedChanges:1},
 {statement:sql(`INSERT INTO password_setup_audit(kind,actor_id,actor_kind,operation_id,principal_id,right_id,snapshot,recorded_at) SELECT 'complete',?,'setup-right-holder',?,?,id,completion_snapshot,unixepoch() FROM password_setup_rights WHERE id=?`,r.principal_id,operationId,r.principal_id,r.id),expectedChanges:1}];
 return{r,tokenHash,operationId,inputHash,guard,writes,bound};
}
export async function commitPasswordSetup(db:AuthDB,p:Awaited<ReturnType<typeof preparePasswordSetupValue>>){
 if('recovered'in p&&p.recovered)return{...p.recovered,source:'recovered' as const};let failed=false;
 try{await db.batch(guardedBatch(db,p.guard,p.writes));}catch{failed=true;}
 try{const result=await setupCompletionResultByHash(db,p.tokenHash,p.operationId,p.bound);const r=await rightByHash(db,p.tokenHash);if(r.input_hash!==p.inputHash)throw new ApiError(403,'setup_right_unavailable');return{...result,source:failed?'recovered' as const:'committed' as const};}
 catch(e){if(!await permitted(db,p.guard))throw new ApiError(403,'setup_right_unavailable');if(e instanceof ApiError&&e.status!==403)throw e;throw new ApiError(503,'setup_unavailable');}
}
