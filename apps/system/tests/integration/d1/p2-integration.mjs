// @module verification
// @role p2-integration
// Owned loopback workerd + unique local D1 store. No remote bindings/accounts, old code or real credentials.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
const runFile = promisify(execFile), config = 'tests/support/p2-fixture/wrangler.jsonc';
const state = `.local/p2-fixture-${randomUUID()}`, origin = 'http://127.0.0.1:8792';
await mkdir(state,{recursive:true});await mkdir('.local/evidence',{recursive:true});
const env = {PATH:process.env.PATH,HOME:resolve(state),XDG_CONFIG_HOME:resolve(state),CI:'true',WRANGLER_SEND_METRICS:'false', CLOUDFLARE_CF_FETCH_ENABLED:'false', WRANGLER_HIDE_BANNER:'true', WRANGLER_SEND_ERROR_REPORTS:'false',WRANGLER_LOG_PATH:resolve(state,'wrangler.raw.log')};
const cli = 'node_modules/wrangler/bin/wrangler.js';
const hashes = {};
for (const f of ['src/adapters/d1/persistence/commit.ts','src/adapters/d1/identity/assembly.ts','src/adapters/d1/identity/authorization.ts','src/modules/identity/public.ts','src/apps/http/credentials.ts','tests/support/identity-fixture.ts','src/adapters/d1/identity/db.ts','migrations/0001_auth.sql','migrations/0002_mutations.sql',
  'tests/support/p2-fixture/worker.ts',config,'tests/integration/d1/p2-integration.mjs','package-lock.json'])
  hashes[f] = createHash('sha256').update(await readFile(f)).digest('hex');
const report = {phase:'P2-01',startedAt:new Date().toISOString(),node:process.version,
  runtime:'Wrangler 4.149.0 / workerd 1.20261006.1 / real local D1 binding',config,persistence:state,hashes,
  isolation:'Unique local persistence; test-only loopback entrypoint; credentials generated in memory and omitted from evidence',results:[],failures:[]};
