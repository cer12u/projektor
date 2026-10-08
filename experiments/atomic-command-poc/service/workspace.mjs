import { DurableObject } from 'cloudflare:workers';
import { randomBytes } from 'node:crypto';
import schema from '../src/schema.sql';
import { executeCommand, operationGet, queryIssues, failure, validate } from '../src/shared-core.mjs';
import { queryMyIssues } from '../src/my-issues.mjs';
import { sqliteStore } from './store.mjs';
import { configuration } from './config.mjs';
import { authenticate,AuthError } from './auth.mjs';
import { route,body,queryArgs,error,failureResponse,resultResponse } from './http.mjs';
// The only public operation is fetch(Request). There are no actor/RPC, schema,
// SQL, enrollment, reset, key or fault-injection methods on this class.
export class WorkspaceService extends DurableObject {
 #db;#supported=false;
 constructor(ctx,env){
  super(ctx,env);this.#db=sqliteStore(ctx.storage);
  ctx.blockConcurrencyWhile(async()=>{
   const existing=ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").toArray();
   if(!existing.length)ctx.storage.transactionSync(()=>{
    ctx.storage.sql.exec(schema);
    ctx.storage.sql.exec('INSERT INTO query_state VALUES(1,0,?)',randomBytes(32).toString('hex'));
    ctx.storage.sql.exec('CREATE TABLE identity_binding(issuer TEXT NOT NULL,subject TEXT NOT NULL,credential_id TEXT PRIMARY KEY,principal_id TEXT NOT NULL,kind TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE service_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL)');
    ctx.storage.sql.exec('INSERT INTO service_schema VALUES(1,1)');
   });
   if(!ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='service_schema'").toArray().length)return;
   this.#supported=ctx.storage.sql.exec('SELECT version FROM service_schema WHERE id=1').toArray()[0]?.version===1;
  });
 }
 async fetch(request){
  const started=Date.now();
  try{
   const config=configuration(this.env),r=route(request,config);
   if(!this.ctx.id.equals(this.env.WORKSPACE.idFromName(r.workspaceId)))return error('WORKSPACE_MISMATCH',403);
   const verified=await authenticate(request,this.env,r.kind);
   if(!this.#supported)return error('STORE_SCHEMA_UNSUPPORTED');
   let args;
   if(r.action==='command'){
    args=await body(request,Math.min(config.bodyDeadline,Math.max(1,config.deadline-(Date.now()-started))));
    const invalid=validate(args);if(invalid)throw new AuthError(invalid,invalid==='PRECONDITION_REQUIRED'?428:400);
    if(args.workspaceId!==r.workspaceId||request.headers.get('idempotency-key')!==args.operationId)throw new AuthError('ENVELOPE_MISMATCH',400);
   }else args=queryArgs(r);
   if(Date.now()-started>=config.deadline)return error('REQUEST_TIMEOUT');
   // Identity mapping and current authority share one synchronous transaction.
   // No JWT role/scope or caller-supplied ActorContext is consulted.
   const result=this.#db.transactionSync(()=>{
    const workspace=this.#db.prepare('SELECT id FROM workspace').get();
    if(!workspace)return failure('STORE_UNINITIALIZED');
    if(workspace.id!==r.workspaceId)return failure('WORKSPACE_MISMATCH');
    const rows=this.#db.prepare('SELECT principal_id,credential_id FROM identity_binding WHERE issuer=? AND subject=? AND kind=? LIMIT 2').all(verified.issuer,verified.subject,r.kind);
    if(rows.length!==1)return failure('UNAUTHENTICATED');
    const row=rows[0],actor={...verified,workspaceId:r.workspaceId,credentialId:row.credential_id,principalId:row.principal_id};
    return r.action==='command'?executeCommand(this.#db,actor,args):r.action==='myIssues'?queryMyIssues(this.#db,actor,args):r.action==='issue'?queryIssues(this.#db,actor,args):operationGet(this.#db,actor,args);
   });
   return resultResponse(result,r.kind);
  }catch(e){return failureResponse(e);}
 }
}
