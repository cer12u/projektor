// @module verification
// @role deployment-contract
import test from 'node:test';
import {ACCOUNT,WORKER,DATABASE,configuration} from './synthetic-target.mjs';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPrerequisiteReader,assertProxyRuntime,projectionHash,projectDomains} from '../../deploy/prerequisite-reader.mjs';
import {requiredOperations} from '../../deploy/cloudflare-port.mjs';
import {createWranglerAdapter} from '../../deploy/wrangler-adapter.mjs';
import {createReleaseUseCase} from '../../deploy/release-use-case.mjs';
const candidate=fileURLToPath(new URL('../../',import.meta.url));
const target={account:ACCOUNT,worker:WORKER},version='11111111-1111-4111-8111-111111111111';
const appId='44444444-4444-4444-8444-444444444444';
const root='https://api.cloudflare.com/client/v4/accounts/'+ACCOUNT;
const migrations=(await readdir(resolve(candidate,'migrations'))).filter(p=>p.endsWith('.sql')).sort();
const schema=JSON.parse(await readFile(resolve(candidate,'deploy/schema-contract.json'))).objects;
const result=rows=>({success:true,results:rows,meta:{changed_db:false,rows_written:0}});
function body(path){
  if(path.endsWith('/deployments'))return {deployments:[{id:'22222222-2222-4222-8222-222222222222',created_on:'2026-10-12T10:00:00Z',versions:[{version_id:version,percentage:100}]}]};
  if(path==='/workers/services/'+WORKER)return {id:WORKER,default_environment:{environment:'production',script:{tag:'script-tag',tags:[],last_deployed_from:'wrangler',migration_tag:'v2'}}};
  if(path.endsWith('/settings'))return {placement:{},usage_model:'standard',tags:[],tail_consumers:[],logpush:false,observability:{enabled:true},bindings:[{name:'SECRET',type:'secret_text',value:'NEVER_RETURN'}]};
  if(path.startsWith('/workers/domains?'))return [{id:'domain',hostname:'fixture.example.test',service:WORKER,environment:'production',zone_id:'zone',zone_name:'example.test',cert_id:'uncompared-cert'}];
  if(path.startsWith('/access/apps?'))return [{id:appId,domain:'fixture.example.test',type:'self_hosted',session_duration:'24h',aud:'audience-metadata',allowed_idps:['idp'],auto_redirect_to_identity:false}];
  if(path.startsWith('/access/apps/'+appId+'/policies?'))return [{id:'policy',decision:'allow',include:[{email:{email:'synthetic@example.test'}}],exclude:[],require:[]}];
  if(path==='/d1/database/'+DATABASE+'/query')return [result(migrations.map(name=>({name}))),result([{mode:'stopped',epoch:4}]),result([{quick_check:'ok'}]),result([]),result(schema),result([{ownerId:"synthetic-owner",issuer:"https://fixture.cloudflareaccess.com",audience:"a".repeat(64),subject:"66666666-6666-4666-8666-666666666666",closesAt:1700000000}])];
  throw Error('UNEXPECTED_TEST_ROUTE');
}
function response(url,data,status=200,extra={}){const r=new Response(JSON.stringify({success:status===200,result:data,...extra}),{status,headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:url});return r;}
function harness(replace=()=>undefined,options={}){
  const calls=[],waits=[];let checks=0,runs=0;
  const env={CLOUDFLARE_API_TOKEN:'SYNTHETIC_NOT_A_CREDENTIAL',HTTPS_PROXY:'http://127.0.0.1:9'};
  const credentials={check(){checks++;},run(fn){runs++;return fn(env);}};
  const reader=createPrerequisiteReader({candidate,credentials,configuration,runtime:{version:'24.19.0',execArgv:['--use-env-proxy']},fetchImpl:async(url,init)=>{calls.push({url,init});return await replace(url,init,calls.length)||response(url,body(url.slice(root.length)));},sleep:async ms=>waits.push(ms),...options});
  return {reader,calls,waits,counts:()=>({checks,runs})};
}
test('fixed read-only target and two complete scans yield only normalized metadata/hashes',async()=>{
  const h=harness(),p=await h.reader.inspect(target,version);
  assert.equal(h.calls.length,16);assert.deepEqual(p.database,{id:DATABASE,migrationNames:migrations});assert.equal(p.service.projection,'default_environment.script');assert.equal(p.service.hasPreview,undefined);
  assert.deepEqual(p.gate,{mode:'stopped',epoch:4});assert.equal(p.currentVersion,version);
  assert.equal(JSON.stringify(p).includes('NEVER_RETURN'),false);assert.equal(JSON.stringify(p).includes('synthetic@example.test'),false);
  for(const {url,init}of h.calls){assert.ok(url.startsWith(root+'/'));assert.equal(init.redirect,'error');assert.equal(url.includes('SYNTHETIC'),false);assert.equal(init.headers.Authorization,'Bearer SYNTHETIC_NOT_A_CREDENTIAL');assert.ok(['GET','POST'].includes(init.method));if(init.method==='POST'){assert.equal(url,root+'/d1/database/'+DATABASE+'/query');assert.doesNotMatch(JSON.parse(init.body).sql,/\b(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/);}}
  assert.deepEqual(h.counts(),{checks:1,runs:1});
});
test('wrong account/worker and malformed version fail before credential check or request',async()=>{
  for(const [t,id]of [[{...target,account:'other'},version],[{...target,worker:'other'},version],[target,'../other']]){const h=harness();await assert.rejects(h.reader.inspect(t,id));assert.equal(h.calls.length,0);assert.deepEqual(h.counts(),{checks:0,runs:0});}
});
test('the proxy startup flag and pinned supported Node runtime are mandatory before requests',async()=>{
  for(const runtime of [{version:'24.19.0',execArgv:[]},{version:'22.19.0',execArgv:['--use-env-proxy']},{version:'24.19.0',execArgv:['--use-env-proxy','--no-use-env-proxy']}]){const h=harness(undefined,{runtime});await assert.rejects(h.reader.inspect(target,version));assert.equal(h.calls.length,0);assert.deepEqual(h.counts(),{checks:0,runs:0});}
  assert.doesNotThrow(()=>assertProxyRuntime({version:'24.19.0',execArgv:['--use-env-proxy']}));
});
test('401/403 are terminal at the exact failed read; no retry or later request',async()=>{
  for(const status of [401,403]){const h=harness((url,init,n)=>n===3?response(url,{secret:'NEVER_RETURN'},status):undefined);await assert.rejects(h.reader.inspect(target,version),e=>e.kind==='auth-denied'&&e.code==='PREREQUISITE_AUTH_DENIED');assert.equal(h.calls.length,3);assert.deepEqual(h.waits,[]);assert.equal(h.counts().runs,1);}
});
test('authorization error in a success-status API envelope is terminal',async()=>{const h=harness(url=>response(url,null,200,{success:false,errors:[{code:10000,message:'SYNTHETIC_NOT_A_CREDENTIAL'}]}));await assert.rejects(h.reader.inspect(target,version),e=>e.kind==='auth-denied'&&!e.message.includes('SYNTHETIC'));assert.equal(h.calls.length,1);assert.deepEqual(h.waits,[]);});
test('safe transient reads have at most three spaced retries and no auth renewal',async()=>{
  const h=harness(url=>response(url,null,503));await assert.rejects(h.reader.inspect(target,version),/READ_RETRY_EXHAUSTED/);assert.equal(h.calls.length,4);assert.deepEqual(h.waits,[1000,2000,4000]);assert.deepEqual(h.counts(),{checks:1,runs:1});
});
test('a recovered safe read resumes without restarting earlier completed reads',async()=>{const h=harness((url,init,n)=>n===3?response(url,null,502):undefined);await h.reader.inspect(target,version);assert.equal(h.calls.length,17);assert.equal(h.calls[2].url,h.calls[3].url);assert.deepEqual(h.waits,[1000]);});
test('redirects and unexpected response URLs stop without forwarding auth',async()=>{
  for(const replace of [url=>response(url,null,302),url=>{const r=response('https://example.invalid/',null);return r;},()=>{throw new TypeError('fetch failed',{cause:Error('unexpected redirect')});}]){const h=harness(replace);await assert.rejects(h.reader.inspect(target,version));assert.equal(h.calls.length,1);assert.deepEqual(h.waits,[]);assert.ok(h.calls.every(c=>c.url.startsWith(root)));}
});
test('thrown provider errors and malformed body never leak raw text',async()=>{
  const h=harness(()=>{throw Error('SYNTHETIC_NOT_A_CREDENTIAL');});await assert.rejects(h.reader.inspect(target,version),e=>e.message==='READ_TRANSPORT_FAILED');assert.equal(h.calls.length,1);
  const m=harness(url=>{const r=new Response('SYNTHETIC_NOT_A_CREDENTIAL',{headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:url});return r;});await assert.rejects(m.reader.inspect(target,version),/INVALID_READ_JSON/);assert.equal(m.calls.length,1);
});
test('missing relied-upon service/settings fields, DB write metadata and incomplete pages fail closed',async()=>{
  for(const mutate of [p=>{delete p.default_environment.script.migration_tag;},null]){
    if(mutate){const h=harness(url=>{if(!url.endsWith('/services/'+WORKER))return;const data=body(url.slice(root.length));mutate(data);return response(url,data);});await assert.rejects(h.reader.inspect(target,version));assert.equal(h.calls.length,2);}
  }
  const h=harness(url=>url.includes('/query')?response(url,body(url.slice(root.length)).map(r=>({...r,meta:{changed_db:true,rows_written:1}}))):undefined);await assert.rejects(h.reader.inspect(target,version),/D1_READ_NOT_CERTIFIED/);
  const p=harness(url=>url.includes('/domains?')?response(url,body(url.slice(root.length)),200,{result_info:{page:1,per_page:100,total_count:100}}):undefined);await assert.rejects(p.reader.inspect(target,version),/PAGINATION_NOT_CERTIFIED/);
});
test('a changed deployment inside a scan or metadata between scans cannot return proof',async()=>{
  const active=harness((url,init,n)=>{if(n!==8)return;const data=body(url.slice(root.length));data.deployments[0].versions[0].version_id='33333333-3333-4333-8333-333333333333';return response(url,data);});await assert.rejects(active.reader.inspect(target,version),/PREREQUISITE_VERSION_DRIFT/);assert.equal(active.calls.length,8);
  const drift=harness((url,init,n)=>{if(n!==10)return;const data=body(url.slice(root.length));data.default_environment.script.tags=['changed'];return response(url,data);});await assert.rejects(drift.reader.inspect(target,version),/PREREQUISITE_SNAPSHOT_DRIFT/);
});
test('untrusted Access IDs cannot create an alternate path',async()=>{const h=harness(url=>{if(!url.includes('/access/apps?'))return;const data=body(url.slice(root.length));data[0].id='../../other-account';return response(url,data);});await assert.rejects(h.reader.inspect(target,version));assert.equal(h.calls.length,5);});
test('documented domain projection deliberately ignores certificate fields, never ownership',()=>{const rows=body('/workers/domains?page=1');const h=projectionHash(projectDomains(rows,target,configuration.hostname));assert.equal(projectionHash(projectDomains(rows.map(r=>({...r,cert_id:'rotated'})),target,configuration.hostname)),h);assert.notEqual(projectionHash(projectDomains(rows.map(r=>({...r,service:'other'})),target,configuration.hostname)),h);});

test('TLS rejection and opaque proxy failures are terminal rather than guessed transient',async()=>{
  for(const code of ['DEPTH_ZERO_SELF_SIGNED_CERT','UND_ERR_ABORTED']){const h=harness(()=>{throw new TypeError('fetch failed',{cause:Object.assign(Error('withheld'),{code})});});await assert.rejects(h.reader.inspect(target,version),e=>e.code===(code.includes('CERT')?'READ_TLS_REJECTED':'READ_TRANSPORT_FAILED'));assert.equal(h.calls.length,1);assert.deepEqual(h.waits,[]);}
});
test('only known transient fetch causes are eligible for the same bounded retry policy',async()=>{const h=harness(()=>{throw new TypeError('fetch failed',{cause:Object.assign(Error('withheld'),{code:'ECONNRESET'})});});await assert.rejects(h.reader.inspect(target,version),/READ_RETRY_EXHAUSTED/);assert.equal(h.calls.length,4);assert.deepEqual(h.waits,[1000,2000,4000]);});

test('same-name weakened0018/0019 triggers/index cannot certify schema compatibility',async()=>{
  for(const name of ['owner_setup_context_binding_immutable','owner_setup_operation','recipient_setup_binding_immutable','recipient_setup_operation']){const h=harness(url=>{if(!url.endsWith('/query'))return;const data=body(url.slice(root.length));data[4]=result(schema.map(r=>r.name===name?{...r,sql:name.endsWith('_operation')?'CREATE INDEX '+name+' ON '+(name.startsWith('owner_')?'owner_setup_contexts(owner_id,operation_id)':'recipient_setup_contexts(issuer_id,operation_id)'):'CREATE TRIGGER '+name+' BEFORE UPDATE ON '+(name.startsWith('owner_')?'owner_setup_contexts':'recipient_setup_contexts')+' BEGIN SELECT 1; END'}:r));return response(url,data);});await assert.rejects(h.reader.inspect(target,version),/REQUIRED_SCHEMA_DEFINITIONS_CHANGED/);assert.equal(h.calls.length,7);}
});

test('canonical0018/0019 SQL expectation is produced by the actual complete migration files',async()=>{
  const db=new DatabaseSync(':memory:');try{for(const name of migrations)db.exec(await readFile(resolve(candidate,'migrations',name),'utf8'));
    const actual=db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name IN ('owner_setup_contexts','owner_setup_operation','owner_setup_context_binding_immutable','owner_setup_context_no_extend','recipient_setup_contexts','recipient_setup_operation','recipient_setup_binding_immutable','recipient_setup_no_extend') ORDER BY name").all().map(r=>({...r,sql:r.sql.trim().replace(/\r\n/g,'\n')}));assert.deepEqual(actual,schema);
  }finally{db.close();}
});
test('actual adapter defaults fail proxy readiness before credentials or provider access',async()=>{const saved=process.execArgv;let checks=0;try{process.execArgv=[];const p=createWranglerAdapter({candidate,configuration,credentials:{check(){checks++;},run(){throw Error('UNEXPECTED_AUTH_OR_NETWORK');}}});assert.equal(p.describe().operations.inspectPrerequisites,'supported');await assert.rejects(p.ready(),/READ_PROXY_STARTUP_REQUIRED/);assert.equal(checks,0);}finally{process.execArgv=saved;}});
test('a reader schema rejection prevents the use case mutation and journal intent',async()=>{
  const h=harness(url=>{if(!url.endsWith('/query'))return;const data=body(url.slice(root.length));data[4]=result(schema.map(r=>r.name==='owner_setup_operation'?{...r,sql:'CREATE INDEX owner_setup_operation ON owner_setup_contexts(owner_id)'}:r));return response(url,data);});let mutations=0,intents=0;
  const port={describe:()=>({runtimeAvailable:true,operations:Object.fromEntries(requiredOperations.map(k=>[k,'supported']))}),ready:async()=>{},inspectDeployment:async()=>({target,observedAt:new Date().toISOString(),deploymentId:'22222222-2222-4222-8222-222222222222',versions:[{versionId:version,percentage:100}]}),inspectPrerequisites:h.reader.inspect,inspectVersion:async()=>{throw Error('UNEXPECTED_VERSION_READ');},uploadStaticVersion:async()=>{mutations++;},promoteVersion:async()=>{mutations++;}};
  const useCase=createReleaseUseCase({port,journal:{exclusive:fn=>fn(),read:async()=>null,append:async()=>{intents++;}},release:{...target,artifactTreeSha256:'a'.repeat(64)}});
  await assert.rejects(useCase.upload(version),/REQUIRED_SCHEMA_DEFINITIONS_CHANGED/);assert.equal(mutations,0);assert.equal(intents,0);
});


test('missing owner trust fails and changed issuer or audience cannot preserve its fingerprint',async()=>{
 const base=await harness().reader.inspect(target,version);
 for(const change of [null,{issuer:'https://other.cloudflareaccess.com'},{audience:'b'.repeat(64)},{subject:'77777777-7777-4777-8777-777777777777'}]){
  const h=harness(url=>{if(!url.endsWith('/query'))return;const data=body(url.slice(root.length));data[5]=result(change?[{...data[5].results[0],...change}]:[]);return response(url,data);});
  if(change){const p=await h.reader.inspect(target,version);assert.notEqual(p.security.ownerBootstrapHash,base.security.ownerBootstrapHash);}else await assert.rejects(h.reader.inspect(target,version),/OWNER_TRUST_METADATA_MISSING/);
 }
});


test('legacy service null tags follow exact pinned Wrangler normalization; malformed tags still fail',async()=>{
 for(const tags of [null,undefined,[],['provider-tag'],'invalid']){
  const h=harness(url=>{if(!url.endsWith('/services/'+WORKER))return;const data=body(url.slice(root.length));data.default_environment.script.tags=tags;return response(url,data);});
  if(tags==='invalid')await assert.rejects(h.reader.inspect(target,version));else{const p=await h.reader.inspect(target,version);assert.deepEqual(p.service.tags,tags??[]);}
 }
});


test('Access destination paths, aliases and overrides participate in current topology proof',async()=>{
 const inspect=async topology=>{const h=harness(url=>{if(!url.includes('/access/apps?'))return;const rows=body(url.slice(root.length));Object.assign(rows[0],topology);return response(url,rows);});return h.reader.inspect(target,version);};
 const whole=await inspect({destinations:[{type:'public',uri:'fixture.example.test'}]});
 const path=await inspect({destinations:[{type:'public',uri:'fixture.example.test/owner/setup'}]});
 assert.notEqual(whole.security.accessPoliciesHash,path.security.accessPoliciesHash);
 const override=await inspect({destinations:[{type:'public',uri:'fixture.example.test',overrides:[{behavior:'public',path_pattern:'/api/*'}]}]});assert.notEqual(whole.security.accessPoliciesHash,override.security.accessPoliciesHash);
 for(const extra of [{domain:'elsewhere.example.test',destinations:[{uri:'fixture.example.test/owner/setup'}]},{domain:null,self_hosted_domains:['fixture.example.test/owner/setup']},{domain:'elsewhere.example.test',destinations:[{type:'all_workers'}]},{domain:null,destinations:[{type:'worker',worker_id:'opaque-provider-id'}]}])assert.equal((await inspect(extra)).currentVersion,version);
 await assert.rejects(inspect({destinations:[{type:'unknown'}]}),/UNREVIEWED_ACCESS_DESTINATION/);
 await assert.rejects(inspect({self_hosted_domains:[{invalid:true}]}),/INVALID_ACCESS_TOPOLOGY/);
});
