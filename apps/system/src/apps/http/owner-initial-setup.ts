// @module delivery
// @role http-adapter
import {LOGIN_COOKIE,OWNER_BROWSER_COOKIE,cookie,readCookie,requireOrigin} from "./security";
import type {RequestServices} from "../contracts";
import {protocolFailure} from "./outcomes";
import {ApiError} from "../../adapters/protocol-errors";
import {readJsonInput} from "./object-input";

const base='/api/auth/password-setup/owner-initial';
const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
const identifier=/^[A-Za-z0-9_-]{1,128}$/;
/** Owner bootstrap uses an already-established browser capability, never a response-only bearer right. */
export async function ownerInitialSetupApi(request:Request,requests:RequestServices,origin:string):Promise<Response|null>{
 const path=new URL(request.url).pathname;
 if(path!==base&&!path.startsWith(base+'/'))return null;
 if(![base,base+'/context',base+'/status',base+'/complete'].includes(path))return Response.json({error:'not_found'},{status:404,headers});
 if(request.method!=='POST')return Response.json({error:'method_not_allowed'},{status:405,headers:{...headers,Allow:'POST'}});
 let operationId:string|undefined;
 try{
  requireOrigin(request,origin);
  if(!origin.startsWith('https://'))throw new ApiError(403,'origin_rejected');
  if(request.headers.has('Authorization'))throw new ApiError(400,'ambiguous_authentication');
  const input=await readJsonInput(request),csrf=request.headers.get('X-CSRF-Token');
  if(typeof input.operationId==='string'&&identifier.test(input.operationId))operationId=input.operationId;
  const browserToken=readCookie(request,OWNER_BROWSER_COOKIE);
  if(path===base+'/context'){
   if(Object.keys(input).some(key=>key!=='operationId')||('operationId' in input&&(typeof input.operationId!=='string'||!identifier.test(input.operationId))))throw new ApiError(400,'invalid_input');
   const context=await requests.identity.ownerContext(browserToken,readCookie(request,LOGIN_COOKIE),csrf,typeof input.operationId==='string'?input.operationId:undefined);
   const maxAge=Math.max(0,Math.floor(context.expiresAt-Date.now()/1000));
   return Response.json({expiresAt:context.expiresAt},{headers:{...headers,'Set-Cookie':cookie(OWNER_BROWSER_COOKIE,context.browserToken,maxAge)}});
  }
  const allowed=path===base+'/complete'?['operationId','password']:['operationId'];
  if(Object.keys(input).some(key=>!allowed.includes(key))||typeof input.operationId!=='string'||!identifier.test(input.operationId))throw new ApiError(400,'invalid_input');
  if(!browserToken||!csrf)throw new ApiError(403,'owner_setup_unavailable');
  if(path===base+'/status')return Response.json(await requests.identity.ownerStatus(input.operationId,browserToken,csrf),{headers});
  if(path===base+'/complete'){
   if(typeof input.password!=='string')throw new ApiError(400,'invalid_input');
   return Response.json(await requests.identity.ownerComplete(input.operationId,input.password,browserToken,csrf),{headers});
  }
  return Response.json(await requests.identity.ownerInitial(request.headers.get('Cf-Access-Jwt-Assertion')??'',input.operationId,browserToken,csrf),{headers});
 }catch(error){
  const protocol=protocolFailure(error);if(protocol)return Response.json({...protocol.body,...(operationId?{operationId}:{}),...(operationId?{application:'unknown'}:{})},{status:protocol.status,headers});
  if(error instanceof ApiError)return Response.json({error:error.code,...(operationId?{operationId}:{}),...(operationId?{application:'unknown'}:{})},{status:error.status,headers});
  // No provider assertions, passwords, capabilities, or raw database errors enter logs/responses.
  return Response.json({error:'owner_setup_unavailable',application:'unknown',...(operationId?{operationId}:{})},{status:503,headers});
 }
}
