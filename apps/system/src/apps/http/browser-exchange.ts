// @module delivery
// @role http-adapter
import {protocolFailure} from "./outcomes";
import {cookie,LOGIN_COOKIE,readCookie,requireOrigin,SESSION_COOKIE} from "./security";
import {BROWSER_EXCHANGE,LOGIN_POLICY,SESSION_LIFETIME} from "../../modules/identity/public";
import type {RequestServices} from "../contracts";
import {ApiError} from "../../adapters/protocol-errors";
import {readJsonInput} from "./object-input";
const EXCHANGE_COOKIE='__Host-projektor_exchange';
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
function token(value:unknown):string {if(typeof value!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value))throw new ApiError(400,'invalid_input');return value;}
function keys(input:Record<string,unknown>,allowed:readonly string[]) {if(Object.keys(input).some(key=>!allowed.includes(key)))throw new ApiError(400,'invalid_input');}
export async function browserExchangeApi(request:Request,requests:RequestServices,origin:string):Promise<Response|null> {
 const url=new URL(request.url),path=url.pathname;
 if(!['/api/auth/browser-session/context','/api/auth/browser-session/tickets','/api/auth/browser-session/redeem'].includes(path))return null;
 try{
  if(request.method!=='POST')return json({error:'method_not_allowed'},405);if(url.search)throw new ApiError(400,'invalid_input');
  if(path.endsWith('/tickets')) {
   const services=await requests.authenticate(request),input=await readJsonInput(request);keys(input,['nonce']);
   return json(await services.identity.browserTicket(token(input.nonce)));
  }
  requireOrigin(request,origin);if(request.headers.has('Authorization'))throw new ApiError(400,'ambiguous_authentication');
  const csrf=request.headers.get('X-CSRF-Token');if(!csrf)throw new ApiError(403,'csrf_rejected');
  const input=await readJsonInput(request);keys(input,path.endsWith('/context')?['nonce']:['nonce','ticket']);
  if(path.endsWith('/context')) {
   const context=await requests.identity.browserContext(token(input.nonce),readCookie(request,LOGIN_COOKIE),csrf);
   const response=json({expiresAt:context.expiresAt});response.headers.append('Set-Cookie',cookie(EXCHANGE_COOKIE,context.browserToken,BROWSER_EXCHANGE.contextSeconds));return response;
  }
  const browserCookie=readCookie(request,EXCHANGE_COOKIE);if(!browserCookie)throw new ApiError(403,'exchange_rejected');
  const result=await requests.identity.browserRedeem(token(input.ticket),token(input.nonce),browserCookie,csrf);
  const response=json({authenticated:true});response.headers.append('Set-Cookie',cookie(SESSION_COOKIE,result.sessionToken,SESSION_LIFETIME.absoluteSeconds));response.headers.append('Set-Cookie',cookie(EXCHANGE_COOKIE,'',0));response.headers.append('Set-Cookie',cookie(LOGIN_COOKIE,'',0));return response;
 }catch(error){
    const protocol=protocolFailure(error);if(protocol){const response=json(protocol.body,protocol.status);if(protocol.status===429||protocol.status===503)response.headers.set('Retry-After',protocol.status===429?String(LOGIN_POLICY.windowSeconds):'1');return response;}if(error instanceof ApiError){const response=json({error:error.code},error.status);if(error.status===429)response.headers.set('Retry-After',String(BROWSER_EXCHANGE.contextSeconds));return response;}return json({error:'exchange_unavailable'},503);}
}
