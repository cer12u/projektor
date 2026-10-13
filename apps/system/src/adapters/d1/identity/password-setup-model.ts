// @module identity
// @role private-model
import {sql,type Sql} from "../primitives";
export {SETUP_SECONDS} from "../../../modules/identity/rules";
export type Purpose='initial'|'reset';
export interface SetupMetadata{principalId:string;revision:number;authVersion:number;rightId:string|null;purpose:Purpose|null;expiresAt:number|null;consumedAt:number|null;revokedAt:number|null}
export function setupSnapshot(principal:string):Sql{return sql(`SELECT json_object('principalId',p.id,'revision',s.revision,'authVersion',p.auth_version,
 'rightId',r.id,'purpose',r.purpose,'expiresAt',r.expires_at,'consumedAt',r.consumed_at,'revokedAt',r.revoked_at)
 FROM principals p JOIN password_setup_states s ON s.principal_id=p.id LEFT JOIN password_setup_rights r ON r.id=s.latest_right_id WHERE p.id=? AND p.kind='human'`,principal);}
