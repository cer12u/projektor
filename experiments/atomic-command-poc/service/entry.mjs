import {mcpFailure} from './mcp.mjs';
import { configuration } from './config.mjs';
import { authenticate } from './auth.mjs';
import { authenticateWorkspace } from './workspace-auth.mjs';
import { createSessionHTTP } from '../session-ports/http.mjs';
import { SessionPortError } from '../session-ports/server.mjs';
import { route,error,failureResponse } from './http.mjs';
export { WorkspaceService } from './workspace.mjs';
export default {async fetch(request,env,ctx){
 let timer,isMCP=false;
 try{
  const config=configuration(env);
  if(['/v1/bootstrap','/v1/session','/v1/draft-keys'].includes(new URL(request.url).pathname)) {
   const handle=createSessionHTTP({verify:(request,kind)=>authenticate(request,env,kind),origin:config.origin,
    directory:config.workspaces.map(workspaceId=>({workspaceId,name:workspaceId})),requestDeadlineMs:config.deadline,trackPending:pending=>ctx.waitUntil(pending.then(()=>{},()=>{})),
    invokeStore:async({request,workspaceId,action,args})=>{
     const url=new URL(request.url);url.pathname=`/v1/workspaces/${workspaceId}/${action==='session'?'session':'draft-keys'}`;url.search='';
     const init={method:action==='session'?'GET':'POST',headers:new Headers(request.headers)};
     if(action==='draft-key')init.body=JSON.stringify(args);
     const result=await env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId)).fetch(new Request(url,init));
     const value=await result.json();if(!result.ok)throw new SessionPortError(value.error?.code??'SESSION_SERVICE_UNAVAILABLE',result.status);
     return value;
    }});
   const pending=handle(request);ctx.waitUntil(pending.then(()=>{},()=>{}));return await pending;
  }
  const r=route(request,config);isMCP=['mcp','legacyMCP'].includes(r.action);
  const unavailable=code=>isMCP?mcpFailure(code):error(code);
  const started=Date.now();
  const pending=(async()=>{
   const verified=await authenticateWorkspace(request,env,r.kind,r.workspaceId);
   if(r.action==='legacyMCP'&&verified.source!=='legacy_api_token')return mcpFailure('LEGACY_CREDENTIAL_REQUIRED',403);
   if(Date.now()-started>=config.deadline)return unavailable('TRANSPORT_TIMEOUT');
   return env.WORKSPACE.get(env.WORKSPACE.idFromName(r.workspaceId)).fetch(request);
  })();
  // A response timeout is not cancellation or proof of rollback. Register the
  // admitted request's actual settlement with the runtime until it finishes.
  ctx.waitUntil(pending.then(()=>{},()=>{}));
  return await Promise.race([pending,new Promise(resolve=>{timer=setTimeout(()=>resolve(unavailable('TRANSPORT_TIMEOUT')),config.deadline);})]);
 }catch(e){return isMCP?mcpFailure(e?.code??'TRANSPORT_UNKNOWN',e?.status??503):failureResponse(e);}finally{clearTimeout(timer);}
}};
