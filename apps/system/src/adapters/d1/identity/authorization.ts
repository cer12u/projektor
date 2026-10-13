// @module identity
// @role transaction-spi
/** Private participant: evaluated inside protected SQL, never a preauthorization token. */
import type {Permission} from "../../../modules/identity/dto";
import type {AuthDB} from "../primitives";
import {isPermission} from "../../../modules/identity/public";
import type {Authenticated} from "./auth-types";
import {IDLE_SECONDS} from "../../../modules/identity/session-policy";
import {MutationError} from "../persistence/public";
import {sql,type Sql} from "../primitives";
export type {Authenticated,SubjectRow,FederatedAuthenticated,LegacyAuthenticated} from "./auth-types";
/** Evaluated by SQLite at query/batch execution time, never with the earlier authentication timestamp. */
export function credentialValid(auth: Authenticated): Sql {
  const credential = auth.authentication === 'federated'
    ? sql(`? > unixepoch() AND ? <= unixepoch() AND EXISTS(SELECT 1 FROM federated_credentials c
        JOIN federated_bindings b ON b.id=c.binding_id WHERE c.id=? AND c.revision=? AND b.id=?
        AND p.kind='agent' AND b.principal_id=p.id AND b.issuer=? AND b.audience=? AND b.subject=?
        AND c.principal_auth_version=p.auth_version AND c.revoked_at IS NULL AND c.expires_at>unixepoch())`,
      auth.assertion_expires_at,auth.assertion_not_before,auth.federated_credential_id,auth.credential_revision,
      auth.binding_id,auth.issuer,auth.audience,auth.subject)
    : auth.authentication === 'api'
    ? sql(`EXISTS(SELECT 1 FROM api_credentials c WHERE c.id=? AND c.token_hash=? AND c.principal_id=p.id
        AND p.kind='agent' AND c.revoked_at IS NULL AND c.expires_at>unixepoch())`, auth.credential_id, auth.token_hash)
    : sql(`EXISTS(SELECT 1 FROM sessions s LEFT JOIN api_credentials c ON c.id=s.api_credential_id
        WHERE s.token_hash=? AND s.principal_id=p.id AND s.auth_version=p.auth_version
        AND s.api_credential_id IS ? AND s.revoked_at IS NULL AND s.absolute_expires_at>unixepoch()
        AND s.last_seen_at>unixepoch()-?
        AND (s.api_credential_id IS NULL OR (c.principal_id=p.id AND c.revoked_at IS NULL AND c.expires_at>unixepoch())))`,
      auth.token_hash, auth.credential_id, IDLE_SECONDS);
  return sql(`EXISTS(SELECT 1 FROM principals p WHERE p.id=? AND p.kind=? AND p.active=1 AND p.auth_version=?
    AND (${credential.text}))`, auth.id, auth.kind, auth.auth_version, ...credential.values);
}
/** Credential ceiling only; caller also checks current credential and principal membership. */
export function credentialCeilingSql(auth: Authenticated, project: Sql, permission: Sql): Sql {
  if(auth.authentication==='federated')return sql(`EXISTS(SELECT 1 FROM federated_grants g WHERE g.credential_id=?
    AND g.project_id=${project.text} AND g.permission=${permission.text})`,auth.federated_credential_id,...project.values,...permission.values);
  if(auth.authentication==='api')return sql(`EXISTS(SELECT 1 FROM api_grants g WHERE g.credential_id=?
    AND g.project_id=${project.text} AND g.permission=${permission.text})`,auth.credential_id,...project.values,...permission.values);
  if(auth.authentication!=='session')throw new MutationError(401,'unauthenticated');
  if(auth.credential_id===null)return sql('1');
  return sql(`EXISTS(SELECT 1 FROM api_grants g WHERE g.credential_id=? AND g.project_id=${project.text}
    AND g.permission=${permission.text}) AND EXISTS(SELECT 1 FROM sessions ceiling WHERE ceiling.token_hash=?
    AND (ceiling.scope_ceiling_json IS NULL OR EXISTS(SELECT 1 FROM json_each(ceiling.scope_ceiling_json) allowed
      WHERE json_extract(allowed.value,'$.projectId')=${project.text} AND json_extract(allowed.value,'$.permission')=${permission.text})))`,
    auth.credential_id,...project.values,...permission.values,auth.token_hash,...project.values,...permission.values);
}
function permissionsValid(auth: Authenticated, project: string | Sql, permissionsJson: string | Sql): Sql {
  const projectSql=typeof project==='string'?sql('?',project):project;
  const ceiling=credentialCeilingSql(auth,sql('m.project_id'),sql('m.permission'));
  const wanted=typeof permissionsJson==='string'?sql('?',permissionsJson):permissionsJson;
  return sql(`NOT EXISTS(SELECT 1 FROM json_each(${wanted.text}) wanted WHERE NOT EXISTS(
    SELECT 1 FROM memberships m WHERE m.principal_id=? AND m.project_id=${projectSql.text} AND m.permission=wanted.value
    AND (${ceiling.text})))`,...wanted.values,auth.id,...projectSql.values,...ceiling.values);
}
/** Trusted SQL permission-set expression; never accepts caller SQL. */
export function currentPermissionSetSql(auth:Authenticated,projectId:string|Sql,permissionsJson:Sql):Sql {
  return permissionsValid(auth,projectId,permissionsJson);
}
/** Shared P1a credential predicate for callers that need a single guarded SELECT. */
export function currentCredentialSql(auth: Authenticated): Sql { return credentialValid(auth); }
/** Explicit permission intersection. No hierarchy or membership insertion; callers pair it with credential validity. */
export function currentPermissionsSql(auth: Authenticated, projectId: string | Sql, permissions: readonly Permission[]): Sql {
  return permissionsValid(auth, projectId, JSON.stringify([...new Set(permissions)].sort()));
}
export function authorityValid(auth: Authenticated, authority: 'project'|'global-administrator', project: string, permissions: string | Sql): Sql {
  return authority==='global-administrator'
    ? sql('EXISTS(SELECT 1 FROM principal_management WHERE principal_id=? AND global_administrator=1)',auth.id)
    : permissionsValid(auth,project,permissions);
}

