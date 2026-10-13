// @module verification
// @role operation-regression
// Local integration observer only. Never deployed or imported by the product.
// Requests use the real Worker router, authentication and canonical D1. This
// fixture records committed state; it does not implement any business mutation.
import {protocolFailure} from '../../src/apps/http/outcomes';
import product from "../../src/apps/worker";
import {createRequestServices} from "../../src/apps/composition";
import {ApiError} from "../../src/adapters/protocol-errors";
import {MutationError} from "../../src/adapters/d1/persistence/public";

const events:unknown[]=[];
async function counts(db:D1Database,operationId:string) {
  const read=(table:string,principalColumn:string)=>db.prepare(`SELECT count(*) n FROM ${table} WHERE ${principalColumn}='A' AND operation_id=?`).bind(operationId).first<number>('n');
  return {intents:await read('operation_intents','principal_id'),receipts:await read('operation_results','principal_id'),history:await read('issue_history','actor_id')};
}
export default {async fetch(request:Request,env:Env):Promise<Response> {
  const path=new URL(request.url).pathname;
  if(path==='/__fixture/events')return Response.json(events);
  // A second adapter directly invokes the same service used by the MCP tools.
  // Only synthetic local requests can reach this test-only route.
  if(path.startsWith('/__fixture/shared/')) {
    const db=env.DB.withSession('first-primary');
    try {
      const {operations}=await createRequestServices(db,Math.floor(Date.now()/1000)).authenticate(request);
      const input=await request.json() as {route:never;input:never;operationId:string};
      const result=path.endsWith('/prepare')?await operations.prepare(operations.decodePreparation(input))
        :path.endsWith('/get')?await operations.get(input.operationId)
        :path.endsWith('/execute')?(await operations.execute(input.operationId)).receipt:null;
      return Response.json(result,{status:result?200:404});
    }catch(error) {
      const protocol=protocolFailure(error);if(protocol)return Response.json(protocol.body,{status:protocol.status});
      return Response.json({error:error instanceof ApiError||error instanceof MutationError?error.code:'fixture_failure'},
        {status:error instanceof ApiError||error instanceof MutationError?error.status:500});
    }
  }
  let batches=0;
  const DB=new Proxy(env.DB,{get(target,key) {
    if(key==='withSession')return (...args:Parameters<D1Database['withSession']>)=> {
      const session=target.withSession(...args);
      return new Proxy(session,{get(raw,member) {
        if(member==='batch')return async(statements:D1PreparedStatement[])=>{batches++;return raw.batch(statements);};
        const value=Reflect.get(raw,member);return typeof value==='function'?value.bind(raw):value;
      }});
    };
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  const input=(request.method==='POST'||request.method==='PATCH'?await request.clone().json().catch(()=>null):null) as {input?:{operationId?:unknown};operationId?:unknown}|null;
  const response=await product.fetch(request,{...env,DB});
  if(request.method==='POST'||request.method==='PATCH') {
    const candidateId=input?.input?.operationId??input?.operationId??path.match(/^\/api\/agent\/operations\/([^/]+)\/execute$/)?.[1];
    const operationId=typeof candidateId==='string'?candidateId:undefined;
    events.push({path,method:request.method,status:response.status,batches,
      ...(operationId?{operationId,stored:await counts(env.DB,operationId)}:{})});
  }
  // Synthetic response-corruption fault after the real server prepared input.
  // The reflected test credential is never added to events or evidence files.
  if(path==='/api/agent/operations'&&request.headers.get('X-Fixture-Reflect')==='true'&&response.ok) {
    const value=await response.json() as Record<string,unknown>;
    return Response.json({...value,fixtureReflection:request.headers.get('Authorization')?.slice(7)},
      {status:response.status,headers:response.headers});
  }
  return response;
}};
