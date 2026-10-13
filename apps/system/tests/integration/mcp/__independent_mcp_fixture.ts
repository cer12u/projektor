// @module verification
// @role mcp-fixture
// Isolated runtime fixture only, never imported by the product router.
// Miniflare overwrites Host with loopback while retaining request.url. Restore the
// synthetic canonical Host; optional race injection changes actual D1 after ingress auth.
import worker from "../../../src/apps/worker";
export default {fetch(request:Request,env:Env){
 const headers=new Headers(request.headers),race=headers.get('X-Test-Race');
 headers.set('Host',headers.get('X-Test-Host')??new URL(request.url).host);
 headers.delete('X-Test-Host');headers.delete('X-Test-Race');
 const DB:D1Database={
  ...env.DB,exec:q=>env.DB.exec(q),dump:()=>env.DB.dump(),withSession:c=>env.DB.withSession(c),
  ...(()=>{
   const session=env.DB;let injected=false;
   return {
    async batch(s){
     if(race==='grant-batch')await session.prepare("DELETE FROM federated_grants WHERE credential_id='transport-credential' AND permission='edit'").run();
     if(race==='expire-batch')await new Promise(resolve=>setTimeout(resolve,2200));
     return session.batch(s);
    },
    prepare(query){
     const statement=session.prepare(query);
     if(!race||query!=='SELECT mode FROM write_gate WHERE id=1'||injected)return statement;
     return {bind:(...values)=>statement.bind(...values),run:()=>statement.run(),all:()=>statement.all(),raw:statement.raw.bind(statement),
      async first<T>(column?:string):Promise<T|null>{
       injected=true;
       if(race==='expire')await new Promise(resolve=>setTimeout(resolve,2200));
       if(race==='revoke')await session.prepare("UPDATE federated_credentials SET revoked_at=unixepoch(),revision=revision+1 WHERE revoked_at IS NULL").run();
       return column===undefined?statement.first<T>():statement.first<T>(column);
      }
     };
    }
   };
  })()
 };
 return worker.fetch(new Request(request,{headers}),{...env,DB});
}};
