import {readMCPRatePolicy} from './mcp-rate.mjs';
import {createMCPTransport,mcpError,mcpFailure} from './mcp.mjs';
import {listMCPTools,callMCPTool} from './mcp-tools.mjs';
import {strictJson} from '../release/strict-json.mjs';
import {wikiQuery} from '../src/wiki-surface.mjs';
import {queryClaim,queryResolutionRecords,queryCapabilities,queryAttemptCheckpoint,queryIssueAlias} from '../src/agent-workflow.mjs';
import { DurableObject } from 'cloudflare:workers';
import { randomBytes,createHash } from 'node:crypto';
import schema from '../src/schema.sql';
import keySchema from '../session-ports/schema.sql';
import {currentSession,draftKey,SessionPortError} from '../session-ports/server.mjs';
import { executeCommand, operationGet, queryIssues, queryProjects, queryIssueEntries, queryContentRevisions, failure, validate, authorized } from '../src/shared-core.mjs';
import { queryMyIssues } from '../src/my-issues.mjs';
import { sqliteStore } from './store.mjs';
import { configuration } from './config.mjs';
import { authenticate,AuthError } from './auth.mjs';
import { route,body,queryArgs,error,failureResponse,resultResponse } from './http.mjs';
// The only public operation is fetch(Request). There are no actor/RPC, schema,
// SQL, enrollment, reset, key or fault-injection methods on this class.
const schemaFingerprint=createHash('sha256').update(schema).update('\nI5-session-ports\n').update(keySchema).update('\nWiki-precreate-binding-v1\nWiki-deleted-protection-v1\n').digest('hex');
export class WorkspaceService extends DurableObject {
 #db;#supported=false;#mcp;
 constructor(ctx,env){
  super(ctx,env);this.#db=sqliteStore(ctx.storage);
  this.#mcp=createMCPTransport({rateLimit:readMCPRatePolicy(env.MCP_RATE_LIMIT_CONFIG),listTools:listMCPTools,callTool:(name,args,actor)=>callMCPTool(this.#db,actor,name,args)});
  ctx.blockConcurrencyWhile(async()=>{
   const existing=ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").toArray();
   if(!existing.length)ctx.storage.transactionSync(()=>{
    ctx.storage.sql.exec(schema);
    ctx.storage.sql.exec(keySchema);
    ctx.storage.sql.exec('INSERT INTO query_state VALUES(1,0,?)',randomBytes(32).toString('hex'));
    ctx.storage.sql.exec('CREATE TABLE identity_binding(issuer TEXT NOT NULL,subject TEXT NOT NULL,credential_id TEXT PRIMARY KEY,principal_id TEXT NOT NULL,kind TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE service_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL)');
    ctx.storage.sql.exec('INSERT INTO service_schema VALUES(1,5)');
    ctx.storage.sql.exec('CREATE TABLE service_schema_variant(id INTEGER PRIMARY KEY CHECK(id=1),fingerprint TEXT NOT NULL)');
    ctx.storage.sql.exec('INSERT INTO service_schema_variant VALUES(1,?)',schemaFingerprint);
   });
   if(!ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='service_schema'").toArray().length)return;
   if(!ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='service_schema_variant'").toArray().length)return;
   if(ctx.storage.sql.exec('SELECT fingerprint FROM service_schema_variant WHERE id=1').toArray()[0]?.fingerprint!==schemaFingerprint)return;
   this.#supported=ctx.storage.sql.exec('SELECT version FROM service_schema WHERE id=1').toArray()[0]?.version===5;
  });
 }
 async fetch(request){
  const started=Date.now();let sessionError,rpc,isMCP=false;
  try{
   const config=configuration(this.env),r=route(request,config);isMCP=r.action==='mcp';
   if(!this.ctx.id.equals(this.env.WORKSPACE.idFromName(r.workspaceId)))return error('WORKSPACE_MISMATCH',403);
   const verified=await authenticate(request,this.env,r.kind);
   if(!this.#supported||this.#db.prepare('SELECT version FROM service_schema WHERE id=1').get()?.version!==5||this.#db.prepare('SELECT fingerprint FROM service_schema_variant WHERE id=1').get()?.fingerprint!==schemaFingerprint)return isMCP?mcpFailure('STORE_SCHEMA_UNSUPPORTED'):error('STORE_SCHEMA_UNSUPPORTED');
   let args;
   if(r.action==='command'){
    args=await body(request,Math.min(config.bodyDeadline,Math.max(1,config.deadline-(Date.now()-started))));
    const invalid=validate(args);if(invalid)throw new AuthError(invalid,invalid==='PRECONDITION_REQUIRED'?428:400);
    if(args.workspaceId!==r.workspaceId||request.headers.get('idempotency-key')!==args.operationId)throw new AuthError('ENVELOPE_MISMATCH',400);
   }else if(r.action==='mcp'){if(request.method==='POST'){try{rpc=await body(request,config.bodyDeadline,strictJson);}catch(e){if(e.code==='VALIDATION')return mcpError(-32700,'Parse error');throw e;}}}else if(r.action==='draftKey'){
    args=await body(request,config.bodyDeadline);
    if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['binding','keyId'].includes(k)))throw new AuthError('VALIDATION',400);
    if(args.binding?.workspaceId!==r.workspaceId)throw new AuthError('WORKSPACE_MISMATCH',403);
   }else if(r.action!=='session')args=queryArgs(r);
   if(Date.now()-started>=config.deadline)return isMCP?mcpFailure('REQUEST_TIMEOUT',503,rpc?.id):error('REQUEST_TIMEOUT');
   // Identity mapping and current authority share one synchronous transaction.
   // No JWT role/scope or caller-supplied ActorContext is consulted.
   const result=this.#db.transactionSync(()=>{
    if(['session','draftKey'].includes(r.action)){try{return r.action==='session'?currentSession(this.#db,verified,r.workspaceId).session:draftKey(this.#db,verified,args);}catch(e){if(e instanceof SessionPortError)sessionError=e;throw e;}}
    const workspace=this.#db.prepare('SELECT id FROM workspace').get();
    if(!workspace)return failure('STORE_UNINITIALIZED');
    if(workspace.id!==r.workspaceId)return failure('WORKSPACE_MISMATCH');
    const rows=this.#db.prepare('SELECT principal_id,credential_id FROM identity_binding WHERE issuer=? AND subject=? AND kind=? LIMIT 2').all(verified.issuer,verified.subject,r.kind);
    if(rows.length!==1)return failure('UNAUTHENTICATED');
    const row=rows[0],actor={...verified,workspaceId:r.workspaceId,credentialId:row.credential_id,principalId:row.principal_id};
    if(isMCP){const w=this.#db.prepare('SELECT epoch FROM workspace WHERE id=?').get(r.workspaceId);const denied=authorized(this.#db,actor,r.workspaceId,w.epoch,Date.now());if(denied)return failure(denied);return this.#mcp(request,rpc,{...actor,epoch:w.epoch});}
    const wikiName={wiki:r.entityId?'wiki_get':'wiki_list',wikiRevisions:r.revisionId?'wiki_revision_get':'wiki_revision_list',wikiResolve:'wiki_resolve',links:'links_list',backlinks:'backlinks_list'}[r.action];
    const outcome=wikiName?wikiQuery(this.#db,actor,wikiName,args):r.action==='alias'?queryIssueAlias(this.#db,actor,args):r.action==='checkpoint'?queryAttemptCheckpoint(this.#db,actor,args):r.action==='capabilities'?queryCapabilities(this.#db,actor,args):r.action==='claim'?queryClaim(this.#db,actor,args):r.action==='resolutions'?queryResolutionRecords(this.#db,actor,args):r.action==='command'?executeCommand(this.#db,actor,args):r.action==='myIssues'?queryMyIssues(this.#db,actor,args):r.action==='issue'?queryIssues(this.#db,actor,args):r.action==='projects'?queryProjects(this.#db,actor,args):r.action==='entries'?queryIssueEntries(this.#db,actor,args):r.action==='revisions'?queryContentRevisions(this.#db,actor,args):operationGet(this.#db,actor,args);
    return outcome.data&&['issue','projects','entries','revisions'].includes(r.action)?{...outcome,meta:{...outcome.meta,workspaceId:r.workspaceId,workspaceEpoch:args.workspaceEpoch,actorId:actor.principalId}}:outcome;
   });
   if(isMCP){if(result instanceof Response)return result;const converted=resultResponse(result,r.kind);return mcpFailure(result.error?.code??'TRANSPORT_UNKNOWN',converted.status,rpc?.id);}
   return resultResponse(result,r.kind);
  }catch(e){if(isMCP)return mcpFailure(e instanceof AuthError?e.code:'TRANSPORT_UNKNOWN',e instanceof AuthError?e.status:503,rpc?.id);if(sessionError&&e.outcome==='not_committed')return error(sessionError.code,sessionError.status);return e instanceof SessionPortError?error(e.code,e.status):failureResponse(e);}
 }
}
