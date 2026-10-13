// @module verification
// @role operation-format-regression
// Defect: a direct REST mutation bypasses the supported-format check on a saved intent.
// Actual product HTTP routing + local workerd/D1; synthetic identities and disposable storage only.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {basename,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {prepareLocalD1,verifyCanonicalLedger} from '../../support/local-d1-fixture.mjs';

const candidate=fileURLToPath(new URL('../../../',import.meta.url));
const hash=value=>createHash('sha256').update(value).digest('hex');
const origin='https://format-fixture.invalid',token='A'.repeat(43),principal='FORMAT_AGENT';
const output=resolve(candidate,'.local/evidence/operation-format-workerd.json');
const migration='migrations/0017_operation_intents.sql',migrationHash=hash(await readFile(resolve(candidate,migration)));
const report={startedAt:new Date().toISOString(),runtime:'actual product REST on isolated workerd/D1 with canonical migrations',productionActions:0,externalRequests:0,scenarios:[],sourceHashes:{[migration]:migrationHash}};
const guardEntry="{reason:'operation_format_unsupported',valid:supportedIntent},";
const source=`import worker from '${candidate}/src/apps/worker.ts';
export default {async fetch(request,env,ctx){
 const mode=request.headers.get('X-Fixture-Mode');
 if(!mode)return worker.fetch(request,env,ctx);
 const raw=env.DB.withSession('first-primary');let injected=false;
 const input=await request.clone().json();
 const digest=async x=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(x)))].map(n=>n.toString(16).padStart(2,'0')).join('');
 const wrap=(statement,text)=>new Proxy(statement,{get(target,key){
  if(key==='bind')return(...values)=>wrap(target.bind(...values),text);
  if(key==='first')return async(...args)=>{
   if(!injected&&mode==='revoke_before_receipt'&&text.includes('FROM operation_results')&&text.includes('AS authenticated')){
    injected=true;await raw.prepare("DELETE FROM memberships WHERE principal_id='FORMAT_AGENT' AND permission='edit'").run();
   }
   return target.first(...args);
  };
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 const wrapped={prepare:text=>wrap(raw.prepare(text),text),async batch(statements){
  if(!injected&&mode==='future_before_batch'){
   injected=true;const target='I_'+await digest(JSON.stringify(['FORMAT_AGENT',input.operationId]));
   await raw.prepare("INSERT INTO operation_intents(principal_id,operation_id,format_version,operation_kind,target_id,project_id,route_json,input_json,input_hash,required_permissions,prepared_at) VALUES('FORMAT_AGENT',?,2,'issue.create',?,'P',?,?,?,'[\\\"edit\\\",\\\"view\\\"]',unixepoch())")
    .bind(input.operationId,target,JSON.stringify({kind:'issue',projectId:'P'}),JSON.stringify(input),await digest(JSON.stringify({body:input.body,title:input.title}))).run();
  }
  return raw.batch(statements);
 }};
 return worker.fetch(request,{...env,DB:wrapped},ctx);
}};`;
let mf;
await mkdir(resolve(candidate,'.local/evidence'),{recursive:true});
try{
 for(const negativeControl of [true,false]){
  const root=await mkdtemp(join(tmpdir(),'projektor-operation-format-'));
  try{
   const compilation=await build({absWorkingDir:candidate,metafile:true,stdin:{contents:source,resolveDir:candidate,sourcefile:'operation-format-fixture.ts'},outfile:join(root,'worker.mjs'),bundle:true,format:'esm',platform:'neutral',mainFields:['module','main'],conditions:['workerd','worker','browser'],external:['node:*','cloudflare:*'],plugins:[
    {name:'format-negative-control',setup(b){if(negativeControl)b.onLoad({filter:/[/\\]adapters[/\\]d1[/\\]persistence[/\\]commit\.ts$/},async args=>{const original=await readFile(args.path,'utf8');assert.equal(original.split(guardEntry).length,2,'one exact new-write format fence');return{contents:original.replace(guardEntry,''),loader:'ts'};});}},
    {name:'wasm',setup(b){b.onResolve({filter:/\.wasm$/},a=>({path:'./'+basename(a.path),external:true}));}}
   ]});
   const files=[...Object.keys(compilation.metafile.inputs).filter(p=>p.startsWith('src/')),'tests/integration/d1/check-operation-format-runtime.mjs','tests/support/local-d1-fixture.mjs'];
   const sourceHashes=Object.fromEntries(await Promise.all(files.map(async file=>[file,hash(await readFile(resolve(candidate,file)))])));
   if(!negativeControl)Object.assign(report.sourceHashes,sourceHashes);
   const modules=[{type:'ESModule',path:join(root,'worker.mjs'),contents:await readFile(join(root,'worker.mjs'),'utf8')}];
   for(const name of ['argon2.wasm','blake2b.wasm'])modules.push({type:'CompiledWasm',path:join(root,name),contents:await readFile(resolve(candidate,'src/adapters/crypto/generated',name))});
   const fixture=await prepareLocalD1(root);
   mf=new Miniflare(convertV4MiniflareOptions({name:'operation-format-local',modules,modulesRoot:root,compatibilityDate:'2026-10-09',compatibilityFlags:['nodejs_compat'],...fixture,bindings:{AUTH_ORIGIN:origin},outboundService:()=>{report.externalRequests++;throw new Error('Outbound denied');},host:'127.0.0.1',port:0,cf:false,logRequests:false}));
   await mf.ready;const db=await mf.getD1Database('DB');await verifyCanonicalLedger(db);
   const sql=(text,...values)=>db.prepare(text).bind(...values).run();
   await sql("INSERT INTO principals VALUES(?,'agent','Synthetic format agent',NULL,1,1)",principal);
   await sql("INSERT INTO api_credentials VALUES('FORMAT_KEY',?,?,unixepoch()+3600,NULL)",principal,hash(token));
   await sql("INSERT INTO workspaces VALUES('W','Synthetic workspace','{}')");
   await sql("INSERT INTO projects VALUES('P','W','P','p','Synthetic project','','{}')");
   for(const permission of ['view','edit']){await sql('INSERT INTO memberships VALUES(?,?,?)',principal,'P',permission);await sql("INSERT INTO api_grants VALUES('FORMAT_KEY','P',?)",permission);}
   async function call(path,method='GET',input,mode=''){
    const response=await mf.dispatchFetch(origin+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-Fixture-Mode':mode},...(input===undefined?{}:{body:JSON.stringify(input)})});
    return{status:response.status,body:await response.json()};
   }
   const input=id=>({operationId:id,body:'Private retained format body',title:'Retained format title'});
   const target=id=>'I_'+hash(JSON.stringify([principal,id]));
   async function retain(value,format=2){await sql("INSERT INTO operation_intents(principal_id,operation_id,format_version,operation_kind,target_id,project_id,route_json,input_json,input_hash,required_permissions,prepared_at) VALUES(?,?,?,'issue.create',?,'P',?,?,?,'[\"edit\",\"view\"]',unixepoch())",principal,value.operationId,format,target(value.operationId),JSON.stringify({kind:'issue',projectId:'P'}),JSON.stringify(value),hash(JSON.stringify({body:value.body,title:value.title})));}
   async function counts(id){return{
    issues:await db.prepare('SELECT count(*) FROM issues WHERE id=?').bind(target(id)).first('count(*)'),
    history:await db.prepare('SELECT count(*) FROM issue_history WHERE actor_id=? AND operation_id=?').bind(principal,id).first('count(*)'),
    receipts:await db.prepare('SELECT count(*) FROM operation_results WHERE principal_id=? AND operation_id=?').bind(principal,id).first('count(*)'),
   };}
   const empty={issues:0,history:0,receipts:0},committed={issues:1,history:1,receipts:1};
   function assertBlocked(result,persisted,id){assert.equal(result.status,409,'pending future format must not execute');assert.equal(result.body.error,'operation_format_unsupported');assert.equal(result.body.operationId,id);assert.equal(result.body.application,'unknown');assert.equal(result.body.snapshot,undefined);assert.deepEqual(persisted,empty);}
   const pending=input('pending_v2');await retain(pending);
   let result=await call('/api/projects/P/issues','POST',pending),persisted=await counts(pending.operationId);
   if(negativeControl){
    assert.equal(result.status,200);assert.deepEqual(persisted,committed);
    assert.throws(()=>assertBlocked(result,persisted,pending.operationId),/pending future format must not execute/);
    report.scenarios.push({name:'negative_control_removing_only_atomic_fence_reproduces_direct_rest_commit',passed:true,observedStatus:result.status,persisted});
    continue;
   }
   assertBlocked(result,persisted,pending.operationId);
   assert.equal((await call('/api/agent/operations/'+pending.operationId)).body.formatVersion,2);
   const execute=await call('/api/agent/operations/'+pending.operationId+'/execute','POST',{});assert.equal(execute.status,409);assert.equal(execute.body.error,'operation_format_unsupported');assert.deepEqual(await counts(pending.operationId),empty);
   report.scenarios.push({name:'pending_v2_direct_and_prepared_execution_rejected_with_zero_changes',passed:true});
   const raced=input('raced_v2');result=await call('/api/projects/P/issues','POST',raced,'future_before_batch');assertBlocked(result,await counts(raced.operationId),raced.operationId);
   report.scenarios.push({name:'future_intent_arriving_after_preflight_is_rejected_in_atomic_batch',passed:true});
   const current=input('current_v1');await retain(current,1);result=await call('/api/projects/P/issues','POST',current);assert.equal(result.status,200);assert.equal(result.body.source,'committed');assert.deepEqual(await counts(current.operationId),committed);
   const ordinary=input('ordinary_unprepared');result=await call('/api/projects/P/issues','POST',ordinary);assert.equal(result.status,200);assert.deepEqual(await counts(ordinary.operationId),committed);
   report.scenarios.push({name:'current_format_and_unprepared_direct_operations_unchanged',passed:true});
   // A newer writer's valid confirmed receipt may predate its retained journal entry.
   const confirmed=input('confirmed_v2');const original=await call('/api/projects/P/issues','POST',confirmed);assert.equal(original.status,200);await retain(confirmed);
   for(const [path,method,body] of [['/api/projects/P/issues','POST',confirmed],['/api/agent/operations/'+confirmed.operationId+'/execute','POST',{}]]){
    result=await call(path,method,body);assert.equal(result.status,200);assert.equal(result.body.source,'recovered');assert.deepEqual(result.body.snapshot,original.body.snapshot);assert.deepEqual(await counts(confirmed.operationId),committed);
   }
   assert.equal((await call('/api/agent/operations/'+confirmed.operationId)).body.result.status,'confirmed');
   report.scenarios.push({name:'confirmed_v2_receipt_recovers_through_direct_and_prepared_paths_once',passed:true});
   result=await call('/api/projects/P/issues','POST',confirmed,'revoke_before_receipt');assert.equal(result.status,403);assert.equal(result.body.operationId,confirmed.operationId);assert.equal(result.body.application,'unknown');assert(!JSON.stringify(result.body).includes(confirmed.body));assert.equal(result.body.snapshot,undefined);assert.deepEqual(await counts(confirmed.operationId),committed);
   result=await call('/api/agent/operations/'+confirmed.operationId+'/execute','POST',{});assert.equal(result.status,403);assert(!JSON.stringify(result.body).includes(confirmed.body));
   await sql("INSERT INTO memberships VALUES(?,'P','edit')",principal);
   result=await call('/api/projects/P/issues','POST',confirmed);assert.equal(result.status,200);assert.equal(result.body.source,'recovered');assert.deepEqual(await counts(confirmed.operationId),committed);
   report.scenarios.push({name:'revocation_at_receipt_select_withholds_confirmed_v2_result_and_preserves_receipt',passed:true});
   for(const file of files)assert.equal(hash(await readFile(resolve(candidate,file))),sourceHashes[file],'source changed during test: '+file);
  }finally{if(mf){await mf.dispose();mf=null;}await rm(root,{recursive:true,force:true});}
 }
 assert.equal(hash(await readFile(resolve(candidate,migration))),migrationHash,'canonical migration bytes unchanged');
 assert.equal(report.externalRequests,0);report.passed=true;
}catch(error){report.passed=false;report.failure={name:error.name,message:error.message,stack:error.stack};throw error;}
finally{report.finishedAt=new Date().toISOString();await writeFile(output,JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify({passed:report.passed,scenarios:report.scenarios,output},null,2));
