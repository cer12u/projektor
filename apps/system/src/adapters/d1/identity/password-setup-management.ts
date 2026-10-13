// @module identity
// @role private-management
import type { AuthDB,Authenticated } from './auth-types';
import type {SetupManagementCommit,SetupManagementObservation,SetupManagementRequest,SetupManagementPlanningRead} from "../../../modules/identity/ports";
import { type CountedWrite } from "../persistence/guarded-batch";
import {currentCredentialSql} from "./authorization";
import {executeMutation,readMutationReceipt,recoverMutation,type MutationAdapter,type ReadPolicyFor} from "../persistence/transaction";
import {MutationError,type Json} from "../persistence/public";
import {sql} from "../primitives";
import { setupSnapshot,type SetupMetadata } from './password-setup-model';
import {failedChange} from "../persistence/outcomes";
const visible=(target:{targetId:string})=>sql("EXISTS(SELECT 1 FROM principals WHERE id=? AND kind='human')",target.targetId);
export const setupManagementPolicies:ReadPolicyFor=kind=>['setup.issue','setup.revoke'].includes(kind)?{authority:'global-administrator',visible}:undefined;
export async function setupManagementObservation(db:AuthDB,auth:Authenticated,target:string):Promise<SetupManagementObservation>{
 const credential=currentCredentialSql(auth),snapshot=setupSnapshot(target);
 const q=sql(`SELECT (${credential.text}) authenticated,EXISTS(SELECT 1 FROM principal_management WHERE principal_id=? AND global_administrator=1) permitted,
 CASE WHEN (${credential.text}) AND EXISTS(SELECT 1 FROM principal_management WHERE principal_id=? AND global_administrator=1) THEN json_object('snapshot',json((${snapshot.text})),
 'pendingRightIds',json((SELECT json_group_array(id) FROM (SELECT id FROM password_setup_rights WHERE principal_id=? AND consumed_at IS NULL AND revoked_at IS NULL ORDER BY id)))) ELSE NULL END observation`,...credential.values,auth.id,...credential.values,auth.id,...snapshot.values,target);
 const r=await db.prepare(q.text).bind(...q.values).first<{authenticated:number;permitted:number;observation:string|null}>();
 if(!r?.authenticated)throw new MutationError(401,'unauthenticated');if(!r.permitted||!r.observation)throw new MutationError(403,'forbidden');
 const observed=JSON.parse(r.observation) as SetupManagementObservation;if(!observed.snapshot)throw new MutationError(403,'forbidden');return observed;
}
export async function setupManagementState(db:AuthDB,auth:Authenticated,target:string):Promise<SetupMetadata>{return (await setupManagementObservation(db,auth,target)).snapshot;}
function setupCommand(r:SetupManagementRequest){return{operationId:r.operationId,kind:r.purpose?'setup.issue':'setup.revoke',targetId:r.targetId,projectId:'GLOBAL',input:{revision:r.revision,purpose:r.purpose,...(r.purpose?{recipientRequestId:r.recipientRequestId!}:{})}};}
export async function readSetupManagement(db:AuthDB,auth:Authenticated,request:SetupManagementRequest):Promise<SetupManagementPlanningRead>{
 try{
  const recovered=await recoverMutation(db,auth,setupCommand(request),setupManagementPolicies);
  if(recovered)return{kind:'outcome',outcome:{application:'confirmed',disclosure:'allowed',source:'recovered',receipt:{operationId:request.operationId,snapshot:recovered.snapshot as unknown as SetupMetadata}}};
  const observation=await setupManagementObservation(db,auth,request.targetId);
  if(request.purpose){
   const valid=currentCredentialSql(auth);
   const context=await db.prepare(`SELECT request_id requestId,expires_at expiresAt FROM recipient_setup_contexts WHERE request_id=? AND principal_id IS NULL AND revoked_at IS NULL AND expires_at>unixepoch() AND (${valid.text}) AND EXISTS(SELECT 1 FROM principal_management WHERE principal_id=? AND global_administrator=1)`).bind(request.recipientRequestId,...valid.values,auth.id).first<{requestId:string;expiresAt:number}>();
   if(!context)throw new MutationError(403,'recipient_setup_unavailable');observation.recipient=context;
  }
  return{kind:'observed',observation};
 }catch(error){return{kind:'outcome',outcome:failedChange<SetupMetadata>(request.operationId,error)};}
}
export function prepareSetupManagement(db:AuthDB,auth:Authenticated,c:SetupManagementCommit){
 const {targetId:target,operationId,revision,action}=c,purpose=action.kind==='issue'?action.purpose:null,rightId=action.kind==='issue'?action.rightId:null;
 const old=c.expected,before=setupSnapshot(target);
 const command=setupCommand({operationId,targetId:target,revision,purpose,...(action.kind==='issue'?{recipientRequestId:action.recipientRequestId}:{})});
 const adapter:MutationAdapter<Json>={authority:'global-administrator',permissions:[],visible,current:t=>setupSnapshot(t.targetId),
 preconditions:()=>[
 {reason:'revision_conflict',valid:sql('EXISTS(SELECT 1 FROM password_setup_states WHERE principal_id=? AND revision=?)',target,revision)},
 {reason:'target_changed',valid:sql(`(${before.text})=?`,...before.values,JSON.stringify(old))},
 {reason:'target_changed',valid:sql('(SELECT json_group_array(id) FROM (SELECT id FROM password_setup_rights WHERE principal_id=? AND consumed_at IS NULL AND revoked_at IS NULL ORDER BY id))=?',target,JSON.stringify(c.revokeRightIds))},
 {reason:'target_inactive',valid:sql("EXISTS(SELECT 1 FROM principals WHERE id=? AND kind='human' AND active=1 AND auth_version=?)",target,old.authVersion)},
 ...(action.kind==='issue'?[{reason:'recipient_context_changed',valid:sql('EXISTS(SELECT 1 FROM recipient_setup_contexts WHERE request_id=? AND principal_id IS NULL AND revoked_at IS NULL AND expires_at=? AND expires_at>unixepoch()) AND ?>unixepoch() AND ?<=unixepoch()+?',action.recipientRequestId,action.contextExpiresAt,action.expiresAt,action.expiresAt,action.lifetimeSeconds)},{reason:'purpose_conflict',valid:sql('(SELECT count(*) FROM passwords WHERE principal_id=?)=?',target,action.expectedPasswordCount)}]:[{reason:'right_unavailable',valid:sql('EXISTS(SELECT 1 FROM password_setup_rights WHERE id=? AND consumed_at IS NULL AND revoked_at IS NULL)',old.rightId)}])],
 updates:()=>{
 const writes:CountedWrite[]=[{statement:sql(`UPDATE password_setup_states SET before_snapshot=(${before.text}),revision=revision+1,latest_right_id=? WHERE principal_id=? AND revision=?`,...before.values,c.nextRightId,target,revision),expectedChanges:1}];
 if(c.revokeRightIds.length>0)writes.push({statement:sql('UPDATE password_setup_rights SET revoked_at=unixepoch() WHERE principal_id=? AND id IN (SELECT value FROM json_each(?)) AND consumed_at IS NULL AND revoked_at IS NULL',target,JSON.stringify(c.revokeRightIds)),expectedChanges:c.revokeRightIds.length});
 if(action.kind==='issue')writes.push({statement:sql(`INSERT INTO password_setup_rights(id,principal_id,token_hash,purpose,target_auth_version,issued_at,expires_at) VALUES(?,?,?,?,?,unixepoch(),?)`,rightId,target,action.tokenHash,purpose,old.authVersion,action.expiresAt),expectedChanges:1});
 if(action.kind==='issue')writes.push({statement:sql('UPDATE recipient_setup_contexts SET issuer_id=?,issuer_display_name=(SELECT display_name FROM principals WHERE id=?),operation_id=?,principal_id=?,right_id=?,purpose=?,target_auth_version=?,expires_at=? WHERE request_id=? AND principal_id IS NULL AND revoked_at IS NULL AND expires_at>unixepoch()',auth.id,auth.id,operationId,target,rightId,purpose,old.authVersion,action.expiresAt,action.recipientRequestId),expectedChanges:1});return writes;},
 history:()=>[{statement:sql(`INSERT INTO password_setup_audit(kind,actor_id,actor_kind,operation_id,principal_id,right_id,snapshot,recorded_at) SELECT ?,?,'authenticated',?,?,latest_right_id,(${before.text}),unixepoch() FROM password_setup_states WHERE principal_id=?`,purpose?'issue':'revoke',auth.id,operationId,target,...before.values,target),expectedChanges:1}],snapshot:()=>before};
 return{command,adapter};
}
export async function executeSetupManagement(db:AuthDB,auth:Authenticated,c:SetupManagementCommit){
 const p=prepareSetupManagement(db,auth,c),result=await executeMutation(db,auth,p.command,p.adapter,setupManagementPolicies);
 return{operationId:c.operationId,...result};
}
export function setupManagementResult(db:AuthDB,auth:Authenticated,operationId:string){return readMutationReceipt(db,auth,operationId,setupManagementPolicies);}
