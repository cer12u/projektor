// @module administration
// @role storage
export type ManagementStorageKind='edit'|'registration'|'registration-draft';
const key=(kind:ManagementStorageKind,owner:string)=>'projektor-management-'+kind+':'+owner;
export const readManagementState=(kind:ManagementStorageKind,owner:string)=>sessionStorage.getItem(key(kind,owner));
export const writeManagementState=(kind:ManagementStorageKind,owner:string,value:unknown)=>sessionStorage.setItem(key(kind,owner),JSON.stringify(value));
export const removeManagementState=(kind:ManagementStorageKind,owner:string)=>sessionStorage.removeItem(key(kind,owner));
