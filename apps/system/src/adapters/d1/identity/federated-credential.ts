// @module identity
// @role private-binding
import type { VerifiedAccessAssertion } from "../../../modules/identity/access-policy";
import type { AuthDB,FederatedAuthenticated,SubjectRow } from './auth-types';
import { ApiError } from "../../protocol-errors";
interface BindingRow extends SubjectRow {binding_id:string;federated_credential_id:string;credential_revision:number}
export async function resolveFederatedCredential(db:AuthDB,assertion:VerifiedAccessAssertion,now:number):Promise<FederatedAuthenticated>{
 let row:BindingRow|null;
 try {row=await db.prepare(`SELECT p.id,p.kind,p.display_name,p.auth_version,b.id binding_id,
   c.id federated_credential_id,c.revision credential_revision
   FROM federated_bindings b JOIN federated_credentials c ON c.binding_id=b.id JOIN principals p ON p.id=b.principal_id
   WHERE b.issuer=? AND b.audience=? AND b.subject=? AND p.kind='agent' AND p.active=1
   AND c.principal_auth_version=p.auth_version AND c.revoked_at IS NULL AND c.expires_at>max(?,unixepoch())
   AND ?>unixepoch() AND ?<=unixepoch()`)
   .bind(assertion.issuer,assertion.audience,assertion.subject,now,assertion.expiresAt,assertion.notBefore).first<BindingRow>();}
 catch {throw new ApiError(503,'authorization_unavailable');}
 if(!row)throw new ApiError(403,'federation_forbidden');
 return {...row,authentication:'federated',token_hash:null,credential_id:null,csrf_token:null,
  issuer:assertion.issuer,audience:assertion.audience,subject:assertion.subject,assertion_expires_at:assertion.expiresAt,assertion_not_before:assertion.notBefore};
}
