// @module delivery
// @role http-adapter
import {cookie,LOGIN_COOKIE,SESSION_COOKIE,readCookie,requireOrigin,requireCsrf} from "./security";
import {LOGIN_POLICY,SESSION_LIFETIME} from "../../modules/identity/public";
import type {RequestServices} from "../contracts";
import {ApiError} from "../../adapters/protocol-errors";
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
async function loginInput(request: Request): Promise<{loginId:string;password:string}> {
  if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') throw new ApiError(415,'json_required');
  if (!request.body) throw new ApiError(400,'invalid_input',{body:'required'});
  const reader = request.body.getReader(); const chunks: Uint8Array[]=[]; let bytes=0;
  for (;;) { const next=await reader.read(); if(next.done) break; bytes+=next.value.byteLength; if(bytes>4096) { await reader.cancel(); throw new ApiError(413,'body_too_large'); } chunks.push(next.value); }
  const combined=new Uint8Array(bytes); let offset=0; for(const chunk of chunks){combined.set(chunk,offset);offset+=chunk.byteLength;}
  let input: unknown;
  try { input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(combined)); } catch { throw new ApiError(400,'invalid_input',{body:'invalid JSON'}); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(400,'invalid_input',{body:'object required'});
  const value = input as Record<string,unknown>; const fields:Record<string,string>={};
  if (typeof value.loginId!=='string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value.loginId)) fields.loginId='1–64 lowercase ASCII identifier';
  if (typeof value.password!=='string' || value.password.length<1 || new TextEncoder().encode(value.password).length>1024) fields.password='1–1024 UTF-8 bytes';
  if (Object.keys(value).some(k=>k!=='loginId'&&k!=='password')) fields.body='unknown fields';
  if (Object.keys(fields).length) throw new ApiError(400,'invalid_input',fields);
  return {loginId:value.loginId as string,password:value.password as string};
}
export async function authApi(request:Request,requests:RequestServices,origin:string):Promise<Response|null>{
 const path=new URL(request.url).pathname;
      if(path==='/api/auth/context'&&request.method==='GET'){
        if(new URL(request.url).origin!==origin) throw new ApiError(403,'origin_rejected');
        const context=await requests.identity.createLoginContext(request.headers.get('CF-Connecting-IP')??'local-source');const response=json({csrfToken:context.csrfToken});response.headers.append('Set-Cookie',cookie(LOGIN_COOKIE,context.token,LOGIN_POLICY.challengeSeconds));return response;
      }
      if(path==='/api/auth/login'&&request.method==='POST'){
        requireOrigin(request,origin);
        if(request.headers.has('Authorization')) throw new ApiError(400,'ambiguous_authentication');
        const result=await requests.identity.passwordLogin(await loginInput(request),{challenge:readCookie(request,LOGIN_COOKIE),csrf:request.headers.get('X-CSRF-Token'),source:request.headers.get('CF-Connecting-IP')??'local-source'});
        const response=json({authenticated:true});response.headers.append('Set-Cookie',cookie(SESSION_COOKIE,result.token,SESSION_LIFETIME.absoluteSeconds));response.headers.append('Set-Cookie',cookie(LOGIN_COOKIE,'',0));return response;
      }
      if(path==='/api/auth/me'&&request.method==='GET') return json(await (await requests.authenticate(request)).identity.current());
      if(path==='/api/auth/logout'&&request.method==='POST'){
        requireOrigin(request,origin);const services=await requests.authenticate(request),current=services.actor;
        if(current.authentication!=='session') throw new ApiError(403,'session_required');
        requireCsrf(request,current); await services.identity.logout();
        const response=json({authenticated:false});response.headers.append('Set-Cookie',cookie(SESSION_COOKIE,'',0));return response;
      }
 return null;
}
