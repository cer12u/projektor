// @module identity
// @role private-management
import type { Permission } from "../../../modules/identity/dto";
import type { AuthDB,Authenticated } from './db';
import {currentCredentialSql,currentPermissionsSql} from "./authorization";
import {executeMutation,readMutationResult,recoverMutation,type MutationAdapter,type MutationTarget,type ReadPolicyFor,} from "../persistence/transaction";
import {MutationError,type Json} from "../persistence/public";
import {sql,type Sql} from "../primitives";

import {managementKinds as kinds,managementAuthority,type ManagementCommand} from "../../../modules/identity/rules";
export {type ManagementCommand} from "../../../modules/identity/rules";
import type {ManagementPlan,ManagementPlanningRead} from "../../../modules/identity/ports";
import type {ManagementSnapshot} from "../../../modules/identity/public";
import {failedChange} from "../persistence/outcomes";
function globalOperation(kind:string):boolean{return managementAuthority(kind)==='global-administrator';}
function visible(t: MutationTarget): Sql {
  if(t.kind==='management.membership.set')
    return sql('EXISTS(SELECT 1 FROM principal_project_records WHERE principal_id=? AND project_id=?)',t.targetId,t.projectId);
  if(t.kind==='management.principal.update'||t.kind==='management.principal.create'){
    return sql('EXISTS(SELECT 1 FROM principals WHERE id=?)',t.targetId);
  }
  if(t.kind==='management.credential.scope')return sql('EXISTS(SELECT 1 FROM credential_project_records WHERE credential_id=? AND project_id=?)',t.targetId,t.projectId);
  return sql('EXISTS(SELECT 1 FROM api_credentials WHERE id=?)',t.targetId);
}
export function managementSnapshot(t: MutationTarget): Sql {
  if(t.kind==='management.membership.set')return sql(`SELECT json_object('principalId',r.principal_id,'projectId',r.project_id,'revision',r.revision,
    'permissions',json((SELECT json_group_array(permission) FROM(SELECT permission FROM memberships WHERE principal_id=r.principal_id AND project_id=r.project_id ORDER BY permission))))
    FROM principal_project_records r WHERE r.principal_id=? AND r.project_id=?`,t.targetId,t.projectId);
  if(t.kind==='management.principal.update'||t.kind==='management.principal.create')return sql(`SELECT json_object('principalId',p.id,'kind',p.kind,'displayName',p.display_name,'active',p.active,
    'authVersion',p.auth_version,'globalAdministrator',r.global_administrator,'revision',r.revision)
    FROM principals p JOIN principal_management r ON r.principal_id=p.id WHERE p.id=?`,t.targetId);
  if(t.kind==='management.credential.revoke')return sql(`SELECT json_object('credentialId',c.id,'principalId',c.principal_id,'expiresAt',c.expires_at,
    'revokedAt',c.revoked_at,'revision',r.revision) FROM api_credentials c JOIN credential_management r ON r.credential_id=c.id WHERE c.id=?`,t.targetId);
  return sql(`SELECT json_object('credentialId',c.id,'principalId',c.principal_id,'expiresAt',c.expires_at,'revokedAt',c.revoked_at,
    'revision',r.revision,'projectId',?,'permissions',json((SELECT json_group_array(permission) FROM(SELECT permission FROM api_grants
      WHERE credential_id=c.id AND project_id=? ORDER BY permission))))
    FROM api_credentials c JOIN credential_management r ON r.credential_id=c.id WHERE c.id=?`,t.projectId,t.projectId,t.targetId);
}
function resource(t: MutationTarget): {table:string;where:Sql} {
  if(t.kind==='management.membership.set')return {table:'principal_project_records',where:sql('principal_id=? AND project_id=?',t.targetId,t.projectId)};
  if(t.kind==='management.principal.update')return {table:'principal_management',where:sql('principal_id=?',t.targetId)};
  return {table:'credential_management',where:sql('credential_id=?',t.targetId)};
}
export function managementPolicies(): ReadPolicyFor {
  return kind=>kind==='management.principal.create'?{visible,authority:'global-administrator'}:kinds.some(k=>k===kind)?{visible,authority:globalOperation(kind)?'global-administrator':'project'}:undefined;
}
async function before(db: AuthDB, auth: Authenticated, command: ManagementCommand): Promise<string> {
  const credential=currentCredentialSql(auth),rights=globalOperation(command.kind)
    ?sql('EXISTS(SELECT 1 FROM principal_management WHERE principal_id=? AND global_administrator=1)',auth.id)
    :currentPermissionsSql(auth,command.projectId,['view','manage']);
  const target=visible(command),current=managementSnapshot(command);
  const q=sql(`SELECT (${credential.text}) AS authenticated,(${rights.text}) AND (${target.text}) AS permitted,
    CASE WHEN (${credential.text}) AND (${rights.text}) AND (${target.text}) THEN (${current.text}) ELSE NULL END AS snapshot`,
    ...credential.values,...rights.values,...target.values,...credential.values,...rights.values,...target.values,...current.values);
  const row=await db.prepare(q.text).bind(...q.values).first<{authenticated:number;permitted:number;snapshot:string|null}>();
  if(!row?.authenticated)throw new MutationError(401,'unauthenticated');
  if(!row.permitted||row.snapshot===null)throw new MutationError(403,'forbidden');
  return row.snapshot;
}
function adapter(auth: Authenticated, plan:ManagementPlan): MutationAdapter<Json> {
  const command=plan.command,old=JSON.stringify(plan.expected);
  const r=resource(command),current=managementSnapshot(command);
  const parsed: {permissions?:Permission[]}=JSON.parse(old) as {permissions?:Permission[]};
  const oldCount=parsed.permissions?.length??0;
  return {
    authority:globalOperation(command.kind)?'global-administrator':'project',
    permissions:globalOperation(command.kind)?[]:['manage'],visible,current:managementSnapshot,
    preconditions:()=>[
      ...(command.kind==='management.membership.set'?[{reason:'target_inactive',valid:sql('EXISTS(SELECT 1 FROM principals WHERE id=? AND active=1)',command.targetId)}]:[]),
      ...(command.kind==='management.credential.scope'?[{reason:'credential_inactive',valid:sql(`EXISTS(SELECT 1 FROM api_credentials c JOIN principals p ON p.id=c.principal_id
        WHERE c.id=? AND c.revoked_at IS NULL AND c.expires_at>unixepoch() AND p.active=1)`,command.targetId)}]:[]),
      {reason:'revision_conflict',valid:sql(`EXISTS(SELECT 1 FROM ${r.table} WHERE ${r.where.text} AND revision=?)`,...r.where.values,command.input.revision)},
      {reason:'target_changed',valid:sql(`(${current.text})=?`,...current.values,old)},
    ],
    updates:()=>{
      const writes=[{statement:sql(`UPDATE ${r.table} SET before_snapshot=(${current.text}),revision=revision+1 WHERE ${r.where.text} AND revision=?`,
        ...current.values,...r.where.values,command.input.revision),expectedChanges:1}];
      if(command.kind==='management.membership.set'||command.kind==='management.credential.scope'){
        const membership=command.kind==='management.membership.set',table=membership?'memberships':'api_grants',column=membership?'principal_id':'credential_id';
        if(oldCount>0)writes.push({statement:sql(`DELETE FROM ${table} WHERE ${column}=? AND project_id=?`,command.targetId,command.projectId),expectedChanges:oldCount});
        if(command.input.permissions.length>0)writes.push({statement:sql(`INSERT INTO ${table}(${column},project_id,permission)
          SELECT ?,?,value FROM json_each(?)`,command.targetId,command.projectId,JSON.stringify(command.input.permissions)),expectedChanges:command.input.permissions.length});
      }else if(command.kind==='management.principal.update'){
        if(!plan.principal)throw new MutationError(500,'invalid_principal_plan');
        writes.push({statement:sql('UPDATE principals SET display_name=?,auth_version=?,active=? WHERE id=?',plan.principal.displayName,plan.principal.authVersion,plan.principal.active,command.targetId),expectedChanges:1});
      }else writes.push({statement:sql('UPDATE api_credentials SET revoked_at=COALESCE(revoked_at,unixepoch()) WHERE id=?',command.targetId),expectedChanges:1});
      return writes;
    },
    history:c=>[{statement:sql(`INSERT INTO management_audit(actor_id,operation_id,actor_display_name,operation_kind,target_id,project_id,
      before_revision,after_revision,before_snapshot,after_snapshot,recorded_at)
      SELECT ?,?,(SELECT display_name FROM principals WHERE id=?),?,?,?,?,revision,before_snapshot,(${current.text}),unixepoch()
      FROM ${r.table} WHERE ${r.where.text}`,
      auth.id,c.operationId,auth.id,command.kind,command.targetId,command.projectId,command.input.revision,...current.values,...r.where.values),expectedChanges:1}],
    snapshot:()=>current,
  };
}
/** Receipt-first read preserves authorized replay even when the current state has moved on. */
export async function readManagementForChange(db:AuthDB,auth:Authenticated,command:ManagementCommand):Promise<ManagementPlanningRead>{
 try{
  const recovered=await recoverMutation(db,auth,command,managementPolicies());
  if(recovered)return{kind:'outcome',outcome:{application:'confirmed',disclosure:'allowed',source:'recovered',receipt:{operationId:command.operationId,snapshot:recovered.snapshot as unknown as ManagementSnapshot}}};
  return{kind:'observed',snapshot:JSON.parse(await before(db,auth,command)) as ManagementSnapshot};
 }catch(error){return{kind:'outcome',outcome:failedChange<ManagementSnapshot>(command.operationId,error)};}
}
export function executeManagement(db:AuthDB,auth:Authenticated,plan:ManagementPlan){
 return executeMutation(db,auth,plan.command,adapter(auth,plan),managementPolicies());
}
export function readManagementResult(db: AuthDB, auth: Authenticated, operationId: string) {
  return readMutationResult(db,auth,operationId,managementPolicies());
}
