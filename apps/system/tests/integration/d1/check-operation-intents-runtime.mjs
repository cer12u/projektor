// @module verification
// @role operation-regression
// Actual local workerd + canonical Wrangler migrations + durable local D1.
// Every identity and failure is synthetic; no remote request or live write is allowed.
import assert from 'node:assert/strict';
import {prepareLocalD1,verifyCanonicalLedger} from "../../support/local-d1-fixture.mjs";
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {fileURLToPath} from 'node:url';
import {readFile,writeFile,mkdtemp,rm,mkdir} from 'node:fs/promises';
import {resolve,basename,join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
const candidate=fileURLToPath(new URL("../../../",import.meta.url)),output=resolve('.local/evidence/operation-intents-workerd.json');
await mkdir('.local/evidence',{recursive:true});
const root=await mkdtemp(join(tmpdir(),'projektor-intents-'));
const report={startedAt:new Date().toISOString(),candidate,runtime:'actual local workerd, canonical Wrangler migrations and persisted D1',productionActions:0,externalRequests:0,processStarts:0,scenarios:[],sourceHashes:Object.fromEntries(await Promise.all(['src/adapters/d1/persistence/prepared-operations.ts','src/adapters/d1/persistence/commit.ts','migrations/0017_operation_intents.sql','tests/integration/d1/check-operation-intents-runtime.mjs','tests/support/local-d1-fixture.mjs'].map(async file=>[file,createHash('sha256').update(await readFile(candidate+'/'+file)).digest('hex')])))};
let mf,db;let capturedFiles=[];
try{
const source=`import {createRequestServices} from '${candidate}/src/apps/composition.ts';
import {MutationError} from '${candidate}/src/adapters/d1/persistence/public.ts';
import {ApiError} from '${candidate}/src/adapters/protocol-errors.ts';
import {InputError} from '${candidate}/src/modules/change-outcomes.ts';
import {decodeIssueChange} from '${candidate}/src/modules/work/public.ts';
import {decodeExecutionCommand} from '${candidate}/src/modules/execution/public.ts';
import {changeValue,resultValue,DeliveryFailure,protocolFailure} from '${candidate}/src/apps/http/outcomes.ts';
const held=new Map();
export default {async fetch(request,env){
 const path=new URL(request.url).pathname;
 if(path==='/held')return Response.json({held:held.has('batch')});
 if(path==='/release'){held.get('batch')?.();return Response.json({released:true});}
 const raw=env.DB.withSession('first-primary'),mode=request.headers.get('X-Fixture-Mode')??'';
 const metrics={batches:0,businessBatches:0};let poisoned=false;
 const revoke=()=>raw.prepare("DELETE FROM memberships WHERE principal_id='AGENT_A' AND permission='edit'").run();
 const gate=()=>raw.prepare("UPDATE write_gate SET mode='stopped',epoch=epoch+1 WHERE id=1").run();
 const wrap=(stmt,text)=>new Proxy(stmt,{get(target,key){
  if(key==='bind')return(...values)=>wrap(target.bind(...values),text);
  if(key==='first'||key==='all')return async(...args)=>{
   if(poisoned)throw new Error('Synthetic lost response after commit');
   if(text.includes('FROM operation_intents i')&&text.startsWith('SELECT')){
    if(mode==='revoke_before_read')await revoke();
    if(mode==='import_before_read')await raw.prepare("UPDATE write_gate SET mode='importing',epoch=epoch+1 WHERE id=1").run();
   }
   return target[key](...args);
  };
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 const wrapped={prepare(text){return wrap(raw.prepare(text),text);},async batch(statements){
  metrics.batches++;
  if(path==='/execute')metrics.businessBatches++;
  if(mode==='hold_prepare'||mode==='hold_execute'){
   let release;const wait=new Promise(resolve=>{release=resolve;});held.set('batch',release);
   const timer=setInterval(()=>{},20);try{await wait;}finally{clearInterval(timer);held.delete('batch');}
  }
  if(mode==='revoke_before_batch')await revoke();
  if(mode==='add_status_before_batch')await raw.prepare("INSERT INTO imported_entities VALUES('task_statuses','done-raced','W_STATE','workspace:W_STATE',json_object('key','done'),'synthetic-race')").run();
  if(mode==='stop_before_batch')await gate();
  if(mode==='fail_before_batch')throw new Error('Synthetic precommit transport failure');
  const result=await raw.batch(statements);
  if(mode==='commit_ack_lost'){poisoned=true;throw new Error('Synthetic commit acknowledgement loss');}
  return result;
 }};
 try{
  const services=await createRequestServices(wrapped,Math.floor(Date.now()/1000)).authenticate(request),input=await request.json();
  const {work,operations}=services;
  let data;
  if(path==='/prepare')data=await operations.prepare(operations.decodePreparation(input));
  else if(path==='/execute')data=(await operations.execute(input.operationId)).receipt;
  else if(path==='/get')data=await operations.get(input.operationId);
  else if(path==='/list')data=await operations.list(input);
  else if(path==='/direct_execution')data=await changeValue(services.execution.change(decodeExecutionCommand({projectId:input.projectId,issueId:input.issueId},input.action,input.input)));
  else if(path==='/execution_result')data=await resultValue(services.execution.result({projectId:input.projectId,operationId:input.operationId}));
  else if(path==='/rest')data=await changeValue(work.changeIssue(decodeIssueChange(input.projectId,input.issueId,input.input)));
  else return Response.json({error:'not_found'},{status:404});
  if(mode==='prepare_response_lost')return Response.json({error:'synthetic_response_lost'},{status:503});
  return Response.json(data,{headers:{'X-Metrics':JSON.stringify(metrics)}});
 }catch(e){const protocol=protocolFailure(e);return Response.json(protocol?protocol.body:e instanceof DeliveryFailure?e.body:{error:e instanceof MutationError||e instanceof ApiError||e instanceof InputError?e.code:'fixture_failure'},
  {status:protocol?protocol.status:e instanceof DeliveryFailure||e instanceof MutationError||e instanceof ApiError?e.status:e instanceof InputError?400:500,headers:{'X-Metrics':JSON.stringify(metrics)}});}
}};`;
const workerBuild=await build({metafile:true,stdin:{contents:source,resolveDir:candidate,sourcefile:'operation-intent-fixture.ts'},outfile:root+'/worker.mjs',bundle:true,format:'esm',platform:'neutral',mainFields:['module','main'],conditions:['workerd','worker','browser'],external:['node:*','cloudflare:*'],plugins:[{name:'wasm',setup(b){b.onResolve({filter:/\.wasm$/},a=>({path:'./'+basename(a.path),external:true}));}}]});
capturedFiles=[...new Set([...Object.keys(workerBuild.metafile.inputs).filter(f=>!f.includes('node_modules')&&!f.endsWith('operation-intent-fixture.ts')), 'migrations/0017_operation_intents.sql','tests/integration/d1/check-operation-intents-runtime.mjs','tests/support/local-d1-fixture.mjs'])].sort();
report.sourceHashes=Object.fromEntries(await Promise.all(capturedFiles.map(async file=>[file,createHash('sha256').update(await readFile(resolve(candidate,file))).digest('hex')])));
report.executedBundleHash=createHash('sha256').update(await readFile(root+'/worker.mjs')).digest('hex');
const modules=[{type:'ESModule',path:root+'/worker.mjs',contents:await readFile(root+'/worker.mjs','utf8')}];
for(const name of ['argon2.wasm','blake2b.wasm'])modules.push({type:'CompiledWasm',path:root+'/'+name,contents:await readFile(candidate+'/src/adapters/crypto/generated/'+name)});
const fixtureOptions=await prepareLocalD1(root);
async function start(){
 mf=new Miniflare(convertV4MiniflareOptions({name:'operation-intents-local',modules,modulesRoot:root,compatibilityDate:'2026-10-09',compatibilityFlags:['nodejs_compat'],...fixtureOptions,outboundService:()=>{report.externalRequests++;throw new Error('Outbound denied');},host:'127.0.0.1',port:0,cf:false,logRequests:false}));
 await mf.ready;db=await mf.getD1Database('DB');report.processStarts++;await verifyCanonicalLedger(db);
}
await start();
const tokens={A:'A'.repeat(43),B:'B'.repeat(43),A2:'C'.repeat(43)};
for(const principal of ['A','B']){
 await db.prepare('INSERT INTO principals VALUES(?,?,?,NULL,1,1)').bind('AGENT_'+principal,'agent','Synthetic '+principal).run();
 for(const permission of ['view','edit','assign','transition','execute'])await db.prepare('INSERT INTO memberships VALUES(?,?,?)').bind('AGENT_'+principal,'P',permission).run();
}
for(const [key,token] of Object.entries(tokens)){
 await db.prepare('INSERT INTO api_credentials VALUES(?,?,?,unixepoch()+3600,NULL)').bind('KEY_'+key,'AGENT_'+key[0],createHash('sha256').update(token).digest('hex')).run();
 for(const permission of ['view','edit','assign','transition','execute'])await db.prepare('INSERT INTO api_grants VALUES(?,?,?)').bind('KEY_'+key,'P',permission).run();
}
async function rights(){await db.prepare("INSERT OR IGNORE INTO memberships VALUES('AGENT_A','P','edit')").run();}
async function gate(mode){await db.prepare('UPDATE write_gate SET mode=?,epoch=epoch+1 WHERE id=1').bind(mode).run();}
async function call(path,input,key='A',mode=''){
 const response=await mf.dispatchFetch('https://fixture.invalid/'+path,{method:'POST',headers:{Authorization:'Bearer '+tokens[key],'Content-Type':'application/json','X-Fixture-Mode':mode},body:JSON.stringify(input)});
 return {status:response.status,body:await response.json(),metrics:JSON.parse(response.headers.get('X-Metrics')??'{}')};
}
const body='Exact original private body 日本語',title='Original title';
const prep=(operationId,extra={})=>({route:{kind:'issue',projectId:'P'},input:{operationId,body,title,...extra}});
async function counts(operationId){return {
 intents:await db.prepare("SELECT count(*) n FROM operation_intents WHERE principal_id='AGENT_A' AND operation_id=?").bind(operationId).first('n'),
 receipts:await db.prepare("SELECT count(*) n FROM operation_results WHERE principal_id='AGENT_A' AND operation_id=?").bind(operationId).first('n'),
 history:await db.prepare("SELECT count(*) n FROM issue_history WHERE actor_id='AGENT_A' AND operation_id=?").bind(operationId).first('n'),
 issues:await db.prepare('SELECT count(*) n FROM issues WHERE id=?').bind('I_'+createHash('sha256').update(JSON.stringify(['AGENT_A',operationId])).digest('hex')).first('n'),
};}
const empty={intents:0,receipts:0,history:0,issues:0},prepared={...empty,intents:1},committed={intents:1,receipts:1,history:1,issues:1};
function save(name,details={}){report.scenarios.push({name,...details,passed:true});}
async function waitHeld(){for(let n=0;n<100;n++){const r=await mf.dispatchFetch('https://fixture.invalid/held');if((await r.json()).held)return;await new Promise(r=>setTimeout(r,10));}throw new Error('Fixture did not reach held batch');}
async function release(){await mf.dispatchFetch('https://fixture.invalid/release',{method:'POST'});}
// Response loss after preparation retains input only, with no business write.
let result=await call('prepare',prep('lost_prepare'),'A','prepare_response_lost');assert.equal(result.status,503);assert.deepEqual(await counts('lost_prepare'),prepared);
save('prepare_response_loss_is_durable_without_execution',{stored:await counts('lost_prepare')});
// Drop all runtime/process state. Discovery uses only authenticated principal and D1.
await mf.dispose();mf=null;await start();
result=await call('list',{});assert.equal(result.status,200);assert.equal(result.body.operations.length,1);
let found=result.body.operations[0];assert.equal(found.operationId,'lost_prepare');assert.equal(found.input,undefined);assert.deepEqual(found.result,{status:'unknown'});
result=await call('get',{operationId:found.operationId});assert.deepEqual(result.body.input,prep('lost_prepare').input);save('new_workerd_process_discovers_exact_id_and_input',{operationId:found.operationId,processStarts:report.processStarts});
// A delayed preparation may arrive after discovery found nothing. It cannot execute.
const delayed=call('prepare',prep('delayed_prepare'),'A','hold_prepare');await waitHeld();
result=await call('get',{operationId:'delayed_prepare'});assert.equal(result.status,404);assert.deepEqual(await counts('delayed_prepare'),empty);
await release();assert.equal((await delayed).status,200);assert.deepEqual(await counts('delayed_prepare'),prepared);
save('delayed_prepare_never_dispatches_business',{stored:await counts('delayed_prepare')});
// Even complete prepare batch acknowledgement loss is recovered from the journal.
result=await call('prepare',prep('prepare_ack_lost'),'A','commit_ack_lost');assert.equal(result.status,503);assert.deepEqual(await counts('prepare_ack_lost'),prepared);
result=await call('get',{operationId:'prepare_ack_lost'});assert.equal(result.status,200);assert.equal(result.body.result.status,'unknown');save('prepare_commit_ack_loss_recoverable');
// Unknown execution before dispatch retains the same saved input and never asserts nonapplication.
result=await call('execute',{operationId:'lost_prepare'},'A','fail_before_batch');assert.equal(result.status,503);assert.deepEqual(await counts('lost_prepare'),prepared);
result=await call('get',{operationId:'lost_prepare'});assert.deepEqual(result.body.result,{status:'unknown'});save('failed_execute_keeps_original_unknown_input');
// Real committed response loss, another new process, and a receipt-first recovery with zero dispatch.
result=await call('execute',{operationId:'lost_prepare'},'A','commit_ack_lost');assert.equal(result.status,503);assert.deepEqual(await counts('lost_prepare'),committed);
await mf.dispose();mf=null;await start();
result=await call('list',{});found=result.body.operations.find(o=>o.operationId==='lost_prepare');assert.equal(found.result.status,'confirmed');assert.equal(found.result.snapshot,undefined);assert.equal((await call('get',{operationId:found.operationId})).body.result.snapshot.body,body);
result=await call('execute',{operationId:'lost_prepare'});assert.equal(result.status,200);assert.equal(result.body.source,'recovered');assert.equal(result.metrics.businessBatches,0);assert.deepEqual(await counts('lost_prepare'),committed);
save('commit_response_loss_recovery_is_receipt_first',{stored:await counts('lost_prepare'),businessBatches:result.metrics.businessBatches,processStarts:report.processStarts});
// Same ID may be re-prepared identically, but changing any route/input conflicts.
assert.equal((await call('prepare',prep('lost_prepare'))).status,200);
assert.equal((await call('prepare',prep('lost_prepare',{body:'Different'}))).status,409);
assert.equal((await call('prepare',{...prep('lost_prepare'),route:{kind:'wiki',projectId:'P'}})).status,409);
assert.deepEqual(await counts('lost_prepare'),committed);save('same_id_different_input_or_kind_denied');
// SQL trigger also stops the old direct REST domain from committing another payload.
assert.equal((await call('prepare',prep('rest_mismatch'))).status,200);
result=await call('rest',{projectId:'P',input:{operationId:'rest_mismatch',body:'Different'}});assert.equal(result.status,409);assert.equal(result.body.error,'operation_input_mismatch');assert.deepEqual(await counts('rest_mismatch'),prepared);
save('legacy_direct_mutation_cannot_change_prepared_input');
// Unknown/create targets remain readable before creation; update and parent scope are guarded.
result=await call('prepare',{route:{kind:'wiki',projectId:'P'},input:{operationId:'wiki_prepare',body:'Wiki retained'}});assert.equal(result.status,200);const wikiId=result.body.target.targetId;assert.equal(result.body.result.status,'unknown');
assert.equal((await call('execute',{operationId:'wiki_prepare'})).status,200);
result=await call('prepare',{route:{kind:'comment',projectId:'P',parentKind:'wiki',parentId:wikiId},input:{operationId:'comment_prepare',body:'Comment retained'}});assert.equal(result.status,200);
assert.equal((await call('execute',{operationId:'comment_prepare'})).status,200);
result=await call('prepare',{route:{kind:'comment',projectId:'P',parentKind:'issue',parentId:wikiId},input:{operationId:'wrong_parent',body:'Must not store'}});assert.equal(result.status,400);
result=await call('prepare',{route:{kind:'comment',projectId:'P',parentKind:'wiki',parentId:'W_'+'f'.repeat(64)},input:{operationId:'missing_parent',body:'Must not store'}});assert.equal(result.status,403);
save('precreate_visibility_and_actual_parent_guards');
// Every accepted business family uses the same saved-input/domain-guard path.
const issueId=(await call('get',{operationId:'lost_prepare'})).body.target.targetId;
result=await call('prepare',{route:{kind:'issue',projectId:'P',id:issueId},input:{operationId:'assign_saved',revision:1,assigneeId:'AGENT_A'}});assert.equal(result.status,200);
assert.equal((await call('execute',{operationId:'assign_saved'})).status,200);
result=await call('prepare',{route:{kind:'execution',projectId:'P',issueId,action:'acquire'},input:{operationId:'acquire_saved'}});assert.equal(result.status,200);
result=await call('execute',{operationId:'acquire_saved'});assert.equal(result.status,200);const attemptId=result.body.snapshot.attemptId;
result=await call('prepare',{route:{kind:'report',projectId:'P',issueId,action:'progress'},input:{operationId:'progress_saved',attemptId,leaseVersion:1,message:'Durable progress',references:[]}});assert.equal(result.status,200);
result=await call('execute',{operationId:'progress_saved'});assert.equal(result.status,200);assert.equal(result.body.snapshot.message,'Durable progress');
result=await call('prepare',{route:{kind:'report',projectId:'P',issueId,action:'completed'},input:{operationId:'complete_saved',attemptId,leaseVersion:1,message:'Durable completion'}});assert.equal(result.status,200);
result=await call('execute',{operationId:'complete_saved'});assert.equal(result.status,200);assert.equal(result.body.snapshot.kind,'completed');
result=await call('prepare',{route:{kind:'execution',projectId:'P',issueId,action:'end'},input:{operationId:'end_saved',attemptId,leaseVersion:1}});assert.equal(result.status,200);
assert.equal((await call('execute',{operationId:'end_saved'})).status,200);
assert.equal(await db.prepare("SELECT count(*) n FROM issue_execution_report_events WHERE operation_id='progress_saved'").first('n'),1);
save('all_business_families_execute_saved_normalized_input');
// The same Work application owns direct and prepared state transitions.
result=await call('rest',{projectId:'P',input:{operationId:'state_create',body:'State semantics'}});assert.equal(result.status,200);const stateIssue=result.body.snapshot.id;
result=await call('rest',{projectId:'P',issueId:stateIssue,input:{operationId:'state_done',revision:1,state:'Done'}});assert.equal(result.status,200);const originalResolution=result.body.snapshot.resolution,originalResolvedAt=result.body.snapshot.resolvedAt;
assert.equal(originalResolution.kind,'instant');assert.equal(originalResolution.at,originalResolvedAt);
result=await call('prepare',{route:{kind:'issue',projectId:'P',id:stateIssue},input:{operationId:'state_same_done',revision:2,state:'Done'}});assert.equal(result.status,200);
result=await call('execute',{operationId:'state_same_done'});assert.equal(result.status,200);assert.deepEqual(result.body.snapshot.resolution,originalResolution);assert.equal(result.body.snapshot.resolvedAt,originalResolvedAt);
result=await call('prepare',{route:{kind:'issue',projectId:'P',id:stateIssue},input:{operationId:'state_reopen',revision:3,state:'Todo'}});assert.equal(result.status,200);
result=await call('execute',{operationId:'state_reopen'});assert.equal(result.status,200);assert.equal(result.body.snapshot.resolution,null);assert.equal(result.body.snapshot.resolvedAt,null);
assert.deepEqual((await db.prepare('SELECT revision,event_kind FROM issue_resolution_events WHERE issue_id=? ORDER BY revision').bind(stateIssue).all()).results,[{revision:2,event_kind:'resolved'},{revision:4,event_kind:'reopened'}]);
result=await call('rest',{projectId:'P',issueId:stateIssue,input:{operationId:'state_done',revision:1,state:'Done'}});assert.equal(result.status,200);assert.equal(result.body.source,'recovered');assert.deepEqual(result.body.snapshot.resolution,originalResolution);
save('direct_and_prepared_work_share_resolution_preserve_reopen_and_receipt_first_rules');
// A state decision is not silently recomputed after its expected issue revision changes.
result=await call('prepare',{route:{kind:'issue',projectId:'P',id:stateIssue},input:{operationId:'state_race',revision:4,state:'Done'}});assert.equal(result.status,200);
const statePending=call('execute',{operationId:'state_race'},'A','hold_execute');await waitHeld();
result=await call('rest',{projectId:'P',issueId:stateIssue,input:{operationId:'state_race_winner',revision:4,body:'Concurrent body'}});assert.equal(result.status,200);
await release();result=await statePending;assert.equal(result.status,409);assert.equal(result.body.application,'unknown');
assert.deepEqual(await db.prepare('SELECT revision,state,resolved_at FROM issues WHERE id=?').bind(stateIssue).first(),{revision:5,state:'Todo',resolved_at:null});
assert.equal(await db.prepare("SELECT count(*) n FROM operation_results WHERE operation_id='state_race'").first('n'),0);
save('state_planning_revision_race_does_not_replan_or_commit');
// Imported status selection is a pure choice; cardinality and exact ID are rechecked atomically.
await db.prepare("INSERT INTO workspaces(id,name,source_json) VALUES('W_STATE','Synthetic workspace','{}')").run();
await db.prepare("INSERT INTO projects(id,workspace_id,key,slug,name,description,source_json) VALUES('P','W_STATE','P','p','Synthetic project','','{}')").run();
await db.prepare("INSERT INTO imported_entities VALUES('task_statuses','done-original','W_STATE','workspace:W_STATE','{\"key\":\"done\"}','synthetic-done')").run();
await db.prepare("INSERT INTO imported_entities VALUES('task_statuses','todo-original','W_STATE','workspace:W_STATE','{\"key\":\"todo\"}','synthetic-todo')").run();
await db.prepare("UPDATE issues SET metadata_json='{}',workspace_id='W_STATE' WHERE id=?").bind(stateIssue).run();
result=await call('rest',{projectId:'P',issueId:stateIssue,input:{operationId:'status_race',revision:5,state:'Done'}},'A','add_status_before_batch');assert.equal(result.status,409);assert.equal(result.body.reason,'status_definition_unavailable');
assert.equal(await db.prepare("SELECT count(*) n FROM operation_results WHERE operation_id='status_race'").first('n'),0);
assert.equal(await db.prepare('SELECT revision FROM issues WHERE id=?').bind(stateIssue).first('revision'),5);
result=await call('rest',{projectId:'P',issueId:stateIssue,input:{operationId:'status_selected',revision:5,state:'Todo'}});assert.equal(result.status,200);assert.equal(result.body.snapshot.statusId,'todo-original');
await db.prepare("DELETE FROM memberships WHERE principal_id='AGENT_A' AND project_id='P' AND permission='view'").run();
result=await call('rest',{projectId:'P',issueId:stateIssue,input:{operationId:'state_no_view',revision:6,state:'Todo'}});assert.equal(result.status,403);assert.equal(result.body.current,undefined);assert.equal(result.body.snapshot,undefined);assert.equal(result.body.application,'unknown');
await db.prepare("INSERT INTO memberships VALUES('AGENT_A','P','view')").run();
save('imported_status_choice_rechecked_and_planning_read_requires_current_view');
// A retained intent can capture a stronger prior policy. Direct calls must not bypass that ceiling.
const strongerId='captured_stronger',strongerInput={operationId:strongerId},strongerRoute={kind:'execution',projectId:'P',issueId,action:'acquire'};
await db.prepare(`INSERT INTO operation_intents(principal_id,operation_id,format_version,operation_kind,target_id,project_id,route_json,input_json,input_hash,required_permissions,prepared_at)
 VALUES('AGENT_A',?,1,'execution.acquire',?,'P',?,?,?,'["edit","execute","view"]',unixepoch())`)
 .bind(strongerId,issueId,JSON.stringify(strongerRoute),JSON.stringify(strongerInput),createHash('sha256').update(JSON.stringify(strongerInput)).digest('hex')).run();
const beforeAttempts=await db.prepare('SELECT count(*) n FROM issue_execution_attempts').first('n');
await db.prepare("DELETE FROM api_grants WHERE credential_id='KEY_A' AND permission='edit'").run();
result=await call('direct_execution',{projectId:'P',issueId,action:'acquire',input:strongerInput});assert.equal(result.status,403);
assert.equal((await call('execute',{operationId:strongerId})).status,403);
assert.equal(await db.prepare('SELECT count(*) n FROM issue_execution_attempts').first('n'),beforeAttempts);
assert.equal(await db.prepare('SELECT count(*) n FROM operation_results WHERE operation_id=?').bind(strongerId).first('n'),0);
await db.prepare("INSERT INTO api_grants VALUES('KEY_A','P','edit')").run();
result=await call('direct_execution',{projectId:'P',issueId,action:'acquire',input:strongerInput});assert.equal(result.status,200);
const originalAttempt=result.body.snapshot;
assert.deepEqual(JSON.parse(await db.prepare('SELECT required_permissions FROM operation_results WHERE operation_id=?').bind(strongerId).first('required_permissions')).sort(),['edit','execute','view']);
result=await call('execute',{operationId:strongerId});assert.equal(result.status,200);assert.equal(result.body.source,'recovered');assert.deepEqual(result.body.snapshot,originalAttempt);
assert.equal(await db.prepare('SELECT count(*) n FROM issue_execution_attempts').first('n'),beforeAttempts+1);
await db.prepare("DELETE FROM api_grants WHERE credential_id='KEY_A' AND permission='edit'").run();
assert.equal((await call('execution_result',{projectId:'P',operationId:strongerId})).status,403);
assert.equal((await call('get',{operationId:strongerId})).status,403);
await db.prepare("INSERT INTO api_grants VALUES('KEY_A','P','edit')").run();
save('direct_and_durable_share_captured_requirements_and_atomic_receipt_identity',{operationId:strongerId,captured:['edit','execute','view']});

// The same domain-owned field policy drives direct mutation and durable disclosure/execute.
const policyIssue=(await call('rest',{projectId:'P',input:{operationId:'policy_owner',body:'Policy owner'}})).body.snapshot.id;
const policyCases=[['title','updated','edit'],['body','updated body','edit'],['references',[],'edit'],['priority',2,'edit'],['schedule',{start:null,end:null,due:null},'edit'],['parentId',null,'edit'],['typeId',null,'edit'],['assigneeId','AGENT_B','assign'],['state','Todo','transition']];
for(const [field,value,permission] of policyCases){
 const revision=await db.prepare('SELECT revision FROM issues WHERE id=?').bind(policyIssue).first('revision');
 const input={operationId:'policy_'+field,revision,[field]:value};
 const saved=await call('prepare',{route:{kind:'issue',projectId:'P',id:policyIssue},input});assert.equal(saved.status,200,field);
 await db.prepare("DELETE FROM memberships WHERE principal_id='AGENT_A' AND permission=?").bind(permission).run();
 assert.equal((await call('get',{operationId:input.operationId})).status,403,field);
 assert.equal((await call('execute',{operationId:input.operationId})).status,403,field);
 assert.equal((await call('rest',{projectId:'P',issueId:policyIssue,input})).status,403,field);
 assert.equal(await db.prepare('SELECT revision FROM issues WHERE id=?').bind(policyIssue).first('revision'),revision);
 await db.prepare("INSERT OR IGNORE INTO memberships VALUES('AGENT_A','P',?)").bind(permission).run();
 const direct=await call('rest',{projectId:'P',issueId:policyIssue,input});assert.equal(direct.status,200,field);
 const recovered=await call('execute',{operationId:input.operationId});assert.equal(recovered.status,200,field);assert.equal(recovered.body.source,'recovered');assert.equal(recovered.metrics.businessBatches,0);assert.deepEqual(recovered.body.snapshot,direct.body.snapshot);
}
save('single_domain_field_policy_matches_direct_and_durable_paths',{fields:policyCases.map(x=>x[0])});

// Pagination visits all visible records exactly once, without requiring any remembered ID.
const ids=[];let after=0;do{result=await call('list',{after,limit:2});assert.equal(result.status,200);ids.push(...result.body.operations.map(o=>o.operationId));after=result.body.nextAfter;}while(after!==null);
assert.equal(new Set(ids).size,ids.length);assert.equal(ids.length,await db.prepare("SELECT count(*) n FROM operation_intents WHERE principal_id='AGENT_A'").first('n'));save('bounded_stable_pagination',{count:ids.length});
result=await call('get',{operationId:'lost_prepare'},'B');assert.equal(result.status,404);assert.equal(JSON.stringify(result.body).includes(body),false);
result=await call('list',{},'B');assert.deepEqual(result.body.operations,[]);save('cross_principal_input_and_receipt_denied');
// Revoke between authentication and actual SELECT, then between validation and actual INSERT.
result=await call('get',{operationId:'lost_prepare'},'A','revoke_before_read');assert.equal(result.status,403);assert.equal(JSON.stringify(result.body).includes(body),false);
result=await call('list',{});for(const item of result.body.operations)assert.equal((await call('get',{operationId:item.operationId})).body.requiredPermissions.includes('edit'),false);assert.equal(result.body.operations.some(o=>o.operationId==='assign_saved'),true);assert.equal(result.body.operations.some(o=>o.operationId==='acquire_saved'),true);assert.equal((await call('execute',{operationId:'delayed_prepare'})).status,403);
await rights();result=await call('prepare',prep('revoke_prepare'),'A','revoke_before_batch');assert.equal(result.status,403);assert.deepEqual(await counts('revoke_prepare'),empty);
await rights();result=await call('execute',{operationId:'delayed_prepare'},'A','revoke_before_batch');assert.equal(result.status,403);assert.deepEqual(await counts('delayed_prepare'),prepared);await rights();
save('revocation_checked_inside_reads_and_atomic_writes');
// A new credential of the same principal can resume; revoked old credentials cannot discover.
await db.prepare("UPDATE api_credentials SET revoked_at=unixepoch() WHERE id='KEY_A'").run();
assert.equal((await call('list',{})).status,401);result=await call('get',{operationId:'lost_prepare'},'A2');assert.equal(result.status,200);assert.equal(result.body.input.body,body);
await db.prepare("UPDATE api_credentials SET revoked_at=NULL WHERE id='KEY_A'").run();save('credential_replacement_preserves_principal_owned_intents');
// Stopped permits recovery reads only; importing excludes every business journal route.
await gate('stopped');result=await call('execute',{operationId:'lost_prepare'});assert.equal(result.status,200);assert.equal(result.metrics.businessBatches,0);assert.equal((await call('get',{operationId:'lost_prepare'})).status,200);assert.equal((await call('list',{})).status,200);
assert.equal((await call('prepare',prep('stopped_prepare'))).status,503);assert.equal((await call('execute',{operationId:'delayed_prepare'})).status,503);
await gate('importing');for(const [path,input]of [['get',{operationId:'lost_prepare'}],['list',{}],['prepare',prep('import_prepare')],['execute',{operationId:'delayed_prepare'}]])assert.equal((await call(path,input)).status,503,path);
await gate('open');result=await call('get',{operationId:'lost_prepare'},'A','import_before_read');assert.equal(result.status,503);await gate('open');
result=await call('list',{},'A','import_before_read');assert.equal(result.status,503);await gate('open');
result=await call('prepare',prep('gate_prepare'),'A','stop_before_batch');assert.equal(result.status,503);assert.deepEqual(await counts('gate_prepare'),empty);await gate('open');
result=await call('execute',{operationId:'delayed_prepare'},'A','stop_before_batch');assert.equal(result.status,503);assert.deepEqual(await counts('delayed_prepare'),prepared);await gate('open');save('gate_policy_and_atomic_gate_races');
// Concurrent same-ID and delayed executions converge to one business/history/receipt.
await call('prepare',prep('concurrent'));
const pending=call('execute',{operationId:'concurrent'},'A','hold_execute');await waitHeld();
assert.equal((await call('execute',{operationId:'concurrent'})).status,200);await release();assert.equal((await pending).status,200);assert.deepEqual(await counts('concurrent'),committed);save('delayed_and_concurrent_execute_exactly_one_commit',{stored:await counts('concurrent')});
// Retained known-shape future formats remain discoverable under current authority, but never execute.
await db.prepare(`INSERT INTO operation_intents(principal_id,operation_id,format_version,operation_kind,target_id,project_id,route_json,input_json,input_hash,required_permissions,prepared_at)
 SELECT principal_id,'future_format',2,operation_kind,target_id,project_id,route_json,replace(input_json,'delayed_prepare','future_format'),input_hash,required_permissions,prepared_at FROM operation_intents WHERE principal_id='AGENT_A' AND operation_id='delayed_prepare'`).run();
result=await call('get',{operationId:'future_format'});assert.equal(result.status,200);assert.equal(result.body.formatVersion,2);
result=await call('execute',{operationId:'future_format'});assert.equal(result.status,409);assert.equal(result.body.error,'operation_format_unsupported');save('unsupported_format_preserved_not_executed');
// Corrupt/old stored routing must not select a generic receipt or target fallback.
await db.prepare(`INSERT INTO operation_intents(principal_id,operation_id,format_version,operation_kind,target_id,project_id,route_json,input_json,input_hash,required_permissions,prepared_at)
 SELECT principal_id,'malformed_route',1,operation_kind,target_id,project_id,json_set(route_json,'$.kind','management'),replace(input_json,'delayed_prepare','malformed_route'),input_hash,required_permissions,prepared_at FROM operation_intents WHERE principal_id='AGENT_A' AND operation_id='delayed_prepare'`).run();
result=await call('get',{operationId:'malformed_route'});assert.equal(result.status,403);assert.equal(JSON.stringify(result.body).includes(body),false);
result=await call('list',{});assert.equal(result.body.operations.some(o=>o.operationId==='malformed_route'),false);save('malformed_stored_route_fails_closed');
await assert.rejects(db.prepare(`INSERT INTO operation_intents(principal_id,operation_id,format_version,operation_kind,target_id,project_id,route_json,input_json,input_hash,required_permissions,prepared_at)
 SELECT principal_id,'retired_kind',1,'retired.command',target_id,project_id,route_json,replace(input_json,'delayed_prepare','retired_kind'),input_hash,required_permissions,prepared_at FROM operation_intents WHERE principal_id='AGENT_A' AND operation_id='delayed_prepare'`).run(),/CHECK constraint failed/);save('unknown_operation_kind_rejected_by_storage');

// Strict envelope excludes secrets, management routes, and caller-supplied authority.
for(const value of [ {route:{kind:'management',projectId:'P'},input:{operationId:'no_secret'}},prep('no_secret',{token:'Synthetic forbidden field'}),{...prep('no_secret'),principalId:'AGENT_B'}])assert.equal((await call('prepare',value)).status,400);
assert.deepEqual(await counts('no_secret'),empty);save('closed_business_only_input_schema');
await assert.rejects(db.prepare("UPDATE operation_intents SET input_json='{}' WHERE operation_id='delayed_prepare'").run(),/immutable/);
await assert.rejects(db.prepare("DELETE FROM operation_intents WHERE operation_id='delayed_prepare'").run(),/immutable/);
await assert.rejects(db.prepare("INSERT OR REPLACE INTO operation_intents SELECT * FROM operation_intents WHERE operation_id='delayed_prepare'").run(),/immutable/);
await assert.rejects(db.prepare("INSERT OR REPLACE INTO operation_intents SELECT sequence,'AGENT_B',operation_id,format_version,operation_kind,target_id,project_id,route_json,input_json,input_hash,required_permissions,prepared_at FROM operation_intents WHERE operation_id='delayed_prepare'").run(),/immutable/);
assert.equal((await call('get',{operationId:'delayed_prepare'},'B')).status,404);save('immutable_input_and_retention_enforced_in_d1');
// Directory commands retain their original input across restart; creation requires current
// global authority while editing permits the explicit view/manage scope intersection.
await db.prepare("UPDATE principal_management SET global_administrator=1 WHERE principal_id='AGENT_A'").run();
const directoryPreparation={route:{kind:'workspace'},input:{operationId:'directory_workspace_create',name:'Exact durable workspace'}};
result=await call('prepare',directoryPreparation);assert.equal(result.status,200,JSON.stringify(result.body));
const workspaceTarget=result.body.target.targetId,workspaceScope='workspace:'+workspaceTarget,originalHash=result.body.inputHash;
assert.equal(await db.prepare('SELECT count(*) n FROM workspaces WHERE id=?').bind(workspaceTarget).first('n'),0);
await mf.dispose();await start();
result=await call('get',{operationId:'directory_workspace_create'});assert.equal(result.status,200);assert.deepEqual(result.body.input,directoryPreparation.input);assert.equal(result.body.inputHash,originalHash);
result=await call('execute',{operationId:'directory_workspace_create'});assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.snapshot.id,workspaceTarget);
result=await call('execute',{operationId:'directory_workspace_create'});assert.equal(result.status,200);assert.equal(result.body.source,'recovered');assert.equal(result.metrics.businessBatches,0);
assert.equal(await db.prepare('SELECT count(*) n FROM memberships WHERE project_id=?').bind(workspaceScope).first('n'),0);
await db.prepare("UPDATE principal_management SET global_administrator=0 WHERE principal_id='AGENT_A'").run();
for(const path of ['get','execute'])assert.equal((await call(path,{operationId:'directory_workspace_create'})).status,403);
assert.equal((await call('list',{})).body.operations.some(x=>x.operationId==='directory_workspace_create'),false);
for(const permission of ['view','manage']){
 await db.prepare("INSERT INTO memberships VALUES('AGENT_A',?,?)").bind(workspaceScope,permission).run();
 await db.prepare("INSERT INTO api_grants VALUES('KEY_A',?,?)").bind(workspaceScope,permission).run();
}
const directoryEdit={route:{kind:'workspace',id:workspaceTarget},input:{operationId:'directory_workspace_edit',revision:1,name:'Scoped manager edit'}};
result=await call('prepare',directoryEdit);assert.equal(result.status,200,JSON.stringify(result.body));
await db.prepare("DELETE FROM api_grants WHERE credential_id='KEY_A' AND project_id=? AND permission='manage'").bind(workspaceScope).run();
for(const path of ['get','execute'])assert.equal((await call(path,{operationId:'directory_workspace_edit'})).status,403);
await db.prepare("INSERT INTO api_grants VALUES('KEY_A',?,'manage')").bind(workspaceScope).run();
result=await call('execute',{operationId:'directory_workspace_edit'});assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.snapshot.revision,2);
await db.prepare("DELETE FROM memberships WHERE principal_id='AGENT_A' AND project_id=? AND permission='manage'").bind(workspaceScope).run();
for(const path of ['get','execute'])assert.equal((await call(path,{operationId:'directory_workspace_edit'})).status,403);
await db.prepare("INSERT INTO memberships VALUES('AGENT_A',?,'manage')").bind(workspaceScope).run();
await db.prepare(`INSERT INTO operation_intents(principal_id,operation_id,format_version,operation_kind,target_id,project_id,route_json,input_json,input_hash,required_permissions,prepared_at)
 SELECT principal_id,'directory_malformed',1,operation_kind,target_id,project_id,json_set(route_json,'$.id','OTHER'),json_set(input_json,'$.operationId','directory_malformed'),input_hash,required_permissions,prepared_at FROM operation_intents WHERE operation_id='directory_workspace_edit'`).run();
