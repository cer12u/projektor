// @module administration
// @role model
import type {Identity} from "../../modules/identity/dto";
import type {ManagementContext,ManagementRecord} from './management-contracts';
export function canManageProject(identity:Identity,projectId:string):boolean{return identity.projects.some(p=>p.id===projectId&&p.permissions.includes('view')&&p.permissions.includes('manage'));}
export function canManageRecord(context:ManagementContext,record:ManagementRecord):boolean {
  const projectId='projectId'in record.snapshot?record.snapshot.projectId:null;
  return projectId!==null
    ?context.globalAdministrator===true||context.projects.some(p=>p.id===projectId&&p.permissions.includes('view')&&p.permissions.includes('manage'))
    :context.globalAdministrator===true;
}
