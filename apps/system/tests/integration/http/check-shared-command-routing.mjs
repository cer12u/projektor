// @module verification
// @role shared-command-routing
// Real Worker routes + official MCP + workerd/D1. A deliberately wrong pure Work decision must
// change the durable result through direct REST, prepared HTTP and prepared MCP alike.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {CfWorkerJsonSchemaValidator} from '@modelcontextprotocol/client/validators/cf-worker';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,join,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {prepareLocalD1,verifyCanonicalLedger} from '../../support/local-d1-fixture.mjs';
const candidate=fileURLToPath(new URL('../../../',import.meta.url)),root=await mkdtemp(join(tmpdir(),'projektor-shared-routing-'));
const output=resolve(candidate,'.local/evidence/shared-command-routing.json'),origin='https://routing.invalid',token='r'.repeat(43);
await mkdir(resolve(candidate,'.local/evidence'),{recursive:true});
const hash=b=>createHash('sha256').update(b).digest('hex');
const report={runnerSha256:hash(await readFile(fileURLToPath(import.meta.url))),startedAt:new Date().toISOString(),passed:false,level:'source-bundled actual Worker HTTP/MCP, local workerd and canonical D1; not final-dist or deployed proof',externalRequests:0,productionActions:0,runs:[]};
let mf,client;
try{
 const fixture=await prepareLocalD1(root);
 for(const mutant of [false,true]){
  const mode=mutant?'negative-control':'normal',bundle=join(root,mode+'.mjs');
  const source=`import product from '${candidate}/src/apps/worker.ts';export default {fetch(request,env){const headers=new Headers(request.headers);headers.set('Host',new URL(request.url).host);return product.fetch(new Request(request,{headers}),env);}};`;
  const compilation=await build({stdin:{contents:source,resolveDir:candidate,sourcefile:'shared-routing-fixture.ts'},outfile:bundle,bundle:true,format:'esm',platform:'neutral',mainFields:['module','main'],conditions:['workerd','worker','browser'],external:['node:*','cloudflare:*'],metafile:true,plugins:[{name:'test-control-and-wasm',setup(b){b.onResolve({filter:/\.wasm$/},a=>({path:'./'+basename(a.path),external:true}));if(mutant)b.onLoad({filter:/modules\/work\/decisions\.ts$/},async a=>{const original=await readFile(a.path,'utf8');assert(original.includes('priorityKey(patch.priority)'));return {contents:original.replace('priorityKey(patch.priority)',"'urgent'"),loader:'ts'};});}}]});
  const sources=Object.keys(compilation.metafile.inputs).filter(p=>!p.includes('node_modules')&&!p.endsWith('shared-routing-fixture.ts'));
  const run={mode,bundleSha256:hash(await readFile(bundle)),fixtureSha256:hash(source),normalization:'Test wrapper restores request Host overwritten by Miniflare; URL, Origin, auth, body and product validation unchanged.',sourceHashes:Object.fromEntries(await Promise.all(sources.map(async p=>[p,hash(await readFile(resolve(candidate,p)))]))),paths:[]};report.runs.push(run);
  run.wasmSha256={};
  const modules=[{type:'ESModule',path:bundle,contents:await readFile(bundle,'utf8')}];
  for(const name of ['argon2.wasm','blake2b.wasm']){const contents=await readFile(join(candidate,'src/adapters/crypto/generated',name));run.wasmSha256[name]=hash(contents);modules.push({type:'CompiledWasm',path:join(root,name),contents});}
  mf=new Miniflare(convertV4MiniflareOptions({name:'shared-command-routing',modules,modulesRoot:root,compatibilityDate:'2026-10-09',compatibilityFlags:['nodejs_compat'],...fixture,bindings:{AUTH_ORIGIN:origin,MCP_ENABLED:'true'},serviceBindings:{ASSETS:()=>new Response('static')},outboundService:()=>{report.externalRequests++;throw Error('External request denied');},host:'127.0.0.1',port:0,cf:false,logRequests:false}));
  await mf.ready;const db=await mf.getD1Database('DB'),worker=await mf.getWorker();await verifyCanonicalLedger(db);
  if(!mutant){
   await db.prepare("INSERT INTO principals VALUES('ROUTING_AGENT','agent','Synthetic routing',NULL,1,1)").run();
   await db.prepare("INSERT INTO api_credentials VALUES('ROUTING_KEY','ROUTING_AGENT',?,unixepoch()+3600,NULL)").bind(hash(token)).run();
   for(const p of ['view','edit','assign','transition']){await db.prepare("INSERT INTO memberships VALUES('ROUTING_AGENT','P',?)").bind(p).run();await db.prepare("INSERT INTO api_grants VALUES('ROUTING_KEY','P',?)").bind(p).run();}
  }
  async function http(path,method='GET',body){const response=await worker.fetch(origin+path,{method,headers:{Authorization:'Bearer '+token,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json()};}
  client=new Client({name:'shared-routing-check',version:'1'},{jsonSchemaValidator:new CfWorkerJsonSchemaValidator()});
  await client.connect(new StreamableHTTPClientTransport(new URL(origin+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+token}},fetch:(url,init)=>worker.fetch(String(url),init)}));
  const tool=async(name,args)=>{const r=await client.callTool({name,arguments:args});assert(!r.isError,JSON.stringify(r));return r.structuredContent;};
  for(const path of ['direct-rest','prepared-http','prepared-mcp']){
   const operationId=mode+'-'+path,created=await http('/api/projects/P/issues','POST',{operationId:operationId+'-create',body:'Shared decision'});assert.equal(created.status,200,JSON.stringify(created));const issueId=created.body.snapshot.id;
   const input={operationId,revision:1,priority:3};let receipt;
   if(path==='direct-rest'){const r=await http('/api/projects/P/issues/'+issueId,'PATCH',input);assert.equal(r.status,200,JSON.stringify(r));receipt=r.body;}
   else if(path==='prepared-http'){
    const p=await http('/api/agent/operations','POST',{route:{kind:'issue',projectId:'P',id:issueId},input});assert.equal(p.status,200,JSON.stringify(p));assert.equal(p.body.operation.recorded,true);
    const e=await http('/api/agent/operations/'+operationId+'/execute','POST',{});assert.equal(e.status,200,JSON.stringify(e));receipt=e.body;
   }else{const p=await tool('issue_update_prepare',{projectId:'P',issueId,input});assert.equal(p.recorded,true);receipt=await tool('operation_execute',{operationId});}
   const stored=await db.prepare('SELECT revision,priority,priority_key FROM issues WHERE id=?').bind(issueId).first();
   const expected=mutant?'urgent':'high';assert.equal(receipt.snapshot.priorityKey,expected);assert.deepEqual(stored,{revision:2,priority:3,priority_key:expected});
   assert.equal(await db.prepare('SELECT count(*) n FROM issue_history WHERE operation_id=?').bind(operationId).first('n'),1);
   assert.equal(await db.prepare("SELECT count(*) n FROM operation_results WHERE operation_id=? AND state='confirmed'").bind(operationId).first('n'),1);
   run.paths.push({path,operationId,expectedPriorityKey:expected,actualPriorityKey:stored.priority_key,revision:stored.revision,ruleDefectDetected:mutant});
  }
  // Future stored inputs remain discoverable but cannot dispatch a new mutation.
  const futureId=mode+'-future-unknown',futureInput={operationId:futureId,body:'Future retained input',futureField:{version:2}};
  await db.prepare(`INSERT INTO operation_intents(principal_id,operation_id,format_version,operation_kind,target_id,project_id,route_json,input_json,input_hash,required_permissions,prepared_at) VALUES('ROUTING_AGENT',?,2,'issue.create',?,'P',?,?,?,'["edit","view"]',unixepoch())`)
   .bind(futureId,'I_'+hash(JSON.stringify(['ROUTING_AGENT',futureId])),JSON.stringify({kind:'issue',projectId:'P'}),JSON.stringify(futureInput),'a'.repeat(64)).run();
  const future=await tool('operation_get',{operationId:futureId});assert.equal(future.formatVersion,2);assert.deepEqual(future.input,futureInput);
  const futureDenied=await client.callTool({name:'operation_execute',arguments:{operationId:futureId}});assert.equal(futureDenied.isError,true);assert.equal(futureDenied.structuredContent.status,409);assert.equal(futureDenied.structuredContent.error,'operation_format_unsupported');
  assert.equal(await db.prepare('SELECT count(*) n FROM operation_results WHERE operation_id=?').bind(futureId).first('n'),0);
  // A recognized canonical confirmed receipt is independent of unknown future input encoding.
  const futureConfirmedId=mode+'-direct-rest',row=await db.prepare('SELECT target_id,input_hash FROM operation_results WHERE operation_id=?').bind(futureConfirmedId).first();
  const futureConfirmedInput={operationId:futureConfirmedId,revision:1,priority:3,futureField:'retained'};
  await db.prepare(`INSERT INTO operation_intents(principal_id,operation_id,format_version,operation_kind,target_id,project_id,route_json,input_json,input_hash,required_permissions,prepared_at) VALUES('ROUTING_AGENT',?,2,'issue.edit',?,'P',?,?,?,'["edit","view"]',unixepoch())`)
   .bind(futureConfirmedId,row.target_id,JSON.stringify({kind:'issue',projectId:'P',id:row.target_id}),JSON.stringify(futureConfirmedInput),row.input_hash).run();
  const storedFuture=await tool('operation_get',{operationId:futureConfirmedId});assert.deepEqual(storedFuture.input,futureConfirmedInput);assert.equal(storedFuture.result.status,'confirmed');
  const recoveredFuture=await tool('operation_execute',{operationId:futureConfirmedId});assert.equal(recoveredFuture.source,'recovered');assert.deepEqual(recoveredFuture.snapshot,storedFuture.result.snapshot);
  assert.equal(await db.prepare('SELECT count(*) n FROM issue_history WHERE operation_id=?').bind(futureConfirmedId).first('n'),1);
  run.futureOpaqueInput={discovered:true,newExecutionRefused:true,confirmedReceiptRecovered:true};
  // Denied lookups/execute keep request-known ID, never protected input or receipt data.
  const deniedId=mode+'-prepared-http';await db.prepare("DELETE FROM memberships WHERE principal_id='ROUTING_AGENT' AND permission='view'").run();
  for(const [suffix,method,body] of [['','GET',undefined],['/execute','POST',{}]]){const denied=await http('/api/agent/operations/'+deniedId+suffix,method,body);assert.equal(denied.status,403);assert.deepEqual(denied.body,{error:'forbidden',operationId:deniedId,application:'unknown'});}
  for(const name of ['operation_get','operation_execute','operation_result']){
   const args={operationId:deniedId,...(name==='operation_result'?{scopeId:'P',resource:{kind:'issue'}}:{})};
   const denied=await client.callTool({name,arguments:args});assert.equal(denied.isError,true);assert.deepEqual(denied.structuredContent,{error:'forbidden',status:403,operationId:deniedId,application:'unknown'});
  }
  await db.prepare("INSERT INTO memberships VALUES('ROUTING_AGENT','P','view')").run();
  await db.prepare("UPDATE write_gate SET mode='importing',epoch=epoch+1 WHERE id=1").run();
  for(const [suffix,method,body] of [['','GET',undefined],['/execute','POST',{}]]){const denied=await http('/api/agent/operations/'+deniedId+suffix,method,body);assert.equal(denied.status,503);assert.deepEqual(denied.body,{error:'import_in_progress',operationId:deniedId,application:'unknown'});}
  for(const name of ['operation_get','operation_execute','operation_result']){
   const args={operationId:deniedId,...(name==='operation_result'?{scopeId:'P',resource:{kind:'issue'}}:{})};
   const denied=await client.callTool({name,arguments:args});assert.equal(denied.isError,true);assert.deepEqual(denied.structuredContent,{error:'import_in_progress',status:503,operationId:deniedId,application:'unknown'});
  }
  await db.prepare("UPDATE write_gate SET mode='open',epoch=epoch+1 WHERE id=1").run();
  const forged=await http('/api/agent/operations','POST',{route:{kind:'issue',projectId:'P'},input:{operationId:mode+'-forged',body:'must not persist'},fence:{formatVersion:1},plan:{permissions:[]}});assert.equal(forged.status,400);
  assert.equal(await db.prepare("SELECT count(*) n FROM operation_intents WHERE operation_id=?").bind(mode+'-forged').first('n'),0);
  run.publicPlanInjectionRejected=true;
  run.knownIdDenialWithheld=true;run.outerGateKnownIdPreserved=true;
  run.changedSourcesDuringRun=[];for(const [p,h]of Object.entries(run.sourceHashes))if(hash(await readFile(resolve(candidate,p)))!==h)run.changedSourcesDuringRun.push(p);
  assert.deepEqual(run.changedSourcesDuringRun,[],'Source changed during run; retain evidence but rerun final association');
  await client.close();client=undefined;await mf.dispose();mf=undefined;
 }
 assert.equal(report.externalRequests,0);report.passed=true;
}catch(error){report.failure={message:error.message};throw error;}finally{await client?.close();await mf?.dispose();report.finishedAt=new Date().toISOString();await writeFile(output,JSON.stringify(report,null,2)+'\n');await rm(root,{recursive:true,force:true});}
console.log(JSON.stringify({passed:report.passed,runs:report.runs.map(r=>({mode:r.mode,paths:r.paths,knownIdDenialWithheld:r.knownIdDenialWithheld})),evidence:output}));
