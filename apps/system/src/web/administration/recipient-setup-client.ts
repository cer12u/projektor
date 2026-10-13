// @module administration
// @role transport
import {request} from '../session/access';
import type {RecipientSetupStatus,RecipientCompletionInput} from '../../modules/identity/public';
const root='/api/auth/password-setup/recipient';
const identifier=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=160;
const expiry=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>0;
function object(v:unknown):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('invalid_recipient_status');return v as Record<string,unknown>;}
function noSecret(v:Record<string,unknown>){if(['setupRight','browserToken','password','token'].some(k=>k in v))throw new Error('unexpected_recipient_secret');}
function post(suffix:string,csrf:string,input:unknown):Promise<unknown>{return request(root+suffix,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(input)});}
export async function prepareRecipientContext(csrf:string,requestId?:string,replacesRequestId?:string):Promise<{requestId:string;expiresAt:number}>{
 const value=object(await post('/context',csrf,requestId?{requestId}:replacesRequestId?{replaceAbandoned:true,replacesRequestId}:{}));noSecret(value);
 if(!identifier(value.requestId)||!expiry(value.expiresAt)||(requestId&&value.requestId!==requestId))throw new Error('invalid_recipient_context');return {requestId:value.requestId,expiresAt:value.expiresAt};
}
function status(input:unknown,requestId:string):RecipientSetupStatus{
 const v=object(input);noSecret(v);if(v.requestId!==requestId||!expiry(v.expiresAt))throw new Error('recipient_context_changed');
 if(v.state==='waiting')return {requestId,state:'waiting',expiresAt:v.expiresAt};
 if(!['ready','completed'].includes(v.state as string)||!identifier(v.principalId)||!identifier(v.operationId)||!identifier(v.issuerId)||typeof v.loginId!=='string'||!v.loginId||typeof v.displayName!=='string'||typeof v.issuerDisplayName!=='string'||!['initial','reset'].includes(v.purpose as string)||!Number.isSafeInteger(v.targetAuthVersion)||(v.targetAuthVersion as number)<1||v.state==='completed'&&(!Number.isSafeInteger(v.completedAuthVersion)||(v.completedAuthVersion as number)<1))throw new Error('invalid_recipient_status');
 return {requestId,state:v.state as 'ready'|'completed',expiresAt:v.expiresAt,principalId:v.principalId,operationId:v.operationId,issuerId:v.issuerId,loginId:v.loginId,displayName:v.displayName,issuerDisplayName:v.issuerDisplayName,purpose:v.purpose as 'initial'|'reset',targetAuthVersion:v.targetAuthVersion as number,...(v.state==='completed'?{completedAuthVersion:v.completedAuthVersion as number}:{})};
}
export async function readRecipientSetup(csrf:string,requestId:string):Promise<RecipientSetupStatus>{return status(await post('/status',csrf,{}),requestId);}
export async function completeRecipientSetup(csrf:string,requestId:string,input:RecipientCompletionInput):Promise<RecipientSetupStatus>{const value=status(await post('/complete',csrf,input),requestId);if(value.state!=='completed')throw new Error('invalid_recipient_completion');return value;}
export async function abandonRecipientContext(csrf:string,requestId:string):Promise<{abandoned:true}|{abandoned:false;reason:'context_missing'}>{
 const value=object(await post('/abandon',csrf,{requestId}));noSecret(value);if(value.abandoned===true)return {abandoned:true};if(value.abandoned===false&&value.reason==='context_missing')return {abandoned:false,reason:'context_missing'};throw new Error('invalid_recipient_abandonment');
}
