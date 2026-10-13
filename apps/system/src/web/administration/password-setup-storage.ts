// @module administration
// @role storage
import type {Target} from './password-setup-contracts';
export interface RecipientOperation {operationId:string;principalId:string;purpose:Target['purpose'];expiresAt:number}
const prefix='projektor-password-recipient-v1:';
// The high-entropy right's digest is a local correlation key, never an API proof.
// Recovering authority still requires the original bearer entered by its holder.
export async function recipientKey(right:string):Promise<string>{
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode('password-recipient-v1\0'+right));
 return prefix+Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,'0')).join('');
}
export function loadRecipientOperation(key:string):RecipientOperation|null{
 const raw=localStorage.getItem(key);if(raw===null)return null;const parsed:unknown=JSON.parse(raw);
 if(!parsed||typeof parsed!=='object')throw new Error('invalid_recipient_operation');const value=parsed as Record<string,unknown>;
 if(!value||typeof value!=='object'||Object.keys(value).sort().join(',')!=='expiresAt,operationId,principalId,purpose'||
  typeof value.operationId!=='string'||!/^[a-f0-9-]{36}$/.test(value.operationId)||typeof value.principalId!=='string'||!value.principalId||
  !['initial','reset'].includes(value.purpose as string)||typeof value.expiresAt!=='number'||!Number.isFinite(value.expiresAt))throw new Error('invalid_recipient_operation');
 return value as unknown as RecipientOperation;
}
export function matchesRecipient(operation:RecipientOperation,target:Target):boolean{
 return operation.principalId===target.principalId&&operation.purpose===target.purpose&&operation.expiresAt===target.expiresAt;
}
export async function reserveRecipientOperation(key:string,target:Target):Promise<{operation:RecipientOperation;fresh:boolean}>{
 if(!navigator.locks)throw new Error('recipient_coordination_unavailable');
 return navigator.locks.request(key,{mode:'exclusive'},()=>{
  const prior=loadRecipientOperation(key);if(prior){if(!matchesRecipient(prior,target))throw new Error('recipient_target_changed');return {operation:prior,fresh:false};}
  const operation:RecipientOperation={operationId:crypto.randomUUID(),principalId:target.principalId,purpose:target.purpose,expiresAt:target.expiresAt};
  localStorage.setItem(key,JSON.stringify(operation));
  if(JSON.stringify(loadRecipientOperation(key))!==JSON.stringify(operation))throw new Error('recipient_operation_not_persisted');
  return {operation,fresh:true};
 });
}
export function requireRecipientOperation(key:string,operationId:string,principalId:string):RecipientOperation{
 const stored=loadRecipientOperation(key);if(!stored||stored.operationId!==operationId||stored.principalId!==principalId)throw new Error('recipient_operation_changed');return stored;
}
