// @module identity
// @role private-permissions
import type { AuthDB,Authenticated } from './auth-types';
import {currentCredentialSql} from "./authorization";
import {MutationError} from "../persistence/public";
import {sql} from "../primitives";

export {PERMISSIONS,isPermission} from "../../../modules/identity/public";
export {permissionSql,requirePermission} from "./authorization";
import {permissionSql} from "./authorization";
export interface DisplayPrincipal { id:string; kind:'human'|'agent'; displayName:string; active:boolean }
/** Historical/project display only. This never creates membership or authorizes login as that principal. */
export async function displayPrincipal(db: AuthDB, auth: Authenticated, projectId: string, principalId: string): Promise<DisplayPrincipal> {
  const credential=currentCredentialSql(auth), rights=permissionSql(auth,projectId,'view');
  const visible=sql('EXISTS(SELECT 1 FROM principal_project_records WHERE principal_id=? AND project_id=?)',principalId,projectId);
  const allowed=sql(`(${credential.text}) AND (${rights.text}) AND (${visible.text})`,...credential.values,...rights.values,...visible.values);
  const q=sql(`SELECT (${credential.text}) AS authenticated, (${rights.text}) AND (${visible.text}) AS permitted,
    CASE WHEN ${allowed.text} THEN (SELECT json_object('id',id,'kind',kind,'displayName',display_name,'active',active)
      FROM principals WHERE id=?) ELSE NULL END AS display`,
    ...credential.values,...rights.values,...visible.values,...allowed.values,principalId);
  let row: {authenticated:number;permitted:number;display:string|null} | null;
  try { row=await db.prepare(q.text).bind(...q.values).first<{authenticated:number;permitted:number;display:string|null}>(); }
  catch { throw new MutationError(503,'authorization_unavailable'); }
  if (!row?.authenticated) throw new MutationError(401,'unauthenticated');
  if (!row.permitted||row.display===null) throw new MutationError(403,'forbidden');
  // The JSON shape is produced solely by the bound SQL above, never accepted as an authentication reference.
  const data: {id:string;kind:'human'|'agent';displayName:string;active:number}=JSON.parse(row.display) as {id:string;kind:'human'|'agent';displayName:string;active:number};
  return {...data,active:data.active===1};
}
