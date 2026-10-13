// @module verification
// @role operation-regression
// Focused REST/primary-client integration, not a second domain-policy suite.
// Real workerd, production router/auth, canonical Wrangler migrations, persisted
// local D1 and independently exited Node client processes. No provider calls.
import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {build} from 'esbuild';
import Ajv from 'ajv';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFile,writeFile,mkdtemp,mkdir,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {join,basename,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {prepareLocalD1,verifyCanonicalLedger} from "../../support/local-d1-fixture.mjs";

const run=promisify(execFile),candidate=fileURLToPath(new URL("../../../",import.meta.url));
const output=resolve(process.env.AGENT_OPERATION_RECOVERY_OUT??'.local/evidence/agent-operation-recovery.json');
// Optional read-only baseline entry point supports an isolated negative control.
const clientEntry=resolve(process.env.AGENT_OPERATION_CLIENT_SOURCE??candidate+'src/agent/public.ts');
const temp=await mkdtemp(join(tmpdir(),'projektor-agent-recovery-'));
const canonicalOrigin='https://fixture.invalid',tokens={A:'a'.repeat(43),B:'b'.repeat(43),A2:'c'.repeat(43)};
const hash=value=>createHash('sha256').update(value).digest('hex');
const report={startedAt:new Date().toISOString(),candidate,clientEntry,passed:false,
  runtime:'real local workerd + production Worker router/auth + persisted canonical D1 + primary Agent client in exited Node processes',
  productionActions:0,externalRequests:0,workerdStarts:0,clientProcessStarts:0,scenarios:[],sourceHashes:{}};
let mf,db,origin;
let sourceFiles=[];
const schemas=new Map(),validatedResponses=[];
const sql=(text,...values)=>db.prepare(text).bind(...values).run();
const first=(text,...values)=>db.prepare(text).bind(...values).first();
const prepared={intents:1,receipts:0,history:0,issues:0},committed={intents:1,receipts:1,history:1,issues:1};
const input=operationId=>({operationId,body:'Exact private input 日本語\n  unchanged whitespace  ',title:'Original title',references:[{kind:'link',url:'https://example.test/%2F',label:'Original reference'}]});
const preparation=operationId=>({route:{kind:'issue',projectId:'P'},input:input(operationId)});
async function counts(operationId) {
  const result={};
  for(const [name,table,actor] of [['intents','operation_intents','principal_id'],['receipts','operation_results','principal_id'],['history','issue_history','actor_id']])
    result[name]=(await first(`SELECT count(*) n FROM ${table} WHERE ${actor}='A' AND operation_id=?`,operationId)).n;
  result.issues=(await first('SELECT count(*) n FROM issues WHERE id=?','I_'+hash(JSON.stringify(['A',operationId])))).n;
  return result;
}
async function request(path,{method='GET',body,rawBody,who='A',headers={}}={}) {
  const response=await mf.dispatchFetch(canonicalOrigin+path,{method,
    headers:{...(who?{Authorization:'Bearer '+tokens[who]}:{}),...(body!==undefined||rawBody!==undefined?{'Content-Type':'application/json'}:{}),...headers},
    ...(body!==undefined||rawBody!==undefined?{body:rawBody??JSON.stringify(body)}:{})});
  const text=await response.text();let value;try{value=JSON.parse(text);}catch{value=text;}
  const pathname=new URL(canonicalOrigin+path).pathname;
  const documented=pathname==='/api/agent/operations'?pathname
    :/^\/api\/agent\/operations\/[A-Za-z0-9_-]{1,128}\/execute$/.test(pathname)?'/api/agent/operations/{operationId}/execute'
    :/^\/api\/agent\/operations\/[A-Za-z0-9_-]{1,128}$/.test(pathname)?'/api/agent/operations/{operationId}':null;
  const contract=schemas.get(method+' '+documented),validate=contract?.responses[response.status];
  if(validate){assert(validate(value),JSON.stringify({method,path,status:response.status,errors:validate.errors}));validatedResponses.push({method,path:documented,status:response.status});}
  if(contract&&response.status===200&&body!==undefined&&contract.input)assert(contract.input(body),JSON.stringify({method,path,errors:contract.input.errors}));
  return {status:response.status,body:value,headers:response.headers};
}
async function check(name,work) {
  try {const details=await work();report.scenarios.push({name,passed:true,...(details?{details}:{})});console.log('PASS '+name);}
  catch(error){report.scenarios.push({name,passed:false,error:error.message});throw error;}
}
async function child(action,extra={}) {
  report.clientProcessStarts++;
  const {stdout}=await run(process.execPath,[temp+'/child.mjs',JSON.stringify({origin,action,...extra})],{cwd:temp,maxBuffer:2*1024*1024});
  return JSON.parse(stdout);
}
async function initializedChild(extra,change) {
  report.clientProcessStarts++;
  return new Promise((resolve,reject)=>{
    const processChild=spawn(process.execPath,[temp+'/child.mjs',JSON.stringify({origin,action:'getAfterSignal',...extra})],{cwd:temp,stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='',ready=false;
    processChild.stdout.on('data',chunk=>{
      stdout+=chunk;
      if(!ready&&stdout.includes('__READY__\n')){
        ready=true;
        Promise.resolve().then(change).then(()=>processChild.stdin.end('\n')).catch(error=>{processChild.kill();reject(error);});
      }
    });
    processChild.stderr.on('data',chunk=>{stderr+=chunk;});processChild.on('error',reject);
    processChild.on('close',code=>{try{assert.equal(code,0,stderr);assert(ready,'client must establish identity before authority changes');resolve(JSON.parse(stdout.trim().split('\n').at(-1)));}catch(error){reject(error);}});
  });
}
try {
  await mkdir(resolve('.local/evidence'),{recursive:true});
  const spec=JSON.parse(await readFile(candidate+'docs/openapi.json','utf8')),ajv=new Ajv({allErrors:true,strict:false,validateSchema:false});
  ajv.addSchema({...spec,$id:'agent-operation-contract'},'agent-operation-contract');
  for(const path of ['/api/agent/operations','/api/agent/operations/{operationId}','/api/agent/operations/{operationId}/execute']) {
    assert(spec.paths[path],'published operation contract missing: '+path);
    for(const [method,operation]of Object.entries(spec.paths[path])) {
      const pointer='agent-operation-contract#/paths/'+path.replaceAll('~','~0').replaceAll('/','~1')+'/'+method;
      schemas.set(method.toUpperCase()+' '+path,{input:operation.requestBody?ajv.compile({$ref:pointer+'/requestBody/content/application~1json/schema'}):null,
        responses:Object.fromEntries(Object.keys(operation.responses).map(status=>[status,ajv.compile({$ref:pointer+'/responses/'+status+'/content/application~1json/schema'})]))});
    }
  }
  const workerBuild=await build({entryPoints:[candidate+'tests/support/agent-operation-recovery-fixture.ts'],outfile:temp+'/worker.mjs',bundle:true,format:'esm',platform:'neutral',mainFields:['module','main'],conditions:['workerd','worker','browser'],external:['node:*','cloudflare:*'],metafile:true,plugins:[{name:'wasm',setup(b){b.onResolve({filter:/\.wasm$/},a=>({path:'./'+basename(a.path),external:true}));}}]});
  const clientBuild=await build({entryPoints:[clientEntry],outfile:temp+'/client.mjs',bundle:true,format:'esm',platform:'node',metafile:true});
  sourceFiles=[...new Set([...Object.keys(workerBuild.metafile.inputs),...Object.keys(clientBuild.metafile.inputs),
    'tests/client/agent/check-agent-operation-recovery.mjs','tests/support/local-d1-fixture.mjs','migrations/0017_operation_intents.sql','docs/openapi.json'])].filter(path=>!path.includes('node_modules')).sort();
  report.sourceHashes=Object.fromEntries(await Promise.all(sourceFiles.map(async path=>[path,hash(await readFile(resolve(candidate,path)))])));
  report.executedBundles={worker:hash(await readFile(temp+'/worker.mjs')),client:hash(await readFile(temp+'/client.mjs'))};
  await writeFile(temp+'/child.mjs',`
import {privateAgentClient} from './client.mjs';
const config=JSON.parse(process.argv[2]),fetchActual=globalThis.fetch,trace=[];
let dropped=false;
globalThis.fetch=async(url,options)=>{
  const target=new URL(url);if(target.origin!==config.origin||!['127.0.0.1','localhost'].includes(target.hostname))throw new Error('external_request_forbidden');
  const reflects=config.loss==='reflect'&&target.pathname==='/api/agent/operations'&&options.method==='POST';
  const response=await fetchActual(url,reflects?{...options,headers:{...options.headers,'X-Fixture-Reflect':'true'}}:options);
  trace.push({method:options?.method??'GET',path:target.pathname+target.search,status:response.status});
  const shouldDrop=config.loss==='prepare'&&target.pathname==='/api/agent/operations'&&options.method==='POST'
    ||config.loss==='execute'&&target.pathname.endsWith('/execute');
  if(shouldDrop&&!dropped){dropped=true;await response.arrayBuffer();throw new Error('synthetic_acknowledgment_lost');}
  if(config.loss==='hash'&&target.pathname==='/api/agent/operations'&&options.method==='POST'){
    const value=await response.json();value.requestHash='0'.repeat(64);
    return new Response(JSON.stringify(value),{status:response.status,headers:response.headers});
  }
  return response;
};
let result,error;
try {
  const principalId=config.principalId??'A',credentialId=principalId+'-key';
  const client=await privateAgentClient({origin:config.origin,principalId,credentialId,environment:'synthetic-local',
    loadCredential:async()=>({version:1,origin:config.origin,principalId,credentialId,environment:'synthetic-local',token:'a'.repeat(43)})});
  if(config.action==='getAfterSignal'){
    console.log('__READY__');await new Promise(resolve=>process.stdin.once('data',resolve));
    result=await client.operations.get(config.operationId);
  }
  if(config.action==='mutate')result=await client.api('/api/projects/P/issues','POST',config.input);
  if(config.action==='discover'){
    const page=await client.operations.list({limit:50});
    result={page,full:await Promise.all(page.operations.map(operation=>client.operations.get(operation.operationId)))};
  }
  if(config.action==='execute')result=await client.operations.execute(config.operationId);
  if(config.action==='prepare')result=await client.operations.prepare(config.preparation);
  if(config.action==='reject'){
    result=[];
    for(const [path,method,body]of config.requests){try{await client.api(path,method,body);result.push({accepted:true});}catch(e){result.push({accepted:false,code:e.code??e.message});}}
  }
}catch(e){error={name:e.name,message:e.message,code:e.code,status:e.status};}
console.log(JSON.stringify({result,error,trace,dropped}));
`);
  const modules=[{type:'ESModule',path:temp+'/worker.mjs',contents:await readFile(temp+'/worker.mjs','utf8')}];
  for(const name of ['argon2.wasm','blake2b.wasm'])modules.push({type:'CompiledWasm',path:temp+'/'+name,contents:await readFile(candidate+'src/adapters/crypto/generated/'+name)});
  const fixture=await prepareLocalD1(temp);
  async function start() {
    mf=new Miniflare(convertV4MiniflareOptions({name:'agent-operation-recovery',modules,modulesRoot:temp,compatibilityDate:'2026-10-09',compatibilityFlags:['nodejs_compat'],...fixture,
      bindings:{AUTH_ORIGIN:canonicalOrigin},host:'127.0.0.1',port:0,cf:false,logRequests:false,
      outboundService:()=>{report.externalRequests++;throw new Error('Outbound forbidden');}}));
    origin=(await mf.ready).origin;db=await mf.getD1Database('DB');report.workerdStarts++;await verifyCanonicalLedger(db);
  }
  await start();
  for(const principal of ['A','B']) {
    await sql("INSERT INTO principals VALUES(?,'agent',?,NULL,1,1)",principal,'Synthetic '+principal);
    for(const permission of ['view','edit','assign','transition','execute'])await sql('INSERT INTO memberships VALUES(?,?,?)',principal,'P',permission);
  }
  for(const [key,token]of Object.entries(tokens)) {
    await sql('INSERT INTO api_credentials VALUES(?,?,?,unixepoch()+3600,NULL)',key+'-key',key[0],hash(token));
    for(const permission of ['view','edit','assign','transition','execute'])await sql('INSERT INTO api_grants VALUES(?,?,?)',key+'-key','P',permission);
  }
  await check('primary client acknowledges preparation before dispatching same-ID execution',async()=>{
    const value=await child('mutate',{input:input('normal')});assert.equal(value.error,undefined);
    assert.equal(value.result.operationId,'normal');assert.equal(value.result.snapshot.body,input('normal').body);
    const writes=value.trace.filter(entry=>entry.method!=='GET');
    assert.deepEqual(writes.map(entry=>entry.path),['/api/agent/operations','/api/agent/operations/normal/execute']);
    assert.equal(value.trace.filter(entry=>entry.path==='/api/auth/me').length,1,'only initialization probes identity');
    const events=(await request('/__fixture/events')).body.filter(event=>event.operationId==='normal');
    assert.deepEqual(events[0].stored,{intents:1,receipts:0,history:0});
    assert.equal(events[0].status,200);assert.deepEqual(await counts('normal'),committed);
    return {wireWrites:writes,prepareAcknowledgmentState:events[0].stored};
  });
  await check('uncertain preparation stops execution and survives exited client process',async()=>{
    const value=await child('mutate',{input:input('prepare_lost'),loss:'prepare'});
    assert(value.error);assert(value.dropped);assert(!value.trace.some(entry=>entry.path.endsWith('/execute')));
    assert.deepEqual(await counts('prepare_lost'),prepared);
    return {stored:await counts('prepare_lost'),executeRequests:0};
  });
  await check('mismatched acknowledgment from actual prepared response cannot authorize execution',async()=>{
    const value=await child('mutate',{input:input('hash_mismatch'),loss:'hash'});
    assert.equal(value.error.message,'operation_response_mismatch');assert(!value.trace.some(entry=>entry.path.endsWith('/execute')));
    assert.deepEqual(await counts('hash_mismatch'),prepared);
    return {stored:await counts('hash_mismatch'),executeRequests:0};
  });
  await check('plain primary client rejects reflected synthetic credential before exposing response or executing',async()=>{
    const value=await child('mutate',{input:input('reflection'),loss:'reflect'});
    assert.equal(value.error.code,'credential_reflection_rejected');assert.equal(value.result,undefined);
    assert(!value.trace.some(entry=>entry.path.endsWith('/execute')));assert(!JSON.stringify(value).includes(tokens.A));
    assert.deepEqual(await counts('reflection'),prepared);
    return {error:value.error.code,executeRequests:0,credentialInEvidence:false};
  });
  await mf.dispose();mf=null;await start();
  await check('new client and workerd discover bounded summaries and recover exact persisted input',async()=>{
    const value=await child('discover');assert.equal(value.error,undefined);
    assert.equal(value.trace.filter(entry=>entry.path==='/api/auth/me').length,1,'list and get rely on current server guards');
    const summary=value.result.page.operations.find(operation=>operation.operationId==='prepare_lost');assert(summary);
    assert(!('input' in summary));assert(!('route' in summary));assert.deepEqual(summary.result,{status:'unknown'});
    const full=value.result.full.find(operation=>operation.operationId==='prepare_lost');
    assert.deepEqual(full.input,input('prepare_lost'));assert.deepEqual(full.route,preparation('prepare_lost').route);
    assert.equal(full.recorded,true);assert.deepEqual(await counts('prepare_lost'),prepared);
    return {workerdStarts:report.workerdStarts,clientProcessStarts:report.clientProcessStarts,operationId:full.operationId};
  });
  await check('execute acknowledgment loss commits one business row and one history event',async()=>{
    const value=await child('execute',{operationId:'prepare_lost',loss:'execute'});
    assert(value.error);assert(value.dropped);assert.deepEqual(await counts('prepare_lost'),committed);
  });
  await mf.dispose();mf=null;await start();
  await check('same-ID receipt-first recovery after another process restart performs no business batch',async()=>{
    const recovered=await child('execute',{operationId:'prepare_lost'});assert.equal(recovered.error,undefined);
    assert.equal(recovered.trace.filter(entry=>entry.path==='/api/auth/me').length,1,'execute does not add identity polling');
    assert.equal(recovered.result.source,'recovered');assert.equal(recovered.result.snapshot.body,input('prepare_lost').body);
    const event=(await request('/__fixture/events')).body.find(entry=>entry.path.endsWith('/prepare_lost/execute'));
    assert.equal(event.batches,0);assert.deepEqual(await counts('prepare_lost'),committed);
    return {source:recovered.result.source,batches:event.batches,stored:await counts('prepare_lost')};
  });
  await check('REST and direct shared-service adapters recover and execute the same durable operation',async()=>{
    let result=await request('/__fixture/shared/prepare',{method:'POST',body:preparation('shared_first')});assert.equal(result.status,200);
    result=await request('/api/agent/operations/shared_first');assert.deepEqual(result.body.input,input('shared_first'));
    result=await child('execute',{operationId:'shared_first'});assert.equal(result.error,undefined);
    result=await request('/__fixture/shared/execute',{method:'POST',body:{operationId:'shared_first'}});assert.equal(result.body.source,'recovered');
    result=await child('prepare',{preparation:preparation('rest_first')});assert.equal(result.error,undefined);
    result=await request('/__fixture/shared/get',{method:'POST',body:{operationId:'rest_first'}});assert.deepEqual(result.body.input,input('rest_first'));
    assert.equal((await request('/__fixture/shared/execute',{method:'POST',body:{operationId:'rest_first'}})).status,200);
    result=await child('execute',{operationId:'rest_first'});assert.equal(result.result.source,'recovered');
    assert.deepEqual(await counts('shared_first'),committed);assert.deepEqual(await counts('rest_first'),committed);
  });
  await check('summary pagination is bounded and omits private inputs and receipt snapshots',async()=>{
    const operations=[];let after=0;
    do {
      const page=await request('/api/agent/operations?after='+after+'&limit=1');assert.equal(page.status,200);
      assert.equal(page.headers.get('Cache-Control'),'no-store');assert(page.body.operations.length<=1);
      for(const operation of page.body.operations){assert(!('input' in operation));assert(!('snapshot' in operation.result));operations.push(operation.operationId);}
      after=page.body.nextAfter;
    }while(after!==null);
    assert.equal(new Set(operations).size,operations.length);
    assert.equal(operations.length,(await first("SELECT count(*) n FROM operation_intents WHERE principal_id='A'")).n);
    return {returned:operations.length,pageLimit:1};
  });
  await check('wrong principal, reduced scope and revoked credential cannot disclose or execute saved input',async()=>{
    let result=await request('/api/agent/operations/prepare_lost',{who:'B'});assert.equal(result.status,404);assert(!JSON.stringify(result.body).includes(input('prepare_lost').body));
    assert.deepEqual((await request('/api/agent/operations',{who:'B'})).body.operations,[]);
    await sql("DELETE FROM api_grants WHERE credential_id='A-key' AND permission='edit'");
    assert.equal((await request('/api/agent/operations/prepare_lost')).status,403);
    assert.equal((await request('/api/agent/operations/prepare_lost/execute',{method:'POST',body:{}})).status,403);
    assert.deepEqual((await request('/api/agent/operations')).body.operations,[]);
    assert.equal((await request('/api/agent/operations/prepare_lost',{who:'A2'})).status,200);
    await sql("INSERT INTO api_grants VALUES('A-key','P','edit')");await sql("UPDATE api_credentials SET revoked_at=unixepoch() WHERE id='A-key'");
    assert.equal((await request('/api/agent/operations')).status,401);
    assert.equal((await request('/api/agent/operations/prepare_lost',{who:'A2'})).status,200);
    await sql("UPDATE api_credentials SET revoked_at=NULL WHERE id='A-key'");
    const denied=await request('/api/agent/operations',{method:'POST',body:{route:{kind:'issue',projectId:'OUTSIDE'},input:input('outside')}});assert.equal(denied.status,403);
    assert.deepEqual(await counts('prepare_lost'),committed);
  });
  await check('fixed client identity and current request guards survive credential or scope loss without identity polling',async()=>{
    const wrong=await child('discover',{principalId:'B'});assert.equal(wrong.error.message,'credential_subject_mismatch');assert.equal(wrong.trace.length,1);
    const revoked=await initializedChild({operationId:'prepare_lost'},()=>sql("UPDATE api_credentials SET revoked_at=unixepoch() WHERE id='A-key'"));
    assert.equal(revoked.error.status,401);assert.deepEqual(revoked.trace.map(entry=>entry.path),['/api/auth/me','/api/agent/operations/prepare_lost']);
    await sql("UPDATE api_credentials SET revoked_at=NULL WHERE id='A-key'");
    const reduced=await initializedChild({operationId:'prepare_lost'},()=>sql("DELETE FROM api_grants WHERE credential_id='A-key' AND permission='edit'"));
    assert.equal(reduced.error.status,403);assert.deepEqual(reduced.trace.map(entry=>entry.path),['/api/auth/me','/api/agent/operations/prepare_lost']);
    await sql("INSERT INTO api_grants VALUES('A-key','P','edit')");
    assert.deepEqual(await counts('prepare_lost'),committed);
    return {revokedStatus:revoked.error.status,reducedScopeStatus:reduced.error.status,identityRequestsPerClient:1};
  });
  await check('operation REST paths methods query and JSON envelopes are strict',async()=>{
    const before=(await first('SELECT count(*) n FROM operation_intents')).n;
    const invalid=[
      ['/api/agent/operations','DELETE'],['/api/agent/operations/normal','POST',{}],['/api/agent/operations/normal/execute','GET'],
      ['/api/agent/operations/normal/execute','POST',{operationId:'other'}],['/api/agent/operations/normal/extra','GET'],
      ['/api/agent/operations/normal/execute','POST',{input:{body:'changed'}}],
      ['/api/agent/operations/%6eormal','GET'],['/api/agent/operations/normal%2fexecute','POST',{}],['/api/agent/operations/normal/execute/','POST',{}],
      ['/api/agent/operations/normal?limit=1','GET'],['/api/agent/operations/normal/execute?after=0','POST',{}],
      ['/api/agent/operations?after=01','GET'],['/api/agent/operations?after=-1','GET'],['/api/agent/operations?limit=51','GET'],
      ['/api/agent/operations?limit=1&limit=2','GET'],['/api/agent/operations?after=9007199254740992','GET'],['/api/agent/operations?unused=1','GET'],
      ['/api/agent/operations?limit=1','POST',preparation('strict')],['/api/agent/operations','POST',{...preparation('strict'),principalId:'B'}],
      ['/api/agent/operations','POST',{route:{kind:'management',projectId:'P'},input:input('strict')}],
      ['/api/agent/operations','POST',{...preparation('strict'),input:{...input('strict'),token:'forbidden'}}],
    ];
    for(const [path,method,body]of invalid){const result=await request(path,{method,body});assert([400,404,405].includes(result.status),path+' '+method+': '+result.status);}
    assert.equal((await request('/api/agent/operations',{method:'POST',rawBody:'{'})).status,400);
    assert.equal((await request('/api/agent/operations',{method:'POST',body:preparation('strict'),headers:{'Content-Type':'text/plain'}})).status,415);
    assert.equal((await request('/api/agent/operations',{method:'POST',rawBody:' '.repeat(100000)})).status,413);
    assert.equal((await first('SELECT count(*) n FROM operation_intents')).n,before);
    const client=await child('reject',{requests:invalid});assert.equal(client.error,undefined);assert(client.result.every(result=>!result.accepted));
    return {rawRejections:invalid.length+3,clientRejections:client.result.length};
  });
  await check('actual Agent browser session requires Origin and CSRF for prepare and execute',async()=>{
    const jar={};
    async function browser(path,{body,csrf,originHeader=canonicalOrigin}={}) {
      const result=await request(path,{who:null,method:body===undefined?'GET':'POST',body,headers:{Cookie:Object.entries(jar).map(([key,value])=>key+'='+value).join('; '),Origin:originHeader,...(csrf?{'X-CSRF-Token':csrf}:{})}});
      for(const line of result.headers.getSetCookie()){const pair=line.split(';')[0],index=pair.indexOf('=');jar[pair.slice(0,index)]=pair.slice(index+1);}
      return result;
    }
    const context=await browser('/api/auth/context');assert.equal(context.status,200);
    const nonce='n'.repeat(43);assert.equal((await browser('/api/auth/browser-session/context',{body:{nonce},csrf:context.body.csrfToken})).status,200);
    const ticket=await request('/api/auth/browser-session/tickets',{method:'POST',body:{nonce}});assert.equal(ticket.status,200);
    assert.equal((await browser('/api/auth/browser-session/redeem',{body:{nonce,ticket:ticket.body.ticket},csrf:context.body.csrfToken})).status,200);
    const me=await browser('/api/auth/me');assert.equal(me.body.principal.id,'A');assert.equal(me.body.authentication,'session');
    assert.equal((await browser('/api/agent/operations')).status,200);
    for(const options of [{},{csrf:'x'.repeat(43)},{csrf:me.body.csrfToken,originHeader:'https://wrong.invalid'}])
      assert.equal((await browser('/api/agent/operations',{body:preparation('browser_saved'),...options})).status,403);
    assert.equal((await browser('/api/agent/operations',{body:preparation('browser_saved'),csrf:me.body.csrfToken})).status,200);
    assert.deepEqual(await counts('browser_saved'),prepared);
    assert.equal((await browser('/api/agent/operations/browser_saved/execute',{body:{}})).status,403);
    assert.equal((await browser('/api/agent/operations/browser_saved/execute',{body:{},csrf:me.body.csrfToken,originHeader:'https://wrong.invalid'})).status,403);
    assert.equal((await browser('/api/agent/operations/browser_saved/execute',{body:{},csrf:me.body.csrfToken})).status,200);
    assert.deepEqual(await counts('browser_saved'),committed);
    return {actualTicketRedemption:true,browserProtocolOnly:true};
  });
  await check('published OpenAPI validates actual requests and responses of every operation endpoint',async()=>{
    const successful=[...new Set(validatedResponses.filter(response=>response.status===200).map(response=>response.method+' '+response.path))];
    assert.deepEqual(successful.sort(),[...schemas.keys()].sort());
    return {successfulOperations:successful,validatedResponses:validatedResponses.length};
  });
  assert.equal(report.externalRequests,0);
  assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
  assert.equal((await first('SELECT count(*) n FROM mutation_guards')).n,0);
  assert(Object.values(tokens).every(token=>!JSON.stringify(report).includes(token)),'synthetic credentials must not appear in evidence');
  report.passed=true;
}catch(error){report.failure={name:error.name,message:error.message,stack:error.stack};throw error;}
finally {
  report.changedSourcesDuringRun=[];
  for(const path of sourceFiles)
    try{if(hash(await readFile(resolve(candidate,path)))!==report.sourceHashes[path])report.changedSourcesDuringRun.push(path);}catch{report.changedSourcesDuringRun.push(path);}
  if(report.changedSourcesDuringRun.length)report.passed=false;
  report.finishedAt=new Date().toISOString();await writeFile(output,JSON.stringify(report,null,2)+'\n');
  if(mf)await mf.dispose();await rm(temp,{recursive:true,force:true});
}
assert(report.passed,'source changed during integration; rerun against the final source');
console.log(JSON.stringify({passed:report.passed,scenarios:report.scenarios.length,workerdStarts:report.workerdStarts,clientProcessStarts:report.clientProcessStarts,output},null,2));
