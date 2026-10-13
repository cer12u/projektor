// @module identity
// @role private-principal-provision
/** Shared checked registration builder. This supplies no authority and never issues credentials. */
import type { CountedWrite } from "../persistence/guarded-batch";
import {sql} from "../primitives";
import {type PrincipalProvision} from "../../../modules/identity/rules";
export type {PrincipalProvision,ProjectRights} from "../../../modules/identity/rules";
export function preparePrincipalProvision(raw:PrincipalProvision){
 const normalized=raw,{principalId,projects}=normalized;
 const guard=sql('NOT EXISTS(SELECT 1 FROM principals WHERE id=? OR (? IS NOT NULL AND login_id=?))',principalId,raw.loginId,raw.loginId);
 const writes:CountedWrite[]=[{expectedChanges:1,statement:sql('INSERT INTO principals VALUES(?,?,?,?,1,1)',principalId,raw.kind,raw.displayName,raw.loginId)}];
 if(raw.globalAdministrator)writes.push({expectedChanges:1,statement:sql('UPDATE principal_management SET global_administrator=1 WHERE principal_id=? AND global_administrator=0',principalId)});
 for(const p of projects)for(const permission of p.permissions)writes.push({expectedChanges:1,statement:sql('INSERT INTO memberships VALUES(?,?,?)',principalId,p.projectId,permission)});
 return {normalized,guard,writes};
}
