// TEST ONLY: host-side Durable Object RPC for a reviewed synthetic management
// grant. This class is never a production entry or deployment export.
import entry from '../service/entry.mjs';
import {WorkspaceService} from '../service/workspace.mjs';
import {sqliteStore} from '../service/store.mjs';
import {configuration} from '../service/config.mjs';
import {createAppAuth} from '../service/app-auth.mjs';
export default {fetch(request,env,ctx){
 if(new URL(request.url).pathname==='/__fixture/control'){
  if(request.headers.get('x-fixture-control')!==env.FIXTURE_CONTROL_SECRET)return new Response(null,{status:404});
  const config=configuration(env);
  return env.WORKSPACE.get(env.WORKSPACE.idFromName(config.appAuth.workspaceId)).fetch(request);
 }
 return entry.fetch(request,env,ctx);
}};
export class AppAuthFixtureWorkspace extends WorkspaceService{
 #bodyBarrier;
 async fetch(request){
  if(new URL(request.url).pathname==='/__fixture/control'){
   if(request.headers.get('x-fixture-control')!==this.env.FIXTURE_CONTROL_SECRET)return new Response(null,{status:404});
   const input=await request.json();
   if(input.action==='sql')return Response.json(this.ctx.storage.sql.exec(input.sql,...input.args).toArray());
   if(input.action==='approve')return Response.json(this.approveFixtureGrant(input.plan));
   if(input.action==='armBodyBarrier'){
    if(this.#bodyBarrier&&this.#bodyBarrier.state!=='released')return new Response(null,{status:409});
    let release;const wait=new Promise(resolve=>{release=resolve;});this.#bodyBarrier={state:'armed',wait,release};
    return Response.json({state:'armed'});
   }
   if(input.action==='bodyBarrierState')return Response.json({state:this.#bodyBarrier?.state??'absent'});
   if(input.action==='releaseBodyBarrier'){
    if(!this.#bodyBarrier)return new Response(null,{status:409});
    this.#bodyBarrier.state='released';this.#bodyBarrier.release();return Response.json({state:'released'});
   }
   return new Response(null,{status:400});
  }
  if(this.#bodyBarrier?.state==='armed'&&new URL(request.url).pathname.endsWith('/commands')&&request.body){
   const barrier=this.#bodyBarrier,getReader=request.body.getReader.bind(request.body);let held=false;
   // TEST ONLY: production calls getReader after its initial authentication.
   // Gate its first read, allowing a concurrent real logout before commit.
   Object.defineProperty(request.body,'getReader',{value:(...args)=>{
    const reader=getReader(...args),read=reader.read.bind(reader);
    Object.defineProperty(reader,'read',{value:async()=>{if(!held){held=true;barrier.state='entered';await barrier.wait;}return read();}});
    return reader;
   }});
  }
  return super.fetch(request);
 }
 approveFixtureGrant(plan){
  const config=configuration(this.env);
  return createAppAuth({db:sqliteStore(this.ctx.storage),...config.appAuth,origin:config.origin,sealKey:this.env.JWT_SECRET}).approveGrant(plan);
 }
}