/** Every capability remains explicit. Non-view operations also require view, matching the P2-01 contract. */
export function permissionSql(auth: Authenticated, projectId: string, permission: Permission): Sql {
  return currentPermissionsSql(auth,projectId,['view',permission]);
}
export async function requirePermission(db: AuthDB, auth: Authenticated, projectId: string, permission: Permission): Promise<void> {
  if (!isPermission(permission)) throw new MutationError(400,'invalid_permission');
  const credential=currentCredentialSql(auth), rights=permissionSql(auth,projectId,permission);
  const q=sql(`SELECT (${credential.text}) AS authenticated, (${rights.text}) AS permitted`,...credential.values,...rights.values);
  let row: {authenticated:number;permitted:number} | null;
  try { row=await db.prepare(q.text).bind(...q.values).first<{authenticated:number;permitted:number}>(); }
  catch { throw new MutationError(503,'authorization_unavailable'); }
  if (!row?.authenticated) throw new MutationError(401,'unauthenticated');
  if (!row.permitted) throw new MutationError(403,'forbidden');
}

/** Private cross-module display projection. Consumers still guard the containing statement. */
export function principalProjectionSql():Sql {
 return sql('SELECT id,kind,display_name,active FROM principals');
}
/** Current assignment eligibility; no sequential read or cached eligibility is issued. */
export function activeViewMembersSql(project:Sql):Sql {
 return sql(`SELECT p.id,p.kind,p.display_name,p.active FROM principals p WHERE p.active=1
  AND EXISTS(SELECT 1 FROM memberships m WHERE m.principal_id=p.id AND m.project_id=${project.text} AND m.permission='view')`,...project.values);
}
/** Current scope projection for a guarded domain directory query. */
export function currentViewScopesSql(auth:Authenticated):Sql {
 const credential=currentCredentialSql(auth),ceiling=credentialCeilingSql(auth,sql('m.project_id'),sql('m.permission'));
 return sql(`SELECT m.project_id scope FROM memberships m WHERE m.principal_id=? AND m.permission='view' AND (${credential.text}) AND (${ceiling.text})`,auth.id,...credential.values,...ceiling.values);
}
