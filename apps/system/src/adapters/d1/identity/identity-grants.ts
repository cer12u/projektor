// @module identity
// @role private-grants
import type { Permission } from "../../../modules/identity/dto";
import type { AuthDB,Authenticated } from './auth-types';
import { ApiError } from "../../protocol-errors";
import {credentialCeilingSql,currentCredentialSql} from "./authorization";
import {sql} from "../primitives";
export async function grants(db: AuthDB, auth: Authenticated, now: number): Promise<{project_id:string;permission:Permission}[]> {
  void now; // Credential checks use SQL execution time; preserve the existing call contract.
  const valid=currentCredentialSql(auth), ceiling=credentialCeilingSql(auth,sql('m.project_id'),sql('m.permission'));
  const row=await db.prepare(`SELECT (${valid.text}) authenticated, CASE WHEN (${valid.text}) THEN
    (SELECT json_group_array(json_object('project_id',project_id,'permission',permission)) FROM
      (SELECT m.project_id,m.permission FROM memberships m WHERE m.principal_id=? AND (${ceiling.text})
       ORDER BY m.project_id,m.permission)) ELSE NULL END data`)
    .bind(...valid.values,...valid.values,auth.id,...ceiling.values).first<{authenticated:number;data:string|null}>();
  if(!row?.authenticated)throw new ApiError(401,'unauthenticated');
  if(row.data===null)throw new ApiError(503,'authorization_unavailable');
  // Shape and values come only from the fixed SQL projection above.
  return JSON.parse(row.data) as {project_id:string;permission:Permission}[];
}
