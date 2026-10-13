// @module administration
// @role storage
// Only this nonsecret operation identifier is durable; capabilities/passwords never enter JS storage.
const key='projektor-owner-initial-operation-v1';
const identifier=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function loadOwnerOperation():string|null {
  const value=localStorage.getItem(key);
  if(value!==null&&!identifier.test(value))throw new Error('invalid_owner_operation');
  return value;
}
export async function reserveOwnerOperation():Promise<{operationId:string;fresh:boolean}> {
  if(!navigator.locks)throw new Error('owner_setup_coordination_unavailable');
  return navigator.locks.request(key,{mode:'exclusive'},()=>{
    const existing=loadOwnerOperation();if(existing)return {operationId:existing,fresh:false};
    const operationId=crypto.randomUUID();
    localStorage.setItem(key,operationId);
    if(loadOwnerOperation()!==operationId)throw new Error('owner_operation_not_persisted');
    return {operationId,fresh:true};
  });
}
export function requireOwnerOperation(operationId:string):void {
  if(loadOwnerOperation()!==operationId)throw new Error('owner_operation_changed');
}
