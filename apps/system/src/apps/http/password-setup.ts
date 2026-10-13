// @module delivery
// @role http-adapter
import {readValue,resultValue,changeValue,resultFailureBody,protocolFailure} from "./outcomes";
import type {RequestServices} from "../contracts";
import {LOGIN_COOKIE,OWNER_BROWSER_COOKIE,readCookie,requireOrigin,requireCsrf} from "./security";
import { ApiError } from "../../adapters/protocol-errors";
import { readJsonInput } from "./object-input";
import { MutationError } from "../../adapters/d1/persistence/public";
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
const identifier=(v:unknown)=>{if(typeof v!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(v))throw new ApiError(400,'invalid_input',{operationId:'ASCII identifier required'});return v;};
function keys(v:Record<string,unknown>,allowed:string[]){if(Object.keys(v).some(k=>!allowed.includes(k)))throw new ApiError(400,'invalid_input',{body:'unknown fields'});}
async function formGuard(request:Request,requests:RequestServices,origin:string){
 requireOrigin(request,origin);if(request.headers.has('Authorization'))throw new ApiError(400,'ambiguous_authentication');
 const token=readCookie(request,LOGIN_COOKIE),csrf=request.headers.get('X-CSRF-Token');
 await requests.identity.validateChallenge(token,csrf);
 // This is CSRF only. A normal session grants no password-setup authority.
}
export async function passwordSetupApi(request:Request,requests:RequestServices,origin:string):Promise<Response|null>{
 const path=new URL(request.url).pathname,management=path.match(/^\/api\/management\/principals\/([A-Za-z0-9_-]{1,128})\/password-setup(?:\/(issue|revoke))?$/),result=path.match(/^\/api\/management\/password-setup\/operations\/([A-Za-z0-9_-]{1,128})$/);
 const holder=['/api/auth/password-setup/context','/api/auth/password-setup/complete','/api/auth/password-setup/result'].includes(path);
 if(!management&&!result&&!holder)return null;
 let resultOperationId=request.method==='GET'?result?.[1]:undefined;
 const failureJson=(body:Record<string,unknown>,status=200)=>json(resultFailureBody(body,resultOperationId),status);
 try{
  if(management||result){const services=await requests.authenticate(request);
   if(result&&request.method==='GET')return json(await resultValue(services.identity.setupManagementResult(result[1]),undefined,resultOperationId));
   if(management&&!management[2]&&request.method==='GET')return json({snapshot:await readValue(services.identity.setupState(management[1]))});
   if(!management?.[2]||request.method!=='POST')return json({error:'method_not_allowed'},405);
   if(services.actor.authentication==='session'){requireOrigin(request,origin);requireCsrf(request,services.actor);}
   const input=await readJsonInput(request);keys(input,management[2]==='issue'?['operationId','revision','purpose','recipientRequestId']:['operationId','revision']);
   if(typeof input.revision!=='number'||!Number.isSafeInteger(input.revision)||input.revision<1||input.revision>=Number.MAX_SAFE_INTEGER)throw new ApiError(400,'invalid_input',{revision:'positive safe integer required'});
   if(management[2]==='issue'&&!['initial','reset'].includes(String(input.purpose)))throw new ApiError(400,'invalid_input',{purpose:'initial or reset required'});
   const outcome=await services.identity.setupManage(management[1],identifier(input.operationId),input.revision,management[2]==='issue'?input.purpose as 'initial'|'reset':null,management[2]==='issue'?identifier(input.recipientRequestId):undefined);
   const confirmed=await changeValue(Promise.resolve(outcome));
   return json(confirmed);
  }
  if(request.method!=='POST')return json({error:'method_not_allowed'},405);
  const resultInput=path.endsWith('/result')?await readJsonInput(request):undefined;
  if(resultInput&&typeof resultInput.operationId==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(resultInput.operationId))resultOperationId=resultInput.operationId;
  await formGuard(request,requests,origin);
  const input=resultInput??await readJsonInput(request);keys(input,path.endsWith('/context')?['setupRight']:path.endsWith('/result')?['setupRight','operationId']:['setupRight','operationId','password']);
  if(typeof input.setupRight!=='string')throw new ApiError(400,'invalid_input');
  const ownerToken=readCookie(request,OWNER_BROWSER_COOKIE);
  if(path.endsWith('/context'))return json(await requests.identity.setupContext(input.setupRight,ownerToken));
  const operationId=identifier(input.operationId);
  if(path.endsWith('/result'))return json(await resultValue(requests.identity.setupResult(input.setupRight,operationId,ownerToken),undefined,operationId));
  if(typeof input.password!=='string')throw new ApiError(400,'invalid_input');
  return json(await changeValue(requests.identity.setupComplete(input.setupRight,operationId,input.password,ownerToken)));
 }catch(e){
    const protocol=protocolFailure(e);if(protocol){const response=failureJson(protocol.body,protocol.status);if(protocol.status===429||protocol.status===503)response.headers.set('Retry-After',protocol.status===429?'900':'1');return response;}if(e instanceof ApiError)return failureJson({error:e.code,...(e.fields?{fields:e.fields}:{})},e.status);if(e instanceof MutationError)return failureJson({error:e.code,...(e.reason?{reason:e.reason}:{}),...(e.current!==undefined?{current:e.current}:{})},e.status);return failureJson({error:'setup_unavailable'},503);}
}
