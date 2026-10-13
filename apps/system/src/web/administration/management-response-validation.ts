// @module administration
// @role model
import type {Permission} from "../../modules/identity/dto";
import type {ManagementRecord} from './management-contracts';
import {object,identifier,integer,permissions} from './management-validation';
/** Only non-secret, documented fields from a successful management result are accepted. */
export function managementRecord(value:unknown):ManagementRecord {
  const s=object(value);if(!identifier(s.principalId)||!integer(s.revision))throw new Error('invalid_management_response');
  let kind:ManagementRecord['kind'],allowed:string[];
  if(s.credentialId!==undefined){
    if(!identifier(s.credentialId)||!integer(s.expiresAt)||(s.revokedAt!==null&&!integer(s.revokedAt)))throw new Error('invalid_management_response');
    kind=s.projectId===undefined?'credential':'scope';allowed=['credentialId','principalId','revision','expiresAt','revokedAt'];
  }else if(s.projectId!==undefined){kind='membership';allowed=['principalId','revision'];}
  else {
    if(!['human','agent'].includes(s.kind as string)||typeof s.displayName!=='string'||!s.displayName.trim()||![0,1].includes(s.active as number)||!integer(s.authVersion)||![0,1].includes(s.globalAdministrator as number))throw new Error('invalid_management_response');
    kind='principal';allowed=['principalId','revision','kind','displayName','active','authVersion','globalAdministrator'];
  }
  if(kind==='membership'||kind==='scope'){
    if(!identifier(s.projectId)||!permissions(s.permissions))throw new Error('invalid_management_response');allowed.push('projectId','permissions');
  }
  if(Object.keys(s).some(k=>!allowed.includes(k)))throw new Error('invalid_management_response');
  return {kind,snapshot:s} as unknown as ManagementRecord;
}
export function managementTarget(record:ManagementRecord):string{return record.kind==='credential'||record.kind==='scope'?record.snapshot.credentialId:record.snapshot.principalId;}
export function sameManagementTarget(a:ManagementRecord,b:ManagementRecord):boolean{return a.kind===b.kind&&managementTarget(a)===managementTarget(b)&&a.snapshot.principalId===b.snapshot.principalId&&(('projectId'in a.snapshot?a.snapshot.projectId:null)===('projectId'in b.snapshot?b.snapshot.projectId:null));}
/** Creation audit metadata only; it never supplies current membership or authority. */
export function historyInitialProjects(value:unknown):{projectId:string;permissions:Permission[]}[] {
  if(!Array.isArray(value)||value.length>64)throw new Error('invalid_initial_projects');
  const result=value.map((entry:unknown)=>{const p=object(entry);if(Object.keys(p).some(k=>!['projectId','permissions'].includes(k))||!identifier(p.projectId)||!permissions(p.permissions))throw new Error('invalid_initial_projects');return{projectId:p.projectId,permissions:[...p.permissions]};});
  if(new Set(result.map(p=>p.projectId)).size!==result.length)throw new Error('invalid_initial_projects');return result;
}
