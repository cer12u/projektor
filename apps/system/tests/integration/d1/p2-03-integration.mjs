// @module verification
// @role p2-03-integration
// Spec §3: authorized missing data/results are404; denied scope remains403, and missing never certifies nonapplication.
// Real local D1 + product entrypoint. Response loss is a host-side discard, not a network partition.
import {spawn,execFile}from'node:child_process';
import {promisify}from'node:util';
import {mkdir,readFile,writeFile}from'node:fs/promises';
import {randomUUID,createHash}from'node:crypto';
import assert from'node:assert/strict';
import Ajv from 'ajv';
import { readdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL("../../../", import.meta.url)));
const run=promisify(execFile),cli='node_modules/wrangler/bin/wrangler.js',config='tests/support/p2-03-fixture/wrangler.jsonc';
const store=join(tmpdir(),`projektor-p2-03-${randomUUID()}`);
const evidenceDir=resolve(process.env.P2_EVIDENCE_DIR??'.local/evidence');
await mkdir(evidenceDir,{recursive:true});
const evidence=join(evidenceDir,'p2-03-integration.json');
const runId=randomUUID(),logDir=join(evidenceDir,`p2-03-${runId}`);await mkdir(logDir);
// An allowlist prevents inherited cloud tokens or user configuration from entering local fixtures.
const env={PATH:process.env.PATH,HOME:store,XDG_CONFIG_HOME:store,CI:'true',NO_COLOR:'1',
  WRANGLER_SEND_METRICS:'false', CLOUDFLARE_CF_FETCH_ENABLED:'false', WRANGLER_HIDE_BANNER:'true', WRANGLER_SEND_ERROR_REPORTS:'false',WRANGLER_LOG_PATH:join(logDir,'wrangler.raw.log'),CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV:'false'};
const originalCaseNames=[
  "Current view/edit/member/scope and credential validity are rechecked after authentication/preparation at batch",
  "History/result failures and zero-row target/history writes roll back every Issue batch row",
  "Post-authentication reads and prepared replays do not expose body after credential or permission cancellation",
  "Immutable Issue identity and history preserve actor ID and commit-time display name",
  "Actual product create/get/edit/history/result use matching fixed IDs, revisions, bodies and DB timestamps",
  "Actual product authentication, explicit view/edit and global/project separation return bounded JSON refusals",
  "Actual product field validation, UTF-8/encoded limits and bounded JSON input reject without writes",
  "Actual product old revisions return current permitted Issue; absent and wrong-project targets/results stay hidden",
  "Actual product same-operation replay retains original snapshot after later edits and changed input/target/kind conflicts",
  "Actual product concurrent duplicate creates commit one Issue/history/result and competing revisions commit one edit",
  "Actual product response discarded after commit is recovered by same operation ID without another history",
  "Actual product history cursor pages preserve ordered revisions and bounded complete entries",
  "Actual product Cookie creation/edit preserve Origin/CSRF and mixed authentication rejection",
  "OpenAPI Issue contracts match actual product request/response shapes and preserve existing auth definitions",
  "Confirmed operation IDs accompany actual create/edit/replay/result with matching OpenAPI and principal namespace",
  "Confirmed operation receipt matches persisted principal/operation rows and legacy snapshot-only reader",
  "Product commits survive runtime restart with exact matching Issue/history/result counts and no guards",
  "Pending result is unavailable; actor-bound missing404 differs from denied wrong-project403",
  "Strict extra-field validation rejects prototype-name fields and unknown history queries without a write",
  "Actual product next reads/results and mutations hide committed bodies after credential or membership/scope revocation",
  "Identical human cookie survives Worker restart and then rejects revocation idle and absolute expiry"
];
const report={phase:'P2-03',plan:'v1.0/v1.1',runId,startedAt:new Date().toISOString(),node:process.version,
  runtime:'Wrangler4.149.0/workerd1.20261006.1; real local D1',persistence:store,hashes:{},results:[],failures:[],skipped:[],
  credentials:'Random synthetic credentials held only in memory; omitted from evidence',
  productEntrypoint:'src/apps/worker.ts',responseLoss:'Actual success response discarded on host; no real network/DB acknowledgement fault',
  filter:process.argv[2]??null,mode:process.argv[2]===undefined?'full':'filtered',originalCaseCount:originalCaseNames.length,
  passed:false,fullSuitePassed:false,status:'running'};
const save=()=>writeFile(evidence,JSON.stringify(report,null,2)+'\n');
// Overwrite earlier success before parsing a regex, reading inputs, or starting any runtime.
await save();
let filter,selected,required;
const pause=ms=>new Promise(r=>setTimeout(r,ms));let child,logs=[],origin;
async function stop(){if(!child)return;child.kill('SIGINT');await Promise.race([new Promise(r=>child.once('exit',r)),pause(3000)]);
  if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await writeFile(join(logDir,`runtime-${Date.now()}.raw.log`),logs.join(''));child=undefined;}
