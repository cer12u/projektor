// @module identity
// @role private-bootstrap
import type { AuthDB } from './auth-types';
import type {BootstrapSetupCommit} from "../../../modules/identity/ports";
import { ApiError } from "../../protocol-errors";
import { type CountedWrite } from "../persistence/guarded-batch";
import {sql} from "../primitives";
import { setupSnapshot } from './password-setup-model';
/** Privileged fixed-owner preparation shared by controlled bootstrap entry points; supplies no caller authority. */
export async function prepareBootstrapSetup(db:AuthDB,c:BootstrapSetupCommit){
 const {targetId:target,operationId,rightId:id,rightHash:hash}=c;
 const row=await db.prepare(`SELECT p.auth_version,s.revision,s.latest_right_id FROM principals p JOIN password_setup_states s ON s.principal_id=p.id JOIN principal_management m ON m.principal_id=p.id WHERE p.id=? AND p.kind='human' AND p.active=1 AND m.global_administrator=1 AND NOT EXISTS(SELECT 1 FROM passwords WHERE principal_id=p.id)`).bind(target).first<{auth_version:number;revision:number;latest_right_id:string|null}>();
 if(!row)throw new ApiError(403,'bootstrap_target_unavailable');
 const count=await db.prepare('SELECT count(*) n FROM password_setup_rights WHERE principal_id=? AND consumed_at IS NULL AND revoked_at IS NULL').bind(target).first<{n:number}>();
 const state=setupSnapshot(target);
 const guard=sql(`EXISTS(SELECT 1 FROM principals p JOIN principal_management m ON m.principal_id=p.id JOIN password_setup_states s ON s.principal_id=p.id WHERE p.id=? AND p.kind='human' AND p.active=1 AND p.auth_version=? AND m.global_administrator=1 AND s.revision=? AND NOT EXISTS(SELECT 1 FROM passwords WHERE principal_id=p.id))`,target,row.auth_version,row.revision);
 const writes:CountedWrite[]=[...((count?.n??0)>0?[{statement:sql('UPDATE password_setup_rights SET revoked_at=unixepoch() WHERE principal_id=? AND consumed_at IS NULL AND revoked_at IS NULL',target),expectedChanges:count!.n}]:[]),{statement:sql('INSERT INTO password_setup_rights(id,principal_id,token_hash,purpose,target_auth_version,issued_at,expires_at) VALUES(?,?,?,\'initial\',?,unixepoch(),COALESCE(?,unixepoch()+?))',id,target,hash,row.auth_version,c.expiresAt,c.lifetimeSeconds),expectedChanges:1},{statement:sql('UPDATE password_setup_states SET latest_right_id=?,revision=revision+1 WHERE principal_id=? AND revision=?',id,target,row.revision),expectedChanges:1},{statement:sql(`INSERT INTO password_setup_audit VALUES('bootstrap',?,'deployment-management',?,?,?,(${state.text}),unixepoch())`,target,operationId,target,id,...state.values),expectedChanges:1}];
 return{id,guard,writes};
}
