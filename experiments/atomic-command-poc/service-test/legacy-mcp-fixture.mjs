// TEST ONLY. Synthetic principal, local SQLite setup, snapshots and injected
// faults. Production entrypoints never import this harness.
import {DurableObject} from 'cloudflare:workers';
import schema from '../src/schema.sql';
import {sqliteStore} from '../service/store.mjs';
import {callLegacyMCPTool} from '../service/legacy-mcp.mjs';
const ids={workspace:'10000000-0000-4000-8000-000000000001',epoch:'10000000-0000-4000-8000-000000000002',actor:'10000000-0000-4000-8000-000000000003',credential:'10000000-0000-4000-8000-000000000004',project:'10000000-0000-4000-8000-000000000006'};
const now=1800000000000;
const actor={principalId:ids.actor,actorKind:'machine',principalKind:'human',credentialId:ids.credential,credentialExpiresAt:now+3600000,workspaceId:ids.workspace,source:'legacy_api_token',legacyCapabilities:{read:true,write:true}};
export class LegacyMCPFixture extends DurableObject{
 constructor(ctx,env){super(ctx,env);this.db=sqliteStore(ctx.storage);ctx.blockConcurrencyWhile(async()=>{ctx.storage.sql.exec(schema);ctx.storage.transactionSync(()=>{
  const sql=ctx.storage.sql;sql.exec('INSERT INTO workspace VALUES(?,?,1,0)',ids.workspace,ids.epoch);sql.exec('INSERT INTO membership VALUES(?,?,0,1)',ids.actor,'human');sql.exec('INSERT INTO credential VALUES(?,?,?,0,1,1)',ids.credential,ids.actor,actor.credentialExpiresAt);sql.exec('INSERT INTO project_grant VALUES(?,?,1,1)',ids.actor,ids.project);sql.exec('INSERT INTO project VALUES(?,?,1,0)',ids.project,'Synthetic project');sql.exec('INSERT INTO project_url VALUES(?,?,?,NULL)',ids.project,'TEST','test');for(const scope of ['operations:read_own','issue:read','issue:write','comment:write','history:read','wiki:read','wiki:write']){sql.exec('INSERT INTO principal_scope VALUES(?,?)',ids.actor,scope);sql.exec('INSERT INTO credential_scope VALUES(?,?)',ids.credential,scope);}
  for(const [index,key] of ['backlog','todo'].entries()){
   const id=`10000000-0000-4000-8000-00000000000${index+7}`;
   sql.exec('INSERT INTO issue_compat_status VALUES(?,?,?,?,0,?)',id,key,key,key==='todo'?'ready':'backlog',index);
   sql.exec('INSERT INTO source_mapping VALUES(?,?,?,?,?,?,?,?)',crypto.randomUUID(),'legacy-projektor','legacy_archive',id,JSON.stringify(['task_statuses','a'.repeat(64)]),'legacy_archive',id,JSON.stringify({id,workspace_id:ids.workspace,key,category:'todo',is_default:Number(key==='backlog'),is_review_step:0}));
  }
 });});}
 snapshot(){const names=this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").toArray();return Object.fromEntries(names.map(({name})=>[name,this.ctx.storage.sql.exec(`SELECT * FROM "${name}"`).toArray()]));}
 invoke(name,args,{faultOnReceipt,dropResponse=false}={}){let receipts=0;try{
  // Exactly the service topology: outer trusted-authority transaction, facade
  // transactionSync, then existing commands on the private transaction wrapper.
  const result=this.db.transactionSync(()=>callLegacyMCPTool(this.db,actor,name,args,{now,fault:point=>{if(point==='after_receipt'&&++receipts===faultOnReceipt)throw Error('Synthetic storage callback failure');}}));
  if(dropResponse)return this.ctx.storage.sync().then(()=>{throw Error('Synthetic lost response');});
  return result;
 }catch(e){return {error:{code:'TRANSPORT_UNKNOWN',outcome:'unknown'},attemptOutcome:e.outcome};}}
}
export default {async fetch(request,env){const {object,action,args=[]}=await request.json();if(!['snapshot','invoke'].includes(action))return new Response(null,{status:404});try{return Response.json(await env.WORKSPACE.getByName(object)[action](...args));}catch{return Response.json({error:{code:'TRANSPORT_UNKNOWN',outcome:'unknown'}},{status:503});}}};