async function start(cfg,port,inspector){logs=[];child=spawn(process.execPath,['--require',process.cwd()+'/tests/support/local-network-guard.cjs',cli,'dev','--config',cfg,'--local','--persist-to',store,
  '--ip','127.0.0.1','--port',String(port),'--inspector-port',String(inspector),'--local-protocol','http','--upstream-protocol','http'],{env,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',d=>logs.push(d.toString()));child.stderr.on('data',d=>logs.push(d.toString()));
  for(let i=0;i<150;i++){if(logs.join('').includes('Ready on'))break;if(child.exitCode!==null)throw new Error('Owned runtime exited');await pause(100);}
  assert.ok(logs.join('').includes(`Ready on http://127.0.0.1:${port}`),'Owned loopback runtime not ready on its requested port');origin=`http://localhost:${port}`;
}
async function call(path,{headers={},method='GET',body,raw}={}){
  const r=await fetch(origin+path,{method,headers:{...(body!==undefined||raw!==undefined?{'Content-Type':'application/json'}:{}),...headers},
    ...(body!==undefined?{body:JSON.stringify(body)}:raw!==undefined?{body:raw}:{})});
  return {status:r.status,body:await r.json(),headers:Object.fromEntries(r.headers)};
}
const bearer=(f,l='editor')=>({Authorization:`Bearer ${f.tokens[l]}`});
const cookie=f=>({Cookie:`__Host-projektor_session=${f.session}`});
const route=(id,project='P')=>`/api/projects/${project}/issues${id?'/'+id:''}`;
const op=(id,project='P')=>`/api/projects/${project}/issue-operations/${id}`;
const fresh=async()=>{const r=await call('/fixture/new',{method:'POST'});assert.equal(r.status,200);return r.body;};
const state=async f=>(await call(`/fixture/state?case=${f.caseId}`)).body;
const control=(f,fault,issueId)=>call('/fixture/control',{method:'POST',headers:bearer(f),body:{caseId:f.caseId,fault,issueId}});
const mutate=(f,input,issueId,fault,label='editor',projectId='P')=>call('/fixture/mutate',{method:'POST',headers:bearer(f,label),body:{caseId:f.caseId,input,issueId,fault,projectId}});
const create=(f,operationId='create',body='original body',label='editor')=>call(route(),{method:'POST',headers:bearer(f,label),body:{operationId,body}});
const edit=(f,id,revision,operationId,body)=>call(route(id),{method:'PATCH',headers:bearer(f),body:{operationId,revision,body}});
const hidden=(r,status)=>{assert.equal(r.status,status);for(const k of['snapshot','current','issue','history'])assert.equal(r.body[k],undefined);};
async function test(name,fn){if(!required.has(name)){report.skipped.push({name,reason:'not selected'});return;}const started=performance.now();try{const details=await fn();report.results.push({name,role:selected.has(name)?'selected':'dependency',passed:true,wallMs:Math.round(performance.now()-started),...details});console.log('PASS '+name);}
  catch(e){report.failures.push({name,role:selected.has(name)?'selected':'dependency',error:e.message});console.error('FAIL '+name+': '+e.message);await save();}await save();}
let productCases,productSaved={};
try{
  filter=report.filter===null?null:new RegExp(report.filter);
  selected=new Set(originalCaseNames.filter(name=>!filter||filter.test(name)));
  report.selectedCaseCount=selected.size;
  assert.ok(selected.size>0,'Filter matched zero P2-03 cases');
  required=new Set(selected);
  const dependencies=new Map([
    [originalCaseNames[13],[originalCaseNames[4]]],
    [originalCaseNames[15],[originalCaseNames[14]]],
    [originalCaseNames[16],[4,8,9,10,12].map(i=>originalCaseNames[i])],
    [originalCaseNames[20],[originalCaseNames[12]]],
  ]);
  for(const name of selected)for(const dependency of dependencies.get(name)??[])required.add(dependency);
  report.dependencyCaseCount=required.size-selected.size;
  const migrations=(await readdir('migrations')).filter(name=>name.endsWith('.sql')).sort();
  const tested=['src/adapters/d1/work/issues.ts','src/apps/http/issue.ts','src/apps/worker.ts','src/adapters/d1/persistence/commit.ts','src/adapters/d1/identity/permissions.ts',
    'src/adapters/d1/identity/assembly.ts','src/adapters/d1/identity/authorization.ts','src/modules/identity/public.ts','src/apps/http/credentials.ts','tests/support/identity-fixture.ts','src/adapters/d1/identity/db.ts',...migrations.map(name=>'migrations/'+name),
    'tests/support/p2-03-fixture/worker.ts',config,'tests/support/p2-03-fixture/product.jsonc','tests/integration/d1/p2-03-integration.mjs','docs/openapi.json',
    'docs/p2-02-openapi-baseline.json','package-lock.json'];
  report.hashes=Object.fromEntries(await Promise.all(tested.map(async p=>[p,createHash('sha256').update(await readFile(p)).digest('hex')])));
  await mkdir(store);await save();
  const migration=await run(process.execPath,['--require',process.cwd()+'/tests/support/local-network-guard.cjs',cli,'d1','migrations','apply','projektor-p2-03-isolated-fixture',
    '--local','--config',config,'--persist-to',store],{env,maxBuffer:4e6});
  await writeFile(join(logDir,'migrations.log'),migration.stdout+migration.stderr);
  const ledger=await run(process.execPath,['--require',process.cwd()+'/tests/support/local-network-guard.cjs',cli,'d1','execute','projektor-p2-03-isolated-fixture','--local','--config',config,
    '--persist-to',store,'--command','SELECT name FROM d1_migrations ORDER BY id','--json'],{env,maxBuffer:4e6});
  await writeFile(join(logDir,'migration-ledger.json'),ledger.stdout);
  report.migrations={expected:migrations,applied:JSON.parse(ledger.stdout)[0].results.map(row=>row.name)};
  assert.deepEqual(report.migrations.applied,migrations,'Wrangler applied the complete canonical migration chain');
  await save();
  await start(config,8795,9237);
  await test('Current view/edit/member/scope and credential validity are rechecked after authentication/preparation at batch',async()=>{
    for(const[fault,status]of[['edit',403],['view',403],['membership',403],['scope',403],['credential',401],['expiry',401],['principal',401],['auth-version',401]]){
      for(const editing of[false,true]){
        const f=await fresh(),a=editing?await create(f):null,id=a?.body.snapshot.id,before=await state(f);
        const r=await mutate(f,{operationId:'race',body:'racing body',...(editing?{revision:1}:{})},id,fault);hidden(r,status);assert.deepEqual(await state(f),before);
      }
    }return {cases:16,stage:'Real authenticate + prepareIssue, then SQL cancellation before executeMutation'};
  });
  await test('History/result failures and zero-row target/history writes roll back every Issue batch row',async()=>{
    for(const operationId of['history-fail','result-fail','history-zero'])for(const editing of[false,true]){
      const f=await fresh(),a=editing?await create(f):null,before=await state(f);
      const r=await mutate(f,{operationId,body:'must rollback',...(editing?{revision:1}:{})},a?.body.snapshot.id);
      assert.ok([500,503].includes(r.status));assert.deepEqual(await state(f),before);hidden(await call(op(operationId),{headers:bearer(f)}),404);
    }
    const f=await fresh(),a=await create(f),before=await state(f);
    const r=await mutate(f,{operationId:'zero-update',revision:1,body:'synthetic-ignore-update'},a.body.snapshot.id);
    assert.ok([500,503].includes(r.status));assert.deepEqual(await state(f),before);return {faults:7,source:'Real SQLite ABORT/IGNORE triggers'};
  });
  await test('Post-authentication reads and prepared replays do not expose body after credential or permission cancellation',async()=>{
    for(const read of['issue','history','result'])for(const[fault,status]of[[read==='result'?'edit':'view',403],['credential',401]]){
      const f=await fresh(),a=await create(f),before=await state(f);
      const r=await call('/fixture/after-auth-read',{method:'POST',headers:bearer(f),body:{caseId:f.caseId,issueId:a.body.snapshot.id,read,input:'create',fault}});
      hidden(r,status);assert.deepEqual(await state(f),before);
    }
    for(const[fault,status]of[['edit',403],['credential',401]]){
      const f=await fresh();await create(f);const before=await state(f);hidden(await mutate(f,{operationId:'create',body:'original body'},undefined,fault),status);assert.deepEqual(await state(f),before);
    }return {readCases:6,preparedReplayCases:2};
  });
  await test('Immutable Issue identity and history preserve actor ID and commit-time display name',async()=>{
    const f=await fresh(),a=await create(f),id=a.body.snapshot.id;assert.equal((await control(f,'rename')).status,200);
    const e=await edit(f,id,1,'rename-edit','after rename');assert.equal(e.status,200);const h=await call(route(id)+'/history',{headers:bearer(f)});
    assert.equal(h.body.history[0].actorName,'editor');assert.equal(h.body.history[1].actorName,'changed editor');
    assert.ok(h.body.history.every(x=>x.actorId===f.ids.editor));const before=await state(f);
    for(const action of['tamper-history','delete-history','move','change-id','change-created']){assert.equal((await control(f,action,id)).status,503);assert.deepEqual(await state(f),before);}
  });
  productCases=await Promise.all(Array.from({length:10},()=>fresh()));
  await stop();await start('tests/support/p2-03-fixture/product.jsonc',8796,9238);
  await test('Actual product create/get/edit/history/result use matching fixed IDs, revisions, bodies and DB timestamps',async()=>{
    const f=productCases[0],body='original 日本語\n  body',a=await create(f,'product-create',body);assert.equal(a.status,200);
    const i=a.body.snapshot;assert.match(i.id,/^I_[a-f0-9]{64}$/);assert.equal(i.revision,1);assert.equal(i.body,body);assert.equal(i.createdAt,i.updatedAt);
    assert.ok(Number.isFinite(Date.parse(i.createdAt)));const g=await call(route(i.id),{headers:bearer(f)});assert.deepEqual(g.body.issue,i);
    const e=await edit(f,i.id,1,'product-edit','updated body');assert.equal(e.status,200);const j=e.body.snapshot;
    assert.equal(j.id,i.id);assert.equal(j.createdAt,i.createdAt);assert.equal(j.revision,2);assert.equal(j.body,'updated body');assert.ok(j.updatedAt>=i.updatedAt);
    const h=await call(route(i.id)+'/history',{headers:bearer(f)});assert.equal(h.status,200);assert.equal(h.body.history.length,2);assert.equal(h.body.nextAfterRevision,null);
    assert.equal(h.body.history[0].beforeBody,null);assert.equal(h.body.history[0].afterBody,body);assert.equal(h.body.history[1].beforeBody,body);
    assert.equal(h.body.history[1].afterBody,j.body);assert.equal(h.body.history[1].createdAt,j.updatedAt);
    assert.deepEqual((await call(op('product-edit'),{headers:bearer(f)})).body.snapshot,j);productSaved.main={f,id:i.id,snapshot:j};
    for(const token of Object.values(f.tokens))assert.ok(!JSON.stringify([a.body,e.body,h.body]).includes(token));
  });
  await test('Actual product authentication, explicit view/edit and global/project separation return bounded JSON refusals',async()=>{
    const f=productCases[1];hidden(await create(f,'viewer','x','viewer'),403);hidden(await create(f,'global','x','global'),403);hidden(await create(f,'no-view','x','no-view'),403);
    const a=await create(f),id=a.body.snapshot.id;const noAuth=await call(route(id));hidden(noAuth,401);assert.equal(noAuth.headers.location,undefined);
    assert.equal(noAuth.headers['cache-control'],'no-store');assert.match(noAuth.headers['content-type'],/application\/json/);
    assert.equal((await call(route(id),{headers:bearer(f,'viewer')})).status,200);hidden(await call(op('create'),{headers:bearer(f,'viewer')}),404);
    hidden(await call(route(id),{headers:bearer(f,'global')}),403);hidden(await call(op('create'),{headers:bearer(f,'other')}),404);
    const m=await call(route(id),{method:'DELETE',headers:bearer(f)});assert.equal(m.status,405);
  });
  await test('Actual product field validation, UTF-8/encoded limits and bounded JSON input reject without writes',async()=>{
    const f=productCases[2],bad=[{body:'ok'},{operationId:'a',body:' '},{operationId:'b',body:'あ'.repeat(2731)},
      {operationId:'c',body:'\u0001'.repeat(3000)},{operationId:'d',body:'ok',actor:'fake'},
      {operationId:'e',body:'ok',authority:'global-administrator'},{operationId:'f',body:'ok',revision:1},
      {operationId:'g',body:'\u0000text'},{operationId:'h',body:'\ud800'}];
    for(const body of bad){const r=await call(route(),{method:'POST',headers:bearer(f),body});hidden(r,400);assert.ok(Object.keys(r.body.fields).length);}
    const a=await create(f,'valid', 'x'.repeat(8192));assert.equal(a.status,200);const id=a.body.snapshot.id;
    for(const revision of[0,1.5,Number.MAX_SAFE_INTEGER,null]){const r=await edit(f,id,revision,'bad-revision','text');hidden(r,400);assert.ok(r.body.fields.revision);}
    const malformed=await call(route(),{method:'POST',headers:bearer(f),raw:'{'});hidden(malformed,400);assert.ok(malformed.body.fields.body);
    hidden(await call(route(),{method:'POST',headers:bearer(f),raw:' '.repeat(32769)}),413);
    hidden(await call(route(),{method:'POST',headers:{...bearer(f),'Content-Type':'text/plain'},raw:'x'}),415);
    hidden(await call(route('bad-id'),{headers:bearer(f)}),400);
    const h=await call(route(id)+'/history?limit=51',{headers:bearer(f)});hidden(h,400);assert.ok(h.body.fields.query);
    hidden(await call(route(id)+'/history?limit=2&limit=2',{headers:bearer(f)}),400);
  });
  await test('Actual product old revisions return current permitted Issue; absent and wrong-project targets/results stay hidden',async()=>{
    const f=productCases[3],a=await create(f),id=a.body.snapshot.id,e=await edit(f,id,1,'first-edit','new');
    const stale=await edit(f,id,1,'stale','older');assert.equal(stale.status,409);assert.equal(stale.body.reason,'revision_conflict');assert.deepEqual(stale.body.current,e.body.snapshot);
    hidden(await call(op('stale'),{headers:bearer(f)}),404);
    const absent='I_'+'0'.repeat(64),missing=await call(route(absent),{headers:bearer(f)}),wrong=await call(route(id,'Q'),{headers:bearer(f)});
    hidden(missing,404);hidden(wrong,404);assert.deepEqual(missing.body,wrong.body);
    hidden(await call(route(id,'Q'),{method:'PATCH',headers:bearer(f),body:{operationId:'wrong',revision:2,body:'wrong'}}),403);
    hidden(await call(route(id,'Q')+'/history',{headers:bearer(f)}),404);hidden(await call(op('create','Q'),{headers:bearer(f)}),403);
  });
  await test('Actual product same-operation replay retains original snapshot after later edits and changed input/target/kind conflicts',async()=>{
    const f=productCases[4],a=await create(f,'same-create'),id=a.body.snapshot.id,e=await edit(f,id,1,'same-edit','first edit');
    assert.equal((await edit(f,id,2,'later-edit','latest')).status,200);
    const replay=await create(f,'same-create');assert.equal(replay.status,200);assert.equal(replay.body.source,'recovered');assert.deepEqual(replay.body.snapshot,a.body.snapshot);
    const again=await edit(f,id,1,'same-edit','first edit');assert.equal(again.status,200);assert.deepEqual(again.body.snapshot,e.body.snapshot);
    for(const r of[await create(f,'same-create','different'),await edit(f,id,1,'same-edit','different'),await edit(f,id,3,'same-create','latest')])hidden(r,409);
    const b=await create(f,'another');hidden(await edit(f,b.body.snapshot.id,1,'same-edit','first edit'),409);
    assert.deepEqual((await call(op('same-create'),{headers:bearer(f)})).body.snapshot,a.body.snapshot);
    productSaved.replay={f,id};
  });
  await test('Actual product concurrent duplicate creates commit one Issue/history/result and competing revisions commit one edit',async()=>{
    const f=productCases[5],responses=await Promise.all(Array.from({length:3},()=>create(f,'parallel')));
    assert.ok(responses.every(r=>r.status===200));assert.equal(responses.filter(r=>r.body.source==='committed').length,1);
    assert.ok(responses.every(r=>JSON.stringify(r.body.snapshot)===JSON.stringify(responses[0].body.snapshot)));const id=responses[0].body.snapshot.id;
    const edits=await Promise.all([edit(f,id,1,'parallel-a','a'),edit(f,id,1,'parallel-b','b')]);assert.deepEqual(edits.map(r=>r.status).sort(),[200,409]);
    const h=await call(route(id)+'/history',{headers:bearer(f)});assert.equal(h.body.history.length,2);productSaved.parallel={f,id};
  });
  await test('Actual product response discarded after commit is recovered by same operation ID without another history',async()=>{
    const f=productCases[6];const lost=await fetch(origin+route(),{method:'POST',headers:{...bearer(f),'Content-Type':'application/json'},body:JSON.stringify({operationId:'lost-response',body:'committed unseen'})});
    await lost.body.cancel(); // Only this host discards the HTTP success payload; not a real network failure.
    const r=await call(op('lost-response'),{headers:bearer(f)});assert.equal(r.status,200);assert.equal(r.body.snapshot.body,'committed unseen');
    const retry=await create(f,'lost-response','committed unseen');assert.equal(retry.status,200);assert.equal(retry.body.source,'recovered');assert.deepEqual(retry.body.snapshot,r.body.snapshot);
    assert.equal((await call(route(r.body.snapshot.id)+'/history',{headers:bearer(f)})).body.history.length,1);productSaved.lost={f,id:r.body.snapshot.id};
    return {simulation:'Actual product response body discarded after committed request; same-ID GET/retry succeeds',realNetworkPartition:false};
  });
  await test('Actual product history cursor pages preserve ordered revisions and bounded complete entries',async()=>{
    const f=productCases[7],a=await create(f),id=a.body.snapshot.id;
    for(let r=1;r<=3;r++)assert.equal((await edit(f,id,r,'page-'+r,'body '+r)).status,200);
    const first=await call(route(id)+'/history?limit=2',{headers:bearer(f)});assert.deepEqual(first.body.history.map(h=>h.revision),[1,2]);assert.equal(first.body.nextAfterRevision,2);
    const next=await call(route(id)+'/history?afterRevision=2&limit=2',{headers:bearer(f)});assert.deepEqual(next.body.history.map(h=>h.revision),[3,4]);assert.equal(next.body.nextAfterRevision,null);
    const empty=await call(route(id)+'/history?afterRevision=4',{headers:bearer(f)});assert.deepEqual(empty.body,{history:[],nextAfterRevision:null,resolutionEvents:[],nextResolutionAfterRevision:null});
  });
  await test('Actual product Cookie creation/edit preserve Origin/CSRF and mixed authentication rejection',async()=>{
    const f=productCases[8],headers=cookie(f),body={operationId:'cookie-create',body:'human body'};
    for(const h of[headers,{...headers,Origin:origin},{...headers,Origin:origin,'X-CSRF-Token':'wrong'},
      {...headers,Origin:'http://attacker.invalid','X-CSRF-Token':f.csrf}])hidden(await call(route(),{method:'POST',headers:h,body}),403);
    hidden(await call(route(),{method:'POST',headers:{...headers,...bearer(f),Origin:origin,'X-CSRF-Token':f.csrf},body}),400);
    const good={...headers,Origin:origin,'X-CSRF-Token':f.csrf},a=await call(route(),{method:'POST',headers:good,body});assert.equal(a.status,200);
    const e=await call(route(a.body.snapshot.id),{method:'PATCH',headers:good,body:{operationId:'cookie-edit',revision:1,body:'edited by human'}});assert.equal(e.status,200);assert.equal(e.body.snapshot.revision,2);
    assert.deepEqual((await call(op('cookie-edit'),{headers})).body.snapshot,e.body.snapshot);productSaved.cookie={f,id:a.body.snapshot.id};
  });
  await test('OpenAPI Issue contracts match actual product request/response shapes and preserve existing auth definitions',async()=>{
    const spec=JSON.parse(await readFile('docs/openapi.json','utf8'));
    // Use the locked validator for current anyOf/allOf/null contracts. No schema snapshot is regenerated.
    const ajv=new Ajv({allErrors:true,strict:false,validateSchema:false});
    ajv.addSchema({...spec,$id:'p2-03-contract'},'p2-03-contract');
    const validate=(name,value)=>{
      const validator=ajv.compile({$ref:`p2-03-contract#/components/schemas/${name}`});
      assert.ok(validator(value),`${name}: ${JSON.stringify(validator.errors)}`);
    };
    const {f,id}=productSaved.main;
    validate('IssueReadResult',(await call(route(id),{headers:bearer(f)})).body);
    validate('IssueHistoryPage',(await call(route(id)+'/history',{headers:bearer(f)})).body);
    validate('IssueOperationResult',(await call(op('product-edit'),{headers:bearer(f)})).body);
    assert.equal(spec.paths['/api/projects/{projectId}/issues'].post.requestBody.content['application/json'].schema.$ref,'#/components/schemas/CreateIssueInput');
    assert.equal(spec.paths['/api/projects/{projectId}/issues/{issueId}'].patch.responses['409'].content['application/json'].schema.$ref,'#/components/schemas/IssueError');
    const old=JSON.parse(await readFile('docs/p2-02-openapi-baseline.json','utf8'));
    // Current public-contract enrichment added response restrictions and route metadata.
    // Preserve the old auth meaning explicitly; whole-document equality would reject those additions.
    function assertAuthBaseline(spec){
      for(const[name,scheme]of Object.entries(old.components.securitySchemes))assert.deepEqual(spec.components.securitySchemes[name],scheme);
      for(const[name,schema]of Object.entries(old.components.schemas)){
      const tightened=['Principal','Project','Identity','Error'].includes(name)?{...schema,additionalProperties:false}:schema;
      assert.deepEqual(spec.components.schemas[name],tightened,`Preserved auth schema ${name}`);
    }
      for(const[path,item]of Object.entries(old.paths))for(const[method,operation]of Object.entries(item)){
      const current=spec.paths[path]?.[method];assert.ok(current,`Preserved auth route ${method} ${path}`);
      assert.equal(current.operationId,operation.operationId);assert.deepEqual(current.security,operation.security);
        for(const[status,response]of Object.entries(operation.responses)){
        assert.ok(current.responses[status],`Preserved status ${status}`);
        const content=structuredClone(response.content);
        const schema=content?.['application/json']?.schema;
        if(schema&&['401','403'].includes(status)&&schema.$ref==='#/components/schemas/Error'){
          content['application/json'].schema={allOf:[schema,{not:{anyOf:['current','snapshot','body','issue','document'].map(name=>({required:[name]}))}}]};
        }else if(schema&&status==='200'&&['/api/health','/api/auth/login','/api/auth/logout'].includes(path)){
          schema.required=Object.keys(schema.properties);schema.additionalProperties=false;
        }else if(schema&&status==='200'&&path==='/api/auth/context'){
          schema.properties.csrfToken.pattern='^[A-Za-z0-9_-]{43}$';schema.additionalProperties=false;
        }
        assert.deepEqual(current.responses[status].content,content,`Preserved response JSON contract ${method} ${path} ${status}`);
      }
      if(operation.requestBody){assert.deepEqual(current.requestBody.content,operation.requestBody.content);assert.equal(current.requestBody.required,operation.requestBody.required);}
        for(const parameter of operation.parameters??[]){
        const actual=current.parameters.find(p=>p.name===parameter.name&&p.in===parameter.in);assert.ok(actual);
        assert.equal(actual.required,parameter.required);
        // Current route accepts lowercase and 128 characters, matching index.ts/validateIssueRoute.
        assert.deepEqual(actual.schema,parameter.name==='projectId'?{type:'string',pattern:'^[A-Za-z0-9_-]{1,128}$'}:parameter.schema);
      }
    }
    }
    assertAuthBaseline(spec);
    for(const mutate of [
      value=>{value.paths['/api/auth/login'].post.requestBody.required=false;},
      value=>{value.paths['/api/auth/logout'].post.responses['200'].content['application/json'].schema.properties.authenticated.const=true;},
      value=>{delete value.paths['/api/auth/login'].post.responses['400'].content;},
    ]){const altered=structuredClone(spec);mutate(altered);assert.throws(()=>assertAuthBaseline(altered),'Auth contract comparator rejects a weakened required-input or response-value contract');}
    for(const[path,headers,schemaName]of[
      ['/api/auth/me',bearer(f),'Identity'],
      ['/api/auth/me',cookie(f),'Identity'],
    ]){
      const actual=await call(path,{headers});assert.equal(actual.status,200);validate(schemaName,actual.body);
      const historical=new Ajv({allErrors:true,validateSchema:false});historical.addSchema({...old,$id:'historical-auth'},'historical-auth');
      const validator=historical.compile({$ref:`historical-auth#/components/schemas/${schemaName}`});
      assert.ok(validator(actual.body),JSON.stringify(validator.errors));
    }
    const issueValidator=ajv.compile({$ref:'p2-03-contract#/components/schemas/IssueReadResult'});
    const actualRead=(await call(route(id),{headers:bearer(f)})).body;
    assert.equal(issueValidator({...actualRead,unexpected:true}),false,'Validator rejects undocumented properties');
    assert.equal(issueValidator({issue:{...actualRead.issue,revision:0}}),false,'Validator enforces revision bound');
    return {authBaseline:'Original P2-02 baseline retained; stable schemas, security, routes, input and status contracts asserted',
      evolution:['Current anyOf/allOf/null schemas validated by locked Ajv','Auth objects disallow additional properties','Project IDs widened to ASCII 1–128','Current identity validated against current and historical auth schema']};
  });
  await test('Confirmed operation IDs accompany actual create/edit/replay/result with matching OpenAPI and principal namespace',async()=>{
    const f=productCases[9],a=await create(f,'receipt-create','first receipt');assert.equal(a.status,200);assert.equal(a.body.operationId,'receipt-create');assert.equal(a.body.snapshot.revision,1);
    assert.deepEqual(Object.keys(a.body).sort(),['operationId','snapshot','source']);
    const id=a.body.snapshot.id,e=await edit(f,id,1,'receipt-edit','second receipt');assert.equal(e.status,200);assert.equal(e.body.operationId,'receipt-edit');assert.equal(e.body.snapshot.revision,2);
    const replay=await create(f,'receipt-create','first receipt');assert.equal(replay.status,200);assert.equal(replay.body.source,'recovered');assert.deepEqual(replay.body.snapshot,a.body.snapshot);assert.equal(replay.body.operationId,a.body.operationId);
    const editReplay=await edit(f,id,1,'receipt-edit','second receipt');assert.equal(editReplay.status,200);assert.equal(editReplay.body.source,'recovered');assert.deepEqual(editReplay.body.snapshot,e.body.snapshot);assert.equal(editReplay.body.operationId,e.body.operationId);
    for(const r of[a,e]){const read=await call(op(r.body.operationId),{headers:bearer(f)});assert.equal(read.status,200);assert.deepEqual(read.body,{operationId:r.body.operationId,snapshot:r.body.snapshot});}
    const other=await create(f,'receipt-create','other principal','other');assert.equal(other.status,200);assert.notEqual(other.body.snapshot.id,id);assert.equal(other.body.operationId,a.body.operationId);
    assert.deepEqual((await call(op('receipt-create'),{headers:bearer(f,'other')})).body,{operationId:'receipt-create',snapshot:other.body.snapshot});
    assert.deepEqual((await call(op('receipt-create'),{headers:bearer(f)})).body,{operationId:'receipt-create',snapshot:a.body.snapshot});
    const history=(await call(route(id)+'/history',{headers:bearer(f)})).body.history;assert.deepEqual(history.map(h=>h.operationId),['receipt-create','receipt-edit']);assert.ok(history.every(h=>h.actorId===f.ids.editor));
    const spec=JSON.parse(await readFile('docs/openapi.json','utf8'));
    for(const[name,value]of[['IssueMutationResult',a.body],['IssueMutationResult',e.body],['IssueOperationResult',(await call(op('receipt-edit'),{headers:bearer(f)})).body]]){
      const schema=spec.components.schemas[name];assert.ok(schema.required.includes('operationId'));assert.deepEqual(Object.keys(value).sort(),Object.keys(schema.properties).sort());assert.match(value.operationId,new RegExp(schema.properties.operationId.pattern));
      assert.equal(value.snapshot.id,id);assert.ok(Number.isSafeInteger(value.snapshot.revision));
    }
    productSaved.receipt={f,id,create:a.body,edit:e.body,other:other.body};
    return {successStatuses:[200,200,200,200],requestOperationIds:['receipt-create','receipt-edit'],revisionLocation:'snapshot.revision',namespace:'Same operationId independently confirmed for editor and other principal; own results remain separate'};
  });
  await stop();await start(config,8795,9237);
  await test('Confirmed operation receipt matches persisted principal/operation rows and legacy snapshot-only reader',async()=>{
    const r=productSaved.receipt,s=await state(r.f);assert.deepEqual([s.issues.length,s.history.length,s.operations.length,s.guards.length],[2,3,3,0]);
    for(const [principalId,receipt]of[[r.f.ids.editor,r.create],[r.f.ids.editor,r.edit],[r.f.ids.other,r.other]]){
      const row=s.operations.find(o=>o.principal_id===principalId&&o.operation_id===receipt.operationId);assert.ok(row);assert.equal(row.state,'confirmed');assert.deepEqual(JSON.parse(row.snapshot),receipt.snapshot);
    }
    const legacy=await call('/fixture/read-legacy',{method:'POST',headers:bearer(r.f),body:{caseId:r.f.caseId,projectId:'P',input:'receipt-edit'}});
    assert.equal(legacy.status,200);assert.deepEqual(legacy.body,{snapshot:r.edit.snapshot});
  });
  await test('Product commits survive runtime restart with exact matching Issue/history/result counts and no guards',async()=>{
    for(const[name,counts]of[['main',[1,2,2]],['parallel',[1,2,2]],['lost',[1,1,1]],['cookie',[1,2,2]],['replay',[2,4,4]]]){
      const f=productSaved[name].f,s=await state(f);assert.deepEqual([s.issues.length,s.history.length,s.operations.length],counts);assert.equal(s.guards.length,0);
      assert.ok(s.operations.every(x=>x.state==='confirmed'&&x.authority_kind==='project'));
      for(const h of s.history){const o=s.operations.find(o=>o.operation_id===h.operation_id&&o.principal_id===h.actor_id);assert.ok(o);
        const snap=JSON.parse(o.snapshot);assert.equal(snap.id,h.issue_id);assert.equal(snap.body,h.after_body);assert.equal(snap.revision,h.revision);assert.equal(snap.updatedAt,h.created_at);}
    }
  });
  const revoked=[];
  for(const fault of['credential','expiry','principal','view','edit','scope-view']){const f=await fresh(),a=await create(f);revoked.push({f,id:a.body.snapshot.id,fault});assert.equal((await control(f,fault)).status,200);}
  const pendingCase=await fresh(),pendingCreate=await create(pendingCase);
  await stop();
  // Deliberately corrupt only this isolated synthetic DB while no runtime holds it. Product batches cannot expose pending rows.
  await writeFile(`${store}/pending.sql`,`INSERT INTO operation_results(principal_id,operation_id,operation_kind,target_id,project_id,input_hash,required_permissions,state,created_at,authority_kind)
    VALUES('${pendingCase.ids.editor}','pending','issue.edit','${pendingCreate.body.snapshot.id}','P','${'0'.repeat(64)}','["edit","view"]','pending',unixepoch(),'project');\n`);
  await run(process.execPath,['--require',process.cwd()+'/tests/support/local-network-guard.cjs',cli,'d1','execute','projektor-p2-03-isolated-fixture','--local','--config',config,'--persist-to',store,'--file',`${store}/pending.sql`],{env,maxBuffer:2e6});
  await start('tests/support/p2-03-fixture/product.jsonc',8796,9238);
  await test('Pending result is unavailable; actor-bound missing404 differs from denied wrong-project403',async()=>{
    const pending=await call(op('pending'),{headers:bearer(pendingCase)});hidden(pending,503);assert.deepEqual(pending.body,{error:'operation_unconfirmed'});
    const missing=await call(op('missing'),{headers:bearer(pendingCase)}),wrong=await call(op('pending','Q'),{headers:bearer(pendingCase)});
    hidden(missing,404);hidden(wrong,403);assert.deepEqual(missing.body,{error:'operation_not_found',operationId:'missing',application:'unknown'});assert.deepEqual(wrong.body,{error:'forbidden'});
    return {injection:'Synthetic pending row inserted through Wrangler local CLI with runtimes stopped; production atomic batch does not leave pending rows visible'};
  });
  await test('Strict extra-field validation rejects prototype-name fields and unknown history queries without a write',async()=>{
    const body=JSON.parse('{"operationId":"prototype-extra","body":"valid text","__proto__":true}');
    const r=await call(route(),{method:'POST',headers:bearer(pendingCase),body});hidden(r,400);
    assert.equal(r.body.fields.__proto__,'unknown field');hidden(await call(op('prototype-extra'),{headers:bearer(pendingCase)}),404);
    const q=await call(route(pendingCreate.body.snapshot.id)+'/history?__proto__=1',{headers:bearer(pendingCase)});hidden(q,400);assert.ok(q.body.fields.query);
  });
  await test('Actual product next reads/results and mutations hide committed bodies after credential or membership/scope revocation',async()=>{
    for(const {f,id,fault}of revoked){const status=['credential','expiry','principal'].includes(fault)?401:403;
      hidden(await call(op('create'),{headers:bearer(f)}),status);hidden(await edit(f,id,1,'after-cancel','must not commit'),status);
      if(fault!=='edit'){hidden(await call(route(id),{headers:bearer(f)}),status);hidden(await call(route(id)+'/history',{headers:bearer(f)}),status);}
      else assert.equal((await call(route(id),{headers:bearer(f)})).status,200);
    }return {cases:6};
  });
  await test('Identical human cookie survives Worker restart and then rejects revocation idle and absolute expiry',async()=>{
    const saved=productSaved.cookie,subjects=[saved.f,productCases[6],productCases[7]],cookies=subjects.map(cookie);
    for(const [i,f] of subjects.entries()){
      const me=await call('/api/auth/me',{headers:cookies[i]});assert.equal(me.status,200);assert.equal(me.body.principal.id,f.ids.human);
      assert.equal((await call(route(saved.id),{headers:cookies[i]})).status,200);
    }
    await stop();await start('tests/support/p2-03-fixture/product.jsonc',8796,9238);
    for(const [i,f] of subjects.entries()){
      assert.deepEqual(cookies[i],cookie(f),'original cookie is reused without login or replacement');
      const me=await call('/api/auth/me',{headers:cookies[i]});assert.equal(me.status,200);assert.equal(me.body.principal.id,f.ids.human);
      const read=await call(route(saved.id),{headers:cookies[i]});assert.equal(read.status,200);assert.equal(read.body.issue.body,'edited by human');
    }
    await stop();await start(config,8795,9237);
    for(const [i,fault] of ['session','session-idle','session-absolute'].entries()){
      const changed=await call('/fixture/control',{method:'POST',headers:cookies[i],body:{caseId:subjects[i].caseId,fault}});assert.equal(changed.status,200);
    }
    await stop();await start('tests/support/p2-03-fixture/product.jsonc',8796,9238);
    for(const headers of cookies){hidden(await call('/api/auth/me',{headers}),401);hidden(await call(route(saved.id),{headers}),401);}
    return {sessionSource:'three synthetic human sessions persisted in real D1',restart:'owned product Worker process stopped and restarted; same cookie reused',afterRestart:['same principal','authorized Issue read'],denials:['session revocation','idle boundary','absolute boundary'],expiryMethod:'isolated D1 timestamps set to the boundary; no wall-clock longevity claim',browserStorage:'not exercised by this HTTP-runtime regression'};
  });
  assert.equal(report.failures.length,0,'P2-03 integration cases failed');
  assert.equal(report.results.filter(r=>r.role==='selected').length,selected.size,'Every selected case ran');
  report.passed=true;report.fullSuitePassed=report.mode==='full';report.status='passed';console.log(`P2-03: ${report.results.length} groups passed (${report.mode}).`);
}catch(e){report.passed=false;report.status='failed';report.error={name:e.name,message:e.message};console.error(e);process.exitCode=1;}
finally{await stop();await rm(store,{recursive:true,force:true});report.persistenceRemoved=true;report.completedCaseCount=report.results.length+report.failures.length;report.completedAt=new Date().toISOString();await save();}
