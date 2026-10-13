// @module delivery
// @role http-adapter
import type {RequestServices} from '../contracts';
import {RECIPIENT_CONTEXT_SECONDS} from '../../modules/identity/public';
import {protocolFailure,resultFailureBody} from './outcomes';
import {cookie,LOGIN_COOKIE,readCookie,requireOrigin} from './security';
import {readJsonInput} from './object-input';
import {ApiError} from '../../adapters/protocol-errors';
const RECIPIENT_COOKIE='__Host-projektor_recipient_setup';
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
const identifier=(value:unknown)=>{if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(value))throw new ApiError(400,'invalid_input');return value;};
export async function recipientSetupApi(request:Request,requests:RequestServices,origin:string):Promise<Response|null>{
 const url=new URL(request.url),path=url.pathname;
 if(!['/api/auth/password-setup/recipient/context','/api/auth/password-setup/recipient/status','/api/auth/password-setup/recipient/complete','/api/auth/password-setup/recipient/abandon'].includes(path))return null;
 let operationId:string|undefined;
 try{
  if(request.method!=='POST')return json({error:'method_not_allowed'},405);
  requireOrigin(request,origin);if(url.search||request.headers.has('Authorization'))throw new ApiError(400,'invalid_input');
  const csrf=request.headers.get('X-CSRF-Token');if(!csrf)throw new ApiError(403,'csrf_rejected');
  const input=await readJsonInput(request),browser=readCookie(request,RECIPIENT_COOKIE);
  if(path.endsWith('/complete')&&typeof input.operationId==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(input.operationId))operationId=input.operationId;
  const allowed=path.endsWith('/context')?['requestId','replaceAbandoned','replacesRequestId']:path.endsWith('/abandon')?['requestId']:path.endsWith('/complete')?['operationId','principalId','issuerId','purpose','password']:[];
  if(Object.keys(input).some(key=>!allowed.includes(key)))throw new ApiError(400,'invalid_input');
  if(path.endsWith('/context')){
   if(input.replaceAbandoned!==undefined&&input.replaceAbandoned!==true)throw new ApiError(400,'invalid_input');
   const context=await requests.identity.recipientContext(browser,readCookie(request,LOGIN_COOKIE),csrf,input.requestId===undefined?undefined:identifier(input.requestId),input.replaceAbandoned===true,input.replacesRequestId===undefined?undefined:identifier(input.replacesRequestId));
   const response=json({requestId:context.requestId,expiresAt:context.expiresAt});
   if(!browser||input.replaceAbandoned===true)response.headers.append('Set-Cookie',cookie(RECIPIENT_COOKIE,context.browserToken,Math.max(0,Math.min(RECIPIENT_CONTEXT_SECONDS,context.expiresAt-Math.floor(Date.now()/1000)))));return response;
  }
  if(path.endsWith('/abandon')){const result=await requests.identity.abandonRecipientContext(browser,readCookie(request,LOGIN_COOKIE),csrf,identifier(input.requestId));return json(result);}
  if(!browser)throw new ApiError(403,'recipient_setup_unavailable');
  if(path.endsWith('/status'))return json(await requests.identity.recipientStatus(browser,csrf));
  if(!['initial','reset'].includes(String(input.purpose))||typeof input.password!=='string')throw new ApiError(400,'invalid_input');
  return json(await requests.identity.recipientComplete({operationId:identifier(input.operationId),principalId:identifier(input.principalId),issuerId:identifier(input.issuerId),purpose:input.purpose as 'initial'|'reset',password:input.password},browser,csrf));
 }catch(error){const failure=protocolFailure(error);if(failure)return json(resultFailureBody(failure.body,operationId),failure.status);if(error instanceof ApiError)return json(resultFailureBody({error:error.code},operationId),error.status);return json(resultFailureBody({error:'recipient_setup_unavailable'},operationId),503);}
}