const pattern=process.argv[2]??null;let filter=null;
const evidencePath='.local/evidence/'+(pattern!==null?'p2-01-filtered':'p2-integration')+'.json';
report.filter=pattern;report.selection={pattern,mode:pattern!==null?'filtered':'full',skipped:[]};report.passed=false;report.fullSuitePassed=false;
const save = () => writeFile(evidencePath,JSON.stringify(report,null,2)+'\n');
await save(); // Invalidate stale success before setup or regex compilation.
const delay = ms => new Promise(r=>setTimeout(r,ms));
let child;
const logs=[];
async function call(path,{method='GET',body,headers={}}={}) {
  const r=await fetch(origin+path,{signal:AbortSignal.timeout(15000),method,headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},
    ...(body!==undefined?{body:JSON.stringify(body)}:{})});
  return {status:r.status,body:await r.json()};
}
async function reset() {
  const r=await call('/fixture/reset',{method:'POST'});assert.equal(r.status,200);
  return {api:{Authorization:`Bearer ${r.body.api}`},session:{Cookie:`__Host-projektor_session=${r.body.session}`},
    derived:{Cookie:`__Host-projektor_session=${r.body.derived}`}};
}
const command = (id,extra={}) => ({operationId:id,revision:1,state:'done',relatedId:'link',value:'after',...extra});
const mutate = (headers,body) => call('/fixture/mutate',{method:'POST',headers,body});
const read = (headers,id) => call(`/fixture/result?id=${encodeURIComponent(id)}`,{headers});
async function dbState() {const r=await call('/fixture/state');assert.equal(r.status,200);return r.body;}
function nonDisclosure(r,status) {assert.equal(r.status,status);assert.equal(r.body.snapshot,undefined);assert.equal(r.body.current,undefined);}
async function test(name,fn) {
  if(filter&&!filter.test(name)){report.selection.skipped.push(name);return;}
  const start=performance.now();
  try { const details=await fn();report.results.push({name,passed:true,wallMs:Math.round(performance.now()-start),...details});console.log(`PASS ${name}`); }
  catch (e) {report.failures.push({name,error:e.message});await save();throw e;}
  await save();
}
try {
  filter=pattern!==null?new RegExp(pattern):null;
  const migrationFiles=(await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort();
  for(const file of migrationFiles)hashes['migrations/'+file]=createHash('sha256').update(await readFile('migrations/'+file)).digest('hex');
  // Fresh store: unchanged canonical migrations through official Wrangler.
  const migration=await runFile(process.execPath,['--require',process.cwd()+'/tests/support/local-network-guard.cjs',cli,'d1','migrations','apply','projektor-p2-isolated-fixture','--local',
    '--config',config,'--persist-to',state],{env,maxBuffer:4*1024*1024,timeout:90000});
  await writeFile(`${state}/migrations.raw.log`,migration.stdout+ migration.stderr);
  report.migrationsApplied=migrationFiles;
  child=spawn(process.execPath,['--require',process.cwd()+'/tests/support/local-network-guard.cjs',cli,'dev','--config',config,'--local','--persist-to',state,
    '--ip','127.0.0.1','--port','8792','--inspector-port','9234','--local-protocol','http','--upstream-protocol','http'],
    {env,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',d=>logs.push(d.toString()));child.stderr.on('data',d=>logs.push(d.toString()));
  for(let i=0;i<450;i++){if(logs.join('').includes('Ready on'))break;if(child.exitCode!==null)throw new Error('Owned fixture runtime exited before ready');await delay(100);}
  assert.ok(logs.join('').includes(`Ready on ${origin}`),'Owned loopback runtime did not become ready on its requested port');
  const ledger=await call('/fixture/ledger');assert.equal(ledger.status,200);assert.deepEqual(ledger.body.names,migrationFiles);report.migrationLedger=ledger.body.names;
  await test('Normalized JSON boundary in workerd',async()=>{
    const r=await call('/fixture/canonical');assert.equal(r.status,200);assert.equal(r.body.equal,true);
    assert.deepEqual(r.body.outcomes,Array(5).fill('invalid_normalized_input'));
    return {invalidCases:['NaN','infinity','cycle','array hole','UTF-8 size bound']};
  });
  await test('Commit and same-input replay retain the first confirmed snapshot',async()=>{
    const {api}=await reset(),first=await mutate(api,command('replay'));
    assert.equal(first.status,200);assert.equal(first.body.source,'committed');assert.equal(first.body.snapshot.revision,2);
    const before=await dbState();
    const reordered={value:'after',relatedId:'link',state:'done',revision:1,operationId:'replay'};
    const again=await mutate(api,reordered),lookup=await read(api,'replay');
    assert.equal(again.status,200);assert.equal(again.body.source,'recovered');assert.deepEqual(again.body.snapshot,first.body.snapshot);
    assert.deepEqual(lookup.body.snapshot,first.body.snapshot);assert.deepEqual(await dbState(),before);
    assert.equal(before.operation_results.length,1);assert.equal(before.fixture_history.length,1);assert.equal(before.mutation_guards.length,0);
  });
  await test('Same ID with changed input/kind/target/project returns 409 without snapshot',async()=>{
    const {api}=await reset();assert.equal((await mutate(api,command('mismatch'))).status,200);const before=await dbState();
    for(const change of [{value:'different'},{kind:'fixture.other'},{targetId:'private-target'},{projectId:'Q'}]) {
      const r=await mutate(api,command('mismatch',change));nonDisclosure(r,409);assert.equal(r.body.error,'operation_input_mismatch');
    }
    assert.deepEqual(await dbState(),before);return {checked:['input','kind','target','project']};
  });
  await test('Concurrent identical operation IDs commit one result/history/update',async()=>{
    const {api}=await reset();const responses=await Promise.all(Array.from({length:6},()=>mutate(api,command('same-race'))));
    assert.ok(responses.every(r=>r.status===200));assert.equal(responses.filter(r=>r.body.source==='committed').length,1);
    for(const r of responses)assert.deepEqual(r.body.snapshot,responses[0].body.snapshot);
    const s=await dbState();assert.equal(s.fixture_history.length,1);assert.equal(s.operation_results.length,1);assert.equal(s.mutation_guards.length,0);
    assert.equal(s.fixture_targets.find(t=>t.id==='target').revision,2);
    return {requested:6,committed:1,uniqueFailureRecoveries:5};
  });
  await test('Different IDs racing at the same revision yield one commit and one visible conflict',async()=>{
    const {api}=await reset();const r=await Promise.all([mutate(api,command('revision-a')),mutate(api,command('revision-b'))]);
    assert.deepEqual(r.map(x=>x.status).sort(),[200,409]);const conflict=r.find(x=>x.status===409);
    assert.equal(conflict.body.reason,'revision_conflict');assert.equal(conflict.body.current.revision,2);
    const s=await dbState();assert.equal(s.operation_results.length,1);assert.equal(s.fixture_history.length,1);assert.equal(s.mutation_guards.length,0);
  });
  await test('Operation ID uniqueness is scoped to the authenticated principal',async()=>{
    const {api,session}=await reset();assert.equal((await mutate(api,command('principal-id'))).status,200);
    assert.equal((await mutate(session,command('principal-id',{targetId:'target-2'}))).status,200);
    const s=await dbState();assert.equal(s.operation_results.length,2);assert.equal(s.fixture_history.length,2);
    assert.deepEqual(new Set(s.operation_results.map(r=>r.principal_id)),new Set(['fixture-agent','fixture-human']));
  });
  await test('API credential/principal/scope/membership changes after authentication abort the batch',async()=>{
    const cases=[['credential',401],['expiry',401],['principal',401],['version',401],['membership',403],['scope',403],['view',403]];
    for(const [revoke,status] of cases) {
      const {api}=await reset(),before=await dbState(),r=await mutate(api,command(`api-${revoke}`,{revoke}));
      nonDisclosure(r,status);assert.deepEqual(await dbState(),before);
    }
    return {cases:cases.map(([revoke,status])=>({revoke,status,fullMutationRollback:true}))};
  });
  await test('Human and API-derived session validity is rechecked in the batch',async()=>{
    const cases=[['session','session',401],['session','idle',401],['session','absolute',401],['session','version',401],
      ['session','membership',403],['derived','credential',401],['derived','expiry',401],['derived','scope',403]];
    for(const [credential,revoke,status] of cases) {
      const auth=await reset(),before=await dbState(),r=await mutate(auth[credential],command(`session-${revoke}`,{revoke}));
      nonDisclosure(r,status);assert.deepEqual(await dbState(),before);
    }
    return {cases:cases.map(([credential,revoke,status])=>({credential,revoke,status,fullMutationRollback:true}))};
  });
  await test('Project visibility failures do not disclose private/missing target existence',async()=>{
    const {api}=await reset(),before=await dbState();
    const rs=[];
    for(const extra of [{projectId:'Q'},{targetId:'private-target'},{targetId:'absent'}]) {
      const r=await mutate(api,command('visibility',extra));nonDisclosure(r,403);rs.push(r.body);
    }
    assert.deepEqual(rs[0],rs[1]);assert.deepEqual(rs[1],rs[2]);assert.deepEqual(await dbState(),before);
  });
  await test('Revision, transition and related-project preconditions fail with authorized current state',async()=>{
    const cases=[[{revision:0},'revision_conflict'],[{state:'open'},'transition_conflict'],
      [{relatedId:'absent'},'related_invalid'],[{relatedId:'private-link'},'related_invalid']];
    for(const [extra,reason] of cases) {
      const {api}=await reset(),before=await dbState(),r=await mutate(api,command('precondition',extra));
      assert.equal(r.status,409);assert.equal(r.body.reason,reason);assert.equal(r.body.current.revision,1);
      assert.deepEqual(await dbState(),before);
    }
    return {cases:cases.map(([,reason])=>reason)};
  });
  await test('Failures after reservation/update/history/result and final cleanup roll back every mutation row',async()=>{
    const cases=[['guard',409],['after-update',500],['after-history',500],['result',500],['after-result',500],['zero-update',500]];
    for(const [fault,status] of cases) {
      const {api}=await reset(),before=await dbState(),r=await mutate(api,command(`rollback-${fault}`,{fault}));
      assert.equal(r.status,status);assert.equal(r.body.snapshot,undefined);assert.deepEqual(await dbState(),before);
    }
    return {cases:cases.map(([fault,status])=>({fault,status,reservationTargetHistoryResultGuardsUnchanged:true}))};
  });
  await test('Lost response is recovered by result inquiry and same-ID replay without another write',async()=>{
    const {api}=await reset();const lost=await mutate(api,command('lost',{fault:'response-loss'}));
    assert.equal(lost.status,503);const before=await dbState();assert.equal(before.operation_results.length,1);
    const inquiry=await read(api,'lost'),replay=await mutate(api,command('lost'));
    assert.equal(inquiry.status,200);assert.equal(replay.status,200);assert.equal(replay.body.source,'recovered');
    assert.deepEqual(inquiry.body.snapshot,replay.body.snapshot);assert.deepEqual(await dbState(),before);
    return {loss:'Synthetic response-boundary 503 after real committed batch; no network/DB acknowledgement fault injected'};
  });
  await test('Revoked current authorization blocks result inquiry and replay bodies',async()=>{
    const cases=[['credential',401],['membership',403],['scope',403],['view',403],['move',403]];
    for(const [action,status] of cases) {
      const {api}=await reset();assert.equal((await mutate(api,command('protected'))).status,200);
      assert.equal((await call('/fixture/control',{method:'POST',headers:api,body:{action}})).status,200);
      const before=await dbState();nonDisclosure(await read(api,'protected'),status);
      nonDisclosure(await mutate(api,command('protected')),status);assert.deepEqual(await dbState(),before);
    }
    return {cases:cases.map(([action,status])=>({action,status,bodyHidden:true}))};
  });
  await test('Result inquiry is private to principal and missing IDs are explicit',async()=>{
    const {api,session}=await reset();assert.equal((await mutate(api,command('private-result'))).status,200);
    nonDisclosure(await read(session,'private-result'),404);nonDisclosure(await read(api,'absent-result'),404);
    nonDisclosure(await read(api,'bad.id'),400);
  });
  await test('Stored snapshot remains immutable when the target later changes',async()=>{
    const {api}=await reset(),first=await mutate(api,command('snapshot'));assert.equal(first.status,200);
    assert.equal((await call('/fixture/control',{method:'POST',headers:api,body:{action:'reopen'}})).status,200);
    const later=await mutate(api,command('later',{revision:2,value:'later value'}));assert.equal(later.status,200);
    assert.equal(later.body.snapshot.revision,3);const before=await dbState();
    assert.deepEqual((await read(api,'snapshot')).body.snapshot,first.body.snapshot);
    assert.deepEqual((await mutate(api,command('snapshot'))).body.snapshot,first.body.snapshot);
    assert.equal((await call('/fixture/control',{method:'POST',headers:api,body:{action:'tamper'}})).status,500);
    assert.deepEqual(await dbState(),before);
  });
  await test('Stale authenticated context cannot recover a result after credential or permission cancellation',async()=>{
    for(const [revoke,status] of [['credential',401],['membership',403],['scope',403]]) {
      let {api}=await reset();assert.equal((await mutate(api,command('stale'))).status,200);let before=await dbState();
      nonDisclosure(await mutate(api,command('stale',{revoke})),status);assert.deepEqual(await dbState(),before);
      ({api}=await reset());assert.equal((await mutate(api,command('stale'))).status,200);before=await dbState();
      nonDisclosure(await call(`/fixture/result?id=stale&revoke=${revoke}`,{headers:api}),status);assert.deepEqual(await dbState(),before);
    }
    return {timing:'Real P1a authentication, then controlled revocation before common result inquiry/replay'};
  });
  await test('Unregistered operation kind is rejected before any reservation or mutation',async()=>{
    const {api}=await reset(),before=await dbState(),r=await mutate(api,command('unknown',{kind:'unregistered'}));
    assert.equal(r.status,500);assert.equal(r.body.error,'unregistered_mutation_kind');assert.deepEqual(await dbState(),before);
  });
  await test('Real D1 schema exceptions return sanitized 503 and preserve confirmed recovery',async()=>{
    const {api}=await reset();assert.equal((await mutate(api,command('unavailable'))).status,200);const before=await dbState();
    const control=action=>call('/fixture/control',{method:'POST',headers:api,body:{action}});
    assert.equal((await control('disable-store')).status,200);
    try {
      for(const r of [await read(api,'unavailable'),await mutate(api,command('unavailable'))]) {
        nonDisclosure(r,503);assert.deepEqual(r.body,{error:'mutation_unavailable'});
      }
    } finally {assert.equal((await control('restore-store')).status,200);}
    assert.equal((await read(api,'unavailable')).status,200);
    assert.equal((await mutate(api,command('unavailable'))).status,200);assert.deepEqual(await dbState(),before);
    return {fault:'Actual local D1 table rename, not a mocked binding; network outage not injected'};
  });
  await test('Declared command policy governs bytes without domain kind switches',async()=>{
    let {api}=await reset();let before=await dbState();
    const large=command('explicit-size',{kind:'fixture.other',value:'x'.repeat(17000)});
    assert.equal((await mutate(api,large)).status,400);assert.deepEqual(await dbState(),before);
    const result=await mutate(api,{...large,maxBytes:20480});assert.equal(result.status,200);assert.equal(result.body.snapshot.value.length,17000);
    ({api}=await reset());before=await dbState();
    const rejected=await mutate(api,command('small-size',{maxBytes:8}));assert.equal(rejected.status,400);assert.deepEqual(await dbState(),before);
  });
  await test('Declared pre-dispatch certification works for an arbitrary registered kind',async()=>{
    const {api}=await reset(),before=await dbState();
    const r=await mutate(api,command('declared-denial',{kind:'fixture.other',projectId:'Q',targetId:'private-target',certify:true}));
    assert.equal(r.status,403);assert.deepEqual(r.body.mutationOutcome,{operationId:'declared-denial',status:'not_applied',phase:'pre_dispatch'});assert.deepEqual(await dbState(),before);
  });
  await test('Intent fence and captured rights participate in the same rollback boundary',async()=>{
    for(const extra of [{fenceValid:false},{fencePermission:'assign'}]){
      const {api}=await reset(),before=await dbState();const r=await mutate(api,command('fenced',extra));
      assert.equal(r.status,extra.fenceValid===false?409:403);if(extra.fenceValid===false)assert.equal(r.body.reason,'operation_intent_changed');
      assert.deepEqual(await dbState(),before);
    }
  });
  assert.ok(report.results.length>0,'selection matched no tests');report.completedAt=new Date().toISOString();report.fullSuitePassed=pattern===null;report.passed=true;
  console.log(`P2-01: ${report.results.length} integration groups passed; ${evidencePath} saved.`);
} catch (error) {
  report.passed=false;report.error={name:error.name,message:error.message};throw error;
} finally {
  await save();
  if(child) {
    child.kill('SIGINT');await Promise.race([new Promise(r=>child.once('exit',r)),delay(3000)]);
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
    await Promise.race([new Promise(r=>child.once('exit',r)),delay(1000)]);
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
    await writeFile(`${state}/runtime.raw.log`,logs.join(''));
  }
}
