// @module verification
// @role list-sql-fixture
// Local review fixture only. Measures actual D1 list result serialization.
import worker from "../../../src/apps/worker";
export default {async fetch(request:Request,env:Env){
 const headers=new Headers(request.headers);headers.set('Host',new URL(request.url).host);
 let listResultBytes=0,listResultRows=0;
 const DB:D1Database={
  ...env.DB,exec:q=>env.DB.exec(q),dump:()=>env.DB.dump(),withSession:c=>env.DB.withSession(c),
  ...(()=>{
   const session=env.DB;
   return {batch:s=>session.batch(s),prepare(query){
    const measure=query.includes('FROM operation_intents i')&&query.includes('ORDER BY i.sequence LIMIT');
    const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(target,key){
     if(key==='bind')return (...values:unknown[])=>wrap(target.bind(...values));
     if(key==='all'&&measure)return async()=>{const result=await target.all();listResultBytes=new TextEncoder().encode(JSON.stringify(result.results)).byteLength;listResultRows=result.results.length;return result;};
     const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
    return wrap(session.prepare(query));
   }};
  })()
 };
 const response=await worker.fetch(new Request(request,{headers}),{...env,DB});
 response.headers.set('X-Review-List-Result-Bytes',String(listResultBytes));response.headers.set('X-Review-List-Result-Rows',String(listResultRows));return response;
}};
