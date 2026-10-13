// @module administration
// @role model
import type {ManagementRecord,ManagementDraft,PrincipalRegistration} from './management-contracts';
import {managementTarget} from './management-response-validation';
import {managementIdPattern,object,identifier,permissions} from './management-validation';
export function managementQuery(kind:ManagementRecord['kind'],projectId?:string,after?:string):string {
  const query=new URLSearchParams({kind});
  if(kind==='membership'||kind==='scope'){if(!projectId||!managementIdPattern.test(projectId))throw new Error('invalid_project');query.set('projectId',projectId);}
  if(after)query.set('after',after);return query.toString();
}
export function managementChange(record:ManagementRecord,draft:ManagementDraft):{path:string;method:string;body:Record<string,unknown>} {
  if(!Number.isSafeInteger(record.snapshot.revision)||record.snapshot.revision<1||record.snapshot.revision>=Number.MAX_SAFE_INTEGER)throw new Error('invalid_revision');
  const id=encodeURIComponent(managementTarget(record)),body:Record<string,unknown>={revision:record.snapshot.revision};
  if(record.kind==='principal'){
    if(!draft.displayName.trim()||new TextEncoder().encode(draft.displayName).length>256||typeof draft.active!=='boolean')throw new Error('invalid_display_name');
    body.displayName=draft.displayName;body.active=draft.active;
    return{path:`/api/management/principals/${id}`,method:'PATCH',body};
  }
  if(record.kind==='credential'){
    if(record.snapshot.revokedAt!==null)throw new Error('credential_already_revoked');
    return{path:`/api/management/credentials/${id}/revoke`,method:'POST',body};
  }
  if(!permissions(draft.permissions)||(draft.permissions.length>0&&!draft.permissions.includes('view')))throw new Error('view_required');
  body.permissions=[...draft.permissions].sort();
  return{path:`/api/projects/${encodeURIComponent(record.snapshot.projectId)}/${record.kind==='membership'?'memberships':'credential-scopes'}/${id}`,method:'PUT',body};
}
export function registrationInput(value:unknown):PrincipalRegistration {
  const input=object(value);
  if(Object.keys(input).some(k=>!['operationId','principalId','kind','displayName','loginId','projects'].includes(k))||!identifier(input.operationId)||!identifier(input.principalId)||!['human','agent'].includes(input.kind as string)||typeof input.displayName!=='string'||!input.displayName.trim()||new TextEncoder().encode(input.displayName).length>256)throw new Error('invalid_registration');
  if(input.kind==='human'?(typeof input.loginId!=='string'||!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(input.loginId)):input.loginId!==null)throw new Error('invalid_registration');
  if(!Array.isArray(input.projects)||input.projects.length>64)throw new Error('invalid_registration');
  const projects=input.projects.map((v:unknown)=>{const p=object(v);if(Object.keys(p).some(k=>!['projectId','permissions'].includes(k))||!identifier(p.projectId)||!permissions(p.permissions)||p.permissions.length===0||!p.permissions.includes('view'))throw new Error('invalid_registration');return{projectId:p.projectId,permissions:p.permissions};});
  if(new Set(projects.map(p=>p.projectId)).size!==projects.length)throw new Error('invalid_registration');
  return{operationId:input.operationId,principalId:input.principalId,kind:input.kind as 'human'|'agent',displayName:input.displayName,loginId:input.loginId as string|null,projects};
}
