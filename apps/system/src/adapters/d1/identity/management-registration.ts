// @module identity
// @role private-registration
/** Authenticated HTTP registration reuses the private provisioning builder, never its privileged commit. */
import type { AuthDB,Authenticated } from './db';
import { managementPolicies,managementSnapshot } from './management';
import {currentCredentialSql,currentPermissionsSql} from "./authorization";
import {executeMutation,type MutationAdapter} from "../persistence/transaction";
import {MutationError,type Json} from "../persistence/public";
import {sql} from "../primitives";
import { preparePrincipalProvision } from './principal-provision';
import type {PrincipalRegistration} from "../../../modules/identity/rules";
export async function preparePrincipalRegistration(db:AuthDB,auth:Authenticated,registration:PrincipalRegistration){
 const {operationId,principal}=registration,prepared=preparePrincipalProvision(principal),input=prepared.normalized;
 const projectRights=currentPermissionsSql(auth,sql("json_extract(managed_project.value,'$.projectId')"),['view','manage']);
 const managedProjects=sql(`NOT EXISTS(SELECT 1 FROM json_each(?) managed_project WHERE NOT (${projectRights.text}))`,JSON.stringify(input.projects),...projectRights.values);
 const credential=currentCredentialSql(auth),rights=sql(`EXISTS(SELECT 1 FROM principal_management WHERE principal_id=? AND global_administrator=1) AND (${managedProjects.text})`,auth.id,...managedProjects.values);
 const row=await db.prepare(`SELECT (${credential.text}) AS authenticated,(${rights.text}) AS permitted`).bind(...credential.values,...rights.values).first<{authenticated:number;permitted:number}>();
 if(!row?.authenticated)throw new MutationError(401,'unauthenticated');if(!row.permitted)throw new MutationError(403,'forbidden');
 const command={operationId,kind:'management.principal.create',targetId:input.principalId,projectId:'GLOBAL',input:input as unknown as Json};
 const snapshot=managementSnapshot(command);
 const adapter:MutationAdapter<Json>={
  authority:'global-administrator',permissions:[],visible:()=>managedProjects,current:managementSnapshot,
  preconditions:()=>[{reason:'principal_exists',valid:prepared.guard}],updates:()=>prepared.writes,
  history:()=>[{expectedChanges:1,statement:sql(`INSERT INTO management_audit(actor_id,operation_id,actor_display_name,operation_kind,target_id,project_id,before_revision,after_revision,before_snapshot,after_snapshot,recorded_at)
  VALUES(?,?,(SELECT display_name FROM principals WHERE id=?),'management.principal.create',?,'GLOBAL',0,1,'null',json_set((${snapshot.text}),'$.initialProjects',json(?)),unixepoch())`,auth.id,operationId,auth.id,input.principalId,...snapshot.values,JSON.stringify(input.projects))}],snapshot:()=>snapshot,
 };
 return{command,adapter,policyFor:managementPolicies()};
}
export async function registerManagementPrincipal(db:AuthDB,auth:Authenticated,body:PrincipalRegistration){
 const prepared=await preparePrincipalRegistration(db,auth,body);
 return executeMutation(db,auth,prepared.command,prepared.adapter,prepared.policyFor);
}
