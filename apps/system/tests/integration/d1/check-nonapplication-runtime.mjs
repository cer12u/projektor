// @module verification
// @role nonapplication-runtime
// Fresh local workerd/D1 checks for A6 nonapplication and A8 read denial.
// Synthetic fixture only. No remote bindings, production actions, or real credentials.
import assert from 'node:assert/strict';
import {prepareLocalD1,verifyCanonicalLedger} from "../../support/local-d1-fixture.mjs";
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {fileURLToPath} from 'node:url';
import {readFile,writeFile,mkdtemp,rm,mkdir} from 'node:fs/promises';
import {join,resolve,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
const candidate=fileURLToPath(new URL("../../../",import.meta.url));
const output=resolve('.local/evidence/nonapplication-workerd.json');
await mkdir('.local/evidence',{recursive:true});
const root=await mkdtemp(join(tmpdir(),'projektor-nonapplication-'));
const report={sourceHashes:Object.fromEntries(await Promise.all(['src/adapters/d1/persistence/commit.ts','src/apps/http/issue.ts','src/adapters/d1/work/issues.ts'].map(async file=>[file,createHash('sha256').update(await readFile(candidate+'/'+file)).digest('hex')]))),startedAt:new Date().toISOString(),candidate,runtime:'actual local workerd + local D1',productionActions:0,externalRequests:0,scenarios:[]};
let mf;
try{
 const fixture=`import {createRequestServices} from '${candidate}/src/apps/composition.ts';
 import {issueApi} from '${candidate}/src/apps/http/issue.ts';
 const held=new Map();
 export default {async fetch(request,env){
  const path=new URL(request.url).pathname;
  if(path==='/__fixture/held')return Response.json({held:held.has('batch')});
  if(path==='/__fixture/release'){held.get('batch')?.();return Response.json({released:true});}
  const raw=env.DB.withSession('first-primary'),mode=request.headers.get('X-Fixture-Mode')??'',metrics={batches:0,commits:0,storedReads:0};
  const deny=()=>raw.prepare("DELETE FROM memberships WHERE principal_id='TEST_AGENT' AND project_id='P'").run();
  const wrap=(stmt,text)=>new Proxy(stmt,{get(target,key){
   if(key==='bind')return(...values)=>wrap(target.bind(...values),text);
   if(key==='first')return async(...args)=>{
    if(text.includes('AS stored')&&mode==='preflight_unavailable')throw new Error('synthetic preflight transport failure');
    if(/SELECT operation_id,operation_kind/.test(text)){
     metrics.storedReads++;
     if(metrics.storedReads===2&&mode==='final_receipt_denied')await deny();
     if(metrics.storedReads===2&&mode==='final_receipt_unavailable')throw new Error('synthetic lost receipt response');
     if(metrics.storedReads===1&&mode==='commit_receipt_unavailable')throw new Error('synthetic lost receipt response');
    }
    return target.first(...args);
   };
   const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  const db={prepare(text){return wrap(raw.prepare(text),text);},async batch(statements){
   metrics.batches++;
   if(mode==='hold_before_batch'){let release;const wait=new Promise(resolve=>{release=resolve;});held.set('batch',release);const timer=setInterval(()=>{},20);try{await wait;}finally{clearInterval(timer);held.delete('batch');}}
   if(mode==='transport_uncertain')throw new Error('synthetic batch transport failure; outcome unknown');
   if(mode==='transport_uncertain_denied'){await deny();throw new Error('synthetic batch transport failure; outcome unknown');}
   if(mode==='atomic_guard_denied')await deny();
   const result=await raw.batch(statements);metrics.commits++;
   if(mode==='commit_then_deny'||mode==='lost_ack_denied')await deny();
   if(mode==='lost_ack'||mode==='lost_ack_denied')throw new Error('synthetic acknowledgement lost after real commit');
   return result;
  }};
  const response=await issueApi(request,createRequestServices(db,Math.floor(Date.now()/1000)),'https://fixture.invalid');
  const headers=new Headers(response.headers);headers.set('X-Fixture-Metrics',JSON.stringify(metrics));
  return new Response(response.body,{status:response.status,headers});
 }};`;
 await build({stdin:{contents:fixture,resolveDir:candidate,sourcefile:'nonapplication-fixture.ts'},outfile:root+'/worker.mjs',bundle:true,format:'esm',platform:'neutral',mainFields:['module','main'],conditions:['workerd','worker','browser'],external:['node:*','cloudflare:*'],plugins:[{name:'wasm',setup(b){b.onResolve({filter:/\.wasm$/},a=>({path:'./'+basename(a.path),external:true}));}}]});
 const modules=[{type:'ESModule',path:root+'/worker.mjs',contents:await readFile(root+'/worker.mjs','utf8')}];
 for(const name of ['argon2.wasm','blake2b.wasm'])modules.push({type:'CompiledWasm',path:root+'/'+name,contents:await readFile(candidate+'/src/adapters/crypto/generated/'+name)});
 const fixtureOptions=await prepareLocalD1(root);
 mf=new Miniflare(convertV4MiniflareOptions({name:'nonapplication-local-only',modules,modulesRoot:root,compatibilityDate:'2026-10-09',compatibilityFlags:['nodejs_compat'],...fixtureOptions,outboundService:()=>{report.externalRequests++;throw new Error('No outbound requests authorized for local test');},host:'127.0.0.1',port:0,cf:false,logRequests:false}));
 await mf.ready;
 const db=await mf.getD1Database('DB');
 await verifyCanonicalLedger(db);
 const token='S'.repeat(43),hash=createHash('sha256').update(token).digest('hex');
 await db.prepare("INSERT INTO principals VALUES('TEST_AGENT','agent','Synthetic test',NULL,1,1)").run();
 await db.prepare("INSERT INTO api_credentials VALUES('TEST_KEY','TEST_AGENT',?,unixepoch()+600,NULL)").bind(hash).run();
 for(const permission of ['view','edit'])await db.prepare("INSERT INTO api_grants VALUES('TEST_KEY','P',?)").bind(permission).run();
 async function rights(edit=true){
  await db.prepare("DELETE FROM memberships WHERE principal_id='TEST_AGENT'").run();
  for(const permission of edit?['view','edit']:['view'])await db.prepare("INSERT INTO memberships VALUES('TEST_AGENT','P',?)").bind(permission).run();
 }
 const body={title:'Private fixture title',body:'Private fixture body'};
 async function call(operationId,mode='',method='POST',fields={}){
  const response=await mf.dispatchFetch('https://fixture.invalid/api/projects/P/'+(method==='GET'?'issue-operations/'+operationId:'issues'),{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-Fixture-Mode':mode},...(method==='GET'?{}:{body:JSON.stringify({operationId,...body,...fields})})});
  return {status:response.status,body:await response.json(),metrics:JSON.parse(response.headers.get('X-Fixture-Metrics'))};
 }
 async function counts(operationId){return{
  issues:await db.prepare('SELECT count(*) n FROM issues WHERE id=?').bind('I_'+createHash('sha256').update(JSON.stringify(['TEST_AGENT',operationId])).digest('hex')).first('n'),
  history:await db.prepare('SELECT count(*) n FROM issue_history WHERE actor_id=? AND operation_id=?').bind('TEST_AGENT',operationId).first('n'),
  receipts:await db.prepare('SELECT count(*) n FROM operation_results WHERE principal_id=? AND operation_id=?').bind('TEST_AGENT',operationId).first('n'),
 };}
 const cases=[
  ['initially_forbidden','',false,403,0,true],
  ['postcommit_denied','commit_then_deny',true,403,1,false],
  ['final_receipt_denied','final_receipt_denied',true,403,1,false],
  ['lost_ack_denied','lost_ack_denied',true,403,1,false],
  ['lost_ack_recovered','lost_ack',true,200,1,false],
  ['lost_commit_receipt','commit_receipt_unavailable',true,503,1,false],
  ['lost_final_receipt','final_receipt_unavailable',true,503,1,false],
  ['unknown_transport','transport_uncertain',true,503,0,false],
  ['unknown_transport_denied','transport_uncertain_denied',true,403,0,false],
  ['atomic_guard_denied','atomic_guard_denied',true,403,0,false],
  ['failed_preflight_read','preflight_unavailable',true,503,0,false],
 ];
 for(const [name,mode,permitted,status,applied,marker]of cases){
  await rights(permitted);
  const operationId='test_'+name,result=await call(operationId,mode),stored=await counts(operationId);
  assert.equal(result.status,status,name);
  assert.deepEqual(stored,{issues:applied,history:applied,receipts:applied},name);
  if(marker){assert.deepEqual(result.body,{error:'forbidden',mutationOutcome:{operationId,status:'not_applied',phase:'pre_dispatch'}},name);assert.equal(result.metrics.batches,0);}
  else assert.equal(Object.hasOwn(result.body,'mutationOutcome'),false,name);
  if(status!==200){assert.equal(JSON.stringify(result.body).includes(body.body),false,name);assert.equal(Object.hasOwn(result.body,'snapshot'),false,name);assert.equal(Object.hasOwn(result.body,'current'),false,name);}
  if(name==='lost_ack_recovered')assert.equal(result.body.source,'recovered');
  report.scenarios.push({name,operationId,status:result.status,response:status===200?{source:result.body.source,operationId:result.body.operationId}:result.body,stored,metrics:result.metrics,passed:true});
 }
 // Already committed/acknowledgement-lost IDs must never be labeled not_applied on retry or result GET.
 const prior='test_postcommit_denied';
 for(const method of ['POST','GET']){
  await rights(false);const result=await call(prior,'',method);
  assert.equal(result.status,403);assert.deepEqual(result.body,{error:'forbidden'});
  assert.deepEqual(await counts(prior),{issues:1,history:1,receipts:1});
  report.scenarios.push({name:'stored_receipt_denied_'+method,status:result.status,response:result.body,stored:await counts(prior),passed:true});
 }
 // No operation exists, but GET404/403 is still not a negative receipt.
 await rights();const missing=await call('test_never_sent','','GET');
 assert.equal(missing.status,403);assert.deepEqual(missing.body,{error:'forbidden'});
 report.scenarios.push({name:'absent_result_not_nonapplication',status:missing.status,response:missing.body,passed:true});
 // Authorized duplicate recovery keeps one durable row/history/receipt.
 await rights();const prior2='test_lost_ack_denied',recovered=await call(prior2);
 assert.equal(recovered.status,200);assert.equal(recovered.body.source,'recovered');
 assert.deepEqual(await counts(prior2),{issues:1,history:1,receipts:1});
 report.scenarios.push({name:'same_id_recovery_no_duplicate',status:recovered.status,source:recovered.body.source,stored:await counts(prior2),passed:true});
 const mismatch=await call(prior2,'','POST',{body:'Different input'});
 assert.equal(mismatch.status,409);assert.deepEqual(mismatch.body,{error:'operation_input_mismatch'});
 assert.deepEqual(await counts(prior2),{issues:1,history:1,receipts:1});
 report.scenarios.push({name:'same_id_changed_input_rejected',status:mismatch.status,response:mismatch.body,stored:await counts(prior2),passed:true});
 // Real simultaneous same-ID requests are deduplicated transactionally.
 await rights();const concurrentId='test_simultaneous';
 const concurrent=await Promise.all([call(concurrentId),call(concurrentId)]);
 assert.deepEqual(concurrent.map(x=>x.status),[200,200]);
 assert.deepEqual(await counts(concurrentId),{issues:1,history:1,receipts:1});
 report.scenarios.push({name:'simultaneous_same_id',statuses:concurrent.map(x=>x.status),stored:await counts(concurrentId),passed:true});
 // The negative receipt deliberately describes this attempt only. Another request
 // may already have passed preflight, so clients must require a single journaled attempt.
 await rights();const overlapId='test_overlapping_attempts',first=call(overlapId,'hold_before_batch');
 let held=false;
 for(let n=0;n<100;n++){const r=await mf.dispatchFetch('https://fixture.invalid/__fixture/held');held=(await r.json()).held;if(held)break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(held,true,'first attempt reached pre-dispatch hold');
 await rights(false);const rejectedAttempt=await call(overlapId);
 assert.equal(rejectedAttempt.status,403);
 assert.deepEqual(rejectedAttempt.body.mutationOutcome,{operationId:overlapId,status:'not_applied',phase:'pre_dispatch'});
 assert.deepEqual(await counts(overlapId),{issues:0,history:0,receipts:0});
 await rights();await mf.dispatchFetch('https://fixture.invalid/__fixture/release',{method:'POST'});
 const completedAttempt=await first;assert.equal(completedAttempt.status,200);
 assert.deepEqual(await counts(overlapId),{issues:1,history:1,receipts:1});
 report.scenarios.push({name:'marker_is_attempt_scoped_concurrent_request_can_commit',deniedAttemptStatus:rejectedAttempt.status,otherAttemptStatus:completedAttempt.status,stored:await counts(overlapId),clientRequirement:'Atomic journal must certify one dispatch before allowing negative outcome to unlock input.',passed:true});
 assert.equal(report.externalRequests,0);report.passed=true;
}catch(error){report.passed=false;report.failure={name:error.name,message:error.message,stack:error.stack};throw error;}
finally{report.finishedAt=new Date().toISOString();await writeFile(output,JSON.stringify(report,null,2)+'\n');if(mf)await mf.dispose();await rm(root,{recursive:true,force:true});}
console.log(JSON.stringify(report,null,2));