assert.equal((await call('get',{operationId:'directory_malformed'})).status,403);
assert.equal((await call('list',{})).body.operations.some(x=>x.operationId==='directory_malformed'),false);
await db.prepare(`INSERT INTO operation_intents(principal_id,operation_id,format_version,operation_kind,target_id,project_id,route_json,input_json,input_hash,required_permissions,prepared_at)
 SELECT principal_id,'directory_future',2,operation_kind,target_id,project_id,route_json,json_set(input_json,'$.operationId','directory_future'),input_hash,required_permissions,prepared_at FROM operation_intents WHERE operation_id='directory_workspace_edit'`).run();
assert.equal((await call('get',{operationId:'directory_future'})).status,200);
result=await call('execute',{operationId:'directory_future'});assert.equal(result.status,409);assert.equal(result.body.error,'operation_format_unsupported');
await db.prepare(`INSERT INTO operation_intents(principal_id,operation_id,format_version,operation_kind,target_id,project_id,route_json,input_json,input_hash,required_permissions,prepared_at)
 SELECT principal_id,'directory_bad_input',1,operation_kind,target_id,project_id,route_json,input_json,input_hash,required_permissions,prepared_at FROM operation_intents WHERE operation_id='directory_workspace_edit'`).run();
assert.equal((await call('get',{operationId:'directory_bad_input'})).status,403);
save('directory_restart_receipt_first_and_current_global_or_scoped_authority');
assert.equal(report.externalRequests,0);report.passed=true;
}catch(error){report.passed=false;report.failure={name:error.name,message:error.message,stack:error.stack};throw error;}
finally{report.changedSourcesDuringRun=[];for(const file of capturedFiles){if(createHash('sha256').update(await readFile(resolve(candidate,file))).digest('hex')!==report.sourceHashes[file])report.changedSourcesDuringRun.push(file);}report.finishedAt=new Date().toISOString();await writeFile(output,JSON.stringify(report,null,2)+'\n');if(mf)await mf.dispose();await rm(root,{recursive:true,force:true});}
console.log(JSON.stringify(report,null,2));
