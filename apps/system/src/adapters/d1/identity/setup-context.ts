// @module identity
// @role private-d1
import type {AuthDB} from "../primitives";
import {sql} from "../primitives";
import {guardedBatch} from "../persistence/guarded-batch";
import {ApiError} from "../../protocol-errors";
import {prepareBootstrapSetup} from "./password-setup-bootstrap";
import {preparePasswordSetupValue,commitPasswordSetup} from "./password-setup-completion";
import type {OwnerContext,OwnerIssue,OwnerCompletion,OwnerContextCommit} from "../../../modules/identity/ports";
import type {OwnerSetupStatus} from "../../../modules/identity/public";
const invalid=()=>new ApiError(403,'owner_setup_unavailable');
export function ownerContextStore(db:AuthDB){
 const contextGuard=(hash:string,csrf:string)=>sql(`EXISTS(SELECT 1 FROM owner_setup_contexts oc WHERE oc.context_hash=? AND oc.csrf_hash=? AND oc.revoked_at IS NULL AND oc.expires_at>unixepoch())`,hash,csrf);
 async function read(hash:string,csrf:string):Promise<OwnerContext>{
  const row=await db.prepare(`SELECT expires_at AS expiresAt,operation_id AS operationId,owner_id AS ownerId FROM owner_setup_contexts WHERE context_hash=? AND csrf_hash=? AND revoked_at IS NULL AND expires_at>unixepoch()`).bind(hash,csrf).first<OwnerContext>();
  if(!row)throw invalid();return row;
 }
 async function status(hash:string,csrf:string,operationId:string):Promise<OwnerSetupStatus>{
  const c=await read(hash,csrf);if(c.operationId===null)throw new ApiError(404,'owner_setup_not_found');if(c.operationId!==operationId)throw invalid();
  const row=await db.prepare(`SELECT oc.owner_id AS principalId,oc.operation_id AS operationId,min(oc.expires_at,r.expires_at) AS expiresAt,
    CASE WHEN r.consumed_at IS NULL THEN 'ready' ELSE 'completed' END AS state,r.completed_auth_version AS completedAuthVersion
   FROM owner_setup_contexts oc JOIN password_setup_rights r ON r.id=oc.right_id JOIN principals p ON p.id=oc.owner_id JOIN password_setup_states s ON s.principal_id=p.id
   WHERE oc.context_hash=? AND oc.csrf_hash=? AND oc.operation_id=? AND oc.revoked_at IS NULL AND oc.expires_at>unixepoch()
    AND p.active=1 AND p.kind='human' AND s.latest_right_id=r.id AND r.principal_id=p.id AND r.revoked_at IS NULL AND r.expires_at>unixepoch()
    AND ((r.consumed_at IS NULL AND p.auth_version=r.target_auth_version AND s.latest_right_id=r.id)
      OR (r.consumed_at IS NOT NULL AND r.completed_operation_id=oc.operation_id AND p.auth_version=r.completed_auth_version))`).bind(hash,csrf,operationId).first<OwnerSetupStatus & {completedAuthVersion:number|null}>();
  if(!row)throw invalid();return{principalId:row.principalId,operationId:row.operationId,state:row.state,expiresAt:row.expiresAt,...(row.completedAuthVersion===null?{}:{completedAuthVersion:row.completedAuthVersion})};
 }
 return {
  read,status,
  async reserve(c:OwnerContextCommit):Promise<OwnerContext>{
   const {contextHash:hash,csrfHash:csrf,challengeHash:challenge,existing,expectedOperationId,lifetimeSeconds}=c;
   const challengeGuard=sql('EXISTS(SELECT 1 FROM login_challenges WHERE token_hash=? AND csrf_hash=? AND consumed_at IS NULL AND expires_at>unixepoch())',challenge,csrf);
   if(existing){
    const current=await db.prepare('SELECT operation_id FROM owner_setup_contexts WHERE context_hash=? AND revoked_at IS NULL AND expires_at>unixepoch()').bind(hash).first<{operation_id:string|null}>();
    if(!current)throw invalid();if(expectedOperationId!==undefined&&current.operation_id!==null&&current.operation_id!==expectedOperationId)throw new ApiError(409,'owner_setup_conflict');
   }else if(expectedOperationId!==undefined)throw invalid();
   await db.prepare('DELETE FROM owner_setup_contexts WHERE context_hash IN (SELECT context_hash FROM owner_setup_contexts WHERE right_id IS NULL AND expires_at<=unixepoch() ORDER BY expires_at LIMIT 32)').run();
   const condition=existing?sql('EXISTS(SELECT 1 FROM owner_setup_contexts WHERE context_hash=? AND revoked_at IS NULL AND expires_at>unixepoch() AND (? IS NULL OR operation_id IS NULL OR operation_id=?))',hash,expectedOperationId??null,expectedOperationId??null):sql('(SELECT count(*) FROM owner_setup_contexts WHERE right_id IS NULL AND expires_at>unixepoch())<1024');
   const guard=sql(`(${challengeGuard.text}) AND (${condition.text})`,...challengeGuard.values,...condition.values);
   const change=existing?sql('UPDATE owner_setup_contexts SET csrf_hash=? WHERE context_hash=?',csrf,hash):sql('INSERT INTO owner_setup_contexts(context_hash,csrf_hash,created_at,expires_at) VALUES(?,?,unixepoch(),unixepoch()+?)',hash,csrf,lifetimeSeconds);
   try{await db.batch(guardedBatch(db,guard,[{statement:change,expectedChanges:1},{statement:sql('UPDATE login_challenges SET consumed_at=unixepoch() WHERE token_hash=? AND csrf_hash=? AND consumed_at IS NULL AND expires_at>unixepoch()',challenge,csrf),expectedChanges:1}]));}
   catch{
    // Reconcile this exact generated capability/CSRF. Never replay the creation batch.
    const recovered=await db.prepare('SELECT expires_at AS expiresAt,operation_id AS operationId,owner_id AS ownerId FROM owner_setup_contexts WHERE context_hash=? AND csrf_hash=? AND revoked_at IS NULL AND expires_at>unixepoch()').bind(hash,csrf).first<OwnerContext>();
    if(recovered)return recovered;
    const valid=await db.prepare(`SELECT (${guard.text}) valid`).bind(...guard.values).first<{valid:number}>();if(!valid?.valid)throw invalid();throw new ApiError(503,'owner_setup_outcome_unknown');
   }
   return read(hash,csrf);
  },
  async issue(c:OwnerIssue):Promise<OwnerSetupStatus>{
   const current=await read(c.contextHash,c.csrfHash);
   if(current.operationId!==null){if(current.operationId!==c.operationId||current.ownerId!==c.configuration.ownerId)throw new ApiError(409,'owner_setup_conflict');return status(c.contextHash,c.csrfHash,c.operationId);}
   const p=await prepareBootstrapSetup(db,{targetId:c.configuration.ownerId,operationId:c.operationId,rightId:c.rightId,rightHash:c.rightHash,expiresAt:c.expiresAt,lifetimeSeconds:c.lifetimeSeconds});
   const bound=contextGuard(c.contextHash,c.csrfHash);
   const guard=sql(`(${p.guard.text}) AND (${bound.text}) AND EXISTS(SELECT 1 FROM owner_setup_contexts WHERE context_hash=? AND right_id IS NULL AND expires_at>=?) AND EXISTS(SELECT 1 FROM auth_settings WHERE key='owner_web_bootstrap' AND value=?) AND unixepoch()<? AND unixepoch()<? AND unixepoch()<?`,...p.guard.values,...bound.values,c.contextHash,c.expiresAt,c.expectedConfiguration,c.configuration.closesAt,c.assertionExpiresAt,c.expiresAt);
   let failed=false;
   try{await db.batch(guardedBatch(db,guard,[...p.writes,
    {statement:sql('UPDATE owner_setup_contexts SET owner_id=?,operation_id=?,right_id=?,issuer=?,audience=?,subject=?,expires_at=? WHERE context_hash=? AND right_id IS NULL',c.configuration.ownerId,c.operationId,p.id,c.configuration.issuer,c.configuration.audience,c.configuration.subject,c.expiresAt,c.contextHash),expectedChanges:1},
    {statement:sql("DELETE FROM auth_settings WHERE key='owner_web_bootstrap' AND value=?",c.expectedConfiguration),expectedChanges:1}]));}catch{failed=true;}
   try{return await status(c.contextHash,c.csrfHash,c.operationId);}catch(error){if(failed){const valid=await db.prepare(`SELECT (${guard.text}) valid`).bind(...guard.values).first<{valid:number}>();if(!valid?.valid)throw invalid();throw new ApiError(503,'owner_setup_outcome_unknown');}throw error;}
  },
  async complete(c:OwnerCompletion){
   // The context/CSRF/operation binding is checked again inside password+version+receipt commit.
   const bound=sql(`EXISTS(SELECT 1 FROM owner_setup_contexts oc JOIN password_setup_states os ON os.principal_id=oc.owner_id AND os.latest_right_id=oc.right_id WHERE oc.context_hash=? AND oc.csrf_hash=? AND oc.operation_id=? AND oc.right_id IS NOT NULL AND oc.revoked_at IS NULL AND oc.expires_at>unixepoch())`,c.contextHash,c.csrfHash,c.operationId);
   const row=await db.prepare(`SELECT r.token_hash FROM owner_setup_contexts oc JOIN password_setup_rights r ON r.id=oc.right_id WHERE oc.context_hash=? AND (${bound.text})`).bind(c.contextHash,...bound.values).first<{token_hash:string}>();
   if(!row)throw invalid();
   const result=await commitPasswordSetup(db,await preparePasswordSetupValue(db,row.token_hash,c.operationId,c.inputHash,c.encodedPassword,bound));
   return{...await status(c.contextHash,c.csrfHash,c.operationId),source:result.source};
  }
 };
}
