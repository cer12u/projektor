// @module administration
// @role transport
import {request} from '../session/access';
import type {OwnerSetupStatus} from "../../modules/identity/public";
const root='/api/auth/password-setup/owner-initial';
function post<T>(suffix:string,csrf:string,input:unknown):Promise<T>{
  return request<T>(root+suffix,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(input)});
}
export function prepareOwnerContext(csrf:string,operationId?:string):Promise<{expiresAt:number}>{
  return post('/context',csrf,operationId?{operationId}:{});
}
async function status(suffix:string,csrf:string,operationId:string,password?:string):Promise<OwnerSetupStatus>{
  const result=await post<unknown>(suffix,csrf,{operationId,...(password!==undefined?{password}:{})});
  if(!result||typeof result!=='object')throw new Error('invalid_owner_status');
  const value=result as Record<string,unknown>;
  if(value.operationId!==operationId||typeof value.principalId!=='string'||!value.principalId||
    !['ready','completed'].includes(value.state as string)||typeof value.expiresAt!=='number'||!Number.isFinite(value.expiresAt)||value.expiresAt<=0||
    ('setupRight'in value)||value.state==='completed'&&(!Number.isSafeInteger(value.completedAuthVersion)||(value.completedAuthVersion as number)<1))throw new Error('invalid_owner_status');
  return {principalId:value.principalId,operationId,state:value.state as 'ready'|'completed',expiresAt:value.expiresAt,...(value.state==='completed'?{completedAuthVersion:value.completedAuthVersion as number}:{})};
}
export const issueOwnerSetup=(csrf:string,operationId:string)=>status('',csrf,operationId);
export const readOwnerSetup=(csrf:string,operationId:string)=>status('/status',csrf,operationId);
export const completeOwnerSetup=(csrf:string,operationId:string,password:string)=>status('/complete',csrf,operationId,password);
