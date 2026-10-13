// @module identity
// @role private-d1
/** Checked SQL encoding for the private operator application; no secret generation or handoff. */
import type {AuthDB} from '../primitives';
import {IdentityError} from '../../../modules/identity/outcomes';
import {ApiError} from '../../protocol-errors';
import {guardedBatch,type CountedWrite} from '../persistence/guarded-batch';
import {sql,type Sql} from '../primitives';
import {preparePrincipalProvision} from './principal-provision';
import type {OperatorPersistence,OperatorReceipt,OperatorCommand as Command} from '../../../modules/identity/operator-contracts';
interface Row{operation_kind:OperatorReceipt['kind'];target_id:string;input_hash:string;snapshot:string}
async function stored(db:AuthDB,c:Command):Promise<OperatorReceipt|null>{
 const row=await db.prepare('SELECT operation_kind,target_id,input_hash,snapshot FROM deployment_operations WHERE operator_id=? AND operation_id=?').bind(c.context.operatorId,c.context.operationId).first<Row>();
 if(!row)return null;if(row.operation_kind!==c.kind||row.target_id!==c.target||row.input_hash!==c.inputHash)throw new ApiError(409,'deployment_operation_mismatch');
 return{operatorId:c.context.operatorId,operationId:c.context.operationId,kind:row.operation_kind,targetId:row.target_id,snapshot:JSON.parse(row.snapshot) as OperatorReceipt['snapshot']};
}
async function commit(db:AuthDB,c:Command,guard:Sql,writes:CountedWrite[],snapshot:Sql){
 const audit:CountedWrite={expectedChanges:1,statement:sql(`INSERT INTO deployment_operations VALUES(?,?,?,?,?,(${snapshot.text}),unixepoch())`,c.context.operatorId,c.context.operationId,c.kind,c.target,c.inputHash,...snapshot.values)};
 let failed=false;try{await db.batch(guardedBatch(db,guard,[...writes,audit]));}catch{failed=true;}
 const result=await stored(db,c);if(!result)throw new ApiError(failed?500:503,'deployment_batch_unconfirmed');return result;
}
function operatorError(error:unknown):never{if(error instanceof IdentityError)throw error;if(error instanceof ApiError)throw new IdentityError(error.status===409?'input_mismatch':error.status===400?'invalid':'unavailable',error.code);throw new IdentityError('unavailable','operator_storage_unavailable');}
export function createOperatorPersistence(db:AuthDB):OperatorPersistence{const store:OperatorPersistence={
 readReceipt:c=>stored(db,c),
 async commitPrincipal(c,input){const prepared=preparePrincipalProvision(input);
 return commit(db,c,prepared.guard,prepared.writes,sql("SELECT json_object('principalId',p.id,'kind',p.kind,'loginId',p.login_id,'authVersion',p.auth_version,'globalAdministrator',m.global_administrator,'projects',json(?)) FROM principals p JOIN principal_management m ON m.principal_id=p.id WHERE p.id=?",JSON.stringify(prepared.normalized.projects),prepared.normalized.principalId));
 },
 async commitCredential(c,input,tokenHash){const {principalId,credentialId,scopes}=input;
const guards:Sql[]=[sql("EXISTS(SELECT 1 FROM principals WHERE id=? AND kind='agent' AND active=1 AND auth_version=?)",principalId,input.authVersion),sql('?>unixepoch() AND NOT EXISTS(SELECT 1 FROM api_credentials WHERE id=?)',input.expiresAt,credentialId)];
 // Keep the complete grant set in one bound JSON value. Recheck every pair inside
 // the committing batch, without exceeding D1's 100-parameter statement limit.
 guards.push(sql(`NOT EXISTS(SELECT 1 FROM json_each(?) scope
   JOIN json_each(scope.value,'$.permissions') grant
   WHERE NOT EXISTS(SELECT 1 FROM memberships m WHERE m.principal_id=?
     AND m.project_id=json_extract(scope.value,'$.projectId') AND m.permission=grant.value))`,JSON.stringify(scopes),principalId));
 const guard=sql(guards.map(g=>'('+g.text+')').join(' AND '),...guards.flatMap(g=>g.values)),writes:CountedWrite[]=[{expectedChanges:1,statement:sql('INSERT INTO api_credentials VALUES(?,?,?,?,NULL)',credentialId,principalId,tokenHash,input.expiresAt)}];
 for(const p of scopes)for(const permission of p.permissions)writes.push({expectedChanges:1,statement:sql('INSERT INTO api_grants VALUES(?,?,?)',credentialId,p.projectId,permission)});
 return commit(db,c,guard,writes,sql("SELECT json_object('credentialId',id,'principalId',principal_id,'expiresAt',expires_at,'scopes',json(?)) FROM api_credentials WHERE id=?",JSON.stringify(scopes),credentialId));
 },
 async credentialDeliveryAllowed(input,tokenHash){return !!await db.prepare(`SELECT 1 FROM api_credentials c JOIN principals p ON p.id=c.principal_id
  WHERE c.id=? AND c.token_hash=? AND c.principal_id=? AND c.revoked_at IS NULL AND c.expires_at>unixepoch() AND p.kind='agent' AND p.active=1 AND p.auth_version=?
  AND NOT EXISTS(SELECT 1 FROM json_each(?) scope JOIN json_each(scope.value,'$.permissions') grant WHERE NOT EXISTS(SELECT 1 FROM memberships m JOIN api_grants g ON g.project_id=m.project_id AND g.permission=m.permission AND g.credential_id=c.id WHERE m.principal_id=p.id AND m.project_id=json_extract(scope.value,'$.projectId') AND m.permission=grant.value))`)
  .bind(input.credentialId,tokenHash,input.principalId,input.authVersion,JSON.stringify(input.scopes)).first();}
};return{readReceipt:c=>store.readReceipt(c).catch(operatorError),commitPrincipal:(c,p)=>store.commitPrincipal(c,p).catch(operatorError),commitCredential:(c,p,h)=>store.commitCredential(c,p,h).catch(operatorError),credentialDeliveryAllowed:(p,h)=>store.credentialDeliveryAllowed(p,h).catch(operatorError)};}
