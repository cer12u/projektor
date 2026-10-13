// @module workbench
// @role storage
/** Tab-local and actor-partitioned. A failed write must prevent command dispatch. */
const key=(owner:string)=>'projektor-work-directory:'+owner;
export function readProjectState(owner:string):unknown {
 const raw=sessionStorage.getItem(key(owner));
 return raw===null?null:JSON.parse(raw) as unknown;
}
export function writeProjectState(owner:string,value:unknown):void {
 const encoded=JSON.stringify(value);
 sessionStorage.setItem(key(owner),encoded);
 if(sessionStorage.getItem(key(owner))!==encoded)throw new Error('directory_storage_unavailable');
}
export function removeProjectState(owner:string):void {
 sessionStorage.removeItem(key(owner));
 if(sessionStorage.getItem(key(owner))!==null)throw new Error('directory_storage_unavailable');
}
