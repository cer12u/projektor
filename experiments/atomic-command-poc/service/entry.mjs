import { configuration } from './config.mjs';
import { authenticate } from './auth.mjs';
import { route,error,failureResponse } from './http.mjs';
export { WorkspaceService } from './workspace.mjs';
export default {async fetch(request,env,ctx){
 let timer;
 try{
  const config=configuration(env),r=route(request,config);
  const started=Date.now();
  const pending=(async()=>{
   const verified=await authenticate(request,env,r.kind);
   if(Date.now()-started>=config.deadline)return error('TRANSPORT_TIMEOUT');
   return env.WORKSPACE.get(env.WORKSPACE.idFromName(r.workspaceId)).fetch(request);
  })();
  // A response timeout is not cancellation or proof of rollback. Register the
  // admitted request's actual settlement with the runtime until it finishes.
  ctx.waitUntil(pending.then(()=>{},()=>{}));
  return await Promise.race([pending,new Promise(resolve=>{timer=setTimeout(()=>resolve(error('TRANSPORT_TIMEOUT')),config.deadline);})]);
 }catch(e){return failureResponse(e);}finally{clearTimeout(timer);}
}};
