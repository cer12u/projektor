// @module verification
// @role p2-02-integration
// Real local workerd/D1 and actual product entrypoint. No old code, remote resources or real credentials.
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,mkdtemp,readdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const run=promisify(execFile),cli='node_modules/wrangler/bin/wrangler.js',config='tests/support/p2-02-fixture/wrangler.jsonc';
const runId=randomUUID(),store=await mkdtemp(join(tmpdir(),'projektor-p2-02-'));
const evidenceDir=resolve(process.env.P2_02_EVIDENCE_DIR??'.local/evidence/p2-02');await mkdir(evidenceDir,{recursive:true});
// A clean local home avoids inherited account credentials. Every Wrangler command is explicitly local.
const env={PATH:process.env.PATH,HOME:store,XDG_CONFIG_HOME:store,CI:'true',WRANGLER_SEND_METRICS:'false', CLOUDFLARE_CF_FETCH_ENABLED:'false', WRANGLER_HIDE_BANNER:'true', WRANGLER_SEND_ERROR_REPORTS:'false',WRANGLER_LOG_PATH:join(evidenceDir,`wrangler-${runId}.raw.log`)};
const hashes={};for(const f of ['src/adapters/d1/persistence/commit.ts','src/adapters/d1/identity/permissions.ts','src/adapters/d1/identity/management.ts','src/apps/http/management.ts',
  'src/apps/worker.ts','src/adapters/d1/identity/assembly.ts','src/adapters/d1/identity/authorization.ts','src/modules/identity/public.ts','src/apps/http/credentials.ts','tests/support/identity-fixture.ts','src/adapters/d1/identity/db.ts','migrations/0001_auth.sql','migrations/0002_mutations.sql','migrations/0003_management.sql',
  'tests/support/p2-02-fixture/worker.ts',config,'tests/support/p2-02-fixture/product.jsonc','tests/integration/d1/p2-02-integration.mjs','package-lock.json'])
  hashes[f]=createHash('sha256').update(await readFile(f)).digest('hex');
const report={phase:'P2-02',plan:'v1.1',startedAt:new Date().toISOString(),host:'codexvm',node:process.version,
  runtime:'Wrangler 4.149.0 / workerd 1.20261006.1 / local D1 binding',persistence:store,hashes,results:[],failures:[],
  credentials:'Only random synthetic values held in memory; omitted from evidence',productEntrypoint:'src/apps/worker.ts; dedicated local HTTP config only'};
const filterText=process.argv[2]??null;let filter=null;const dependencies=new Set();
Object.assign(report,{runId,filter:filterText,mode:filterText===null?'full':'filtered',status:'running',passed:false,fullSuitePassed:false,registered:[],skipped:[],ledger:{}});
const evidencePath=join(evidenceDir,filterText===null?'p2-02-integration.json':'p2-02-integration-focused.json');
const save=()=>writeFile(evidencePath,JSON.stringify(report,null,2)+'\n');
await save(); // Invalidate an earlier success before regex compilation, setup or execution.
async function wrangler(args,label){
  try{const result=await run(process.execPath,['--require',process.cwd()+'/tests/support/local-network-guard.cjs',cli,...args],{env,maxBuffer:4e6,timeout:90000});
    await writeFile(join(evidenceDir,`${label}-${runId}.log`),result.stdout+result.stderr);return result;}
  catch(error){await writeFile(join(evidenceDir,`${label}-${runId}.log`),(error.stdout??'')+(error.stderr??''));throw error;}
}
async function verifyLedger(expected,stage,cfg=config){
  const {stdout}=await wrangler(['d1','execute','projektor-p2-02-isolated-fixture','--local','--config',cfg,'--persist-to',store,'--command','SELECT name FROM d1_migrations ORDER BY id','--json'],`ledger-${stage}`);
  const output=JSON.parse(stdout);assert.ok(output.every(item=>item.success),'Wrangler ledger query succeeded');
  const actual=output.flatMap(item=>item.results.map(row=>row.name));assert.deepEqual(actual,expected,`Exact canonical ${stage} ledger`);
  report.ledger[stage]=actual;await save();
}
const pause=ms=>new Promise(r=>setTimeout(r,ms));let child,logs=[],origin='http://127.0.0.1:8793';
async function stop(){if(!child)return;child.kill('SIGINT');await Promise.race([new Promise(r=>child.once('exit',r)),pause(3000)]);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),pause(1000)]);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await writeFile(join(evidenceDir,`runtime-${runId}-${Date.now()}.raw.log`),logs.join(''));child=undefined;}
async function start(cfg,port,inspector){logs=[];child=spawn(process.execPath,['--require',process.cwd()+'/tests/support/local-network-guard.cjs',cli,'dev','--config',cfg,'--local','--persist-to',store,
  '--ip','127.0.0.1','--port',String(port),'--inspector-port',String(inspector),'--local-protocol','http','--upstream-protocol','http'],{env,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',d=>logs.push(d.toString()));child.stderr.on('data',d=>logs.push(d.toString()));
  for(let i=0;i<450;i++){if(logs.join('').includes('Ready on'))break;if(child.exitCode!==null)throw new Error('Owned runtime exited');await pause(100);}
  assert.ok(logs.join('').includes(`Ready on http://127.0.0.1:${port}`),'Owned loopback runtime not ready on its requested port');origin=`http://localhost:${port}`;
}
async function call(path,{headers={},method='GET',body,raw}={}){
  const response=await fetch(origin+path,{signal:AbortSignal.timeout(15000),method,headers:{...(body!==undefined||raw!==undefined?{'Content-Type':'application/json'}:{}),...headers},
    ...(body!==undefined?{body:JSON.stringify(body)}:raw!==undefined?{body:raw}:{})});
  return {status:response.status,body:await response.json(),headers:Object.fromEntries(response.headers)};
}
const bearer=(f,label='global')=>({Authorization:`Bearer ${f.tokens[label]}`});
const session=(f,label='human')=>({Cookie:`__Host-projektor_session=${f.sessions[label]}`});
async function fresh(){const r=await call('/fixture/new',{method:'POST'});assert.equal(r.status,200);return r.body;}
const state=async f=>(await call(`/fixture/state?case=${encodeURIComponent(f.caseId)}`)).body;
const membership=(f,id='set',permissions=['view','assign'],revision=1)=>({operationId:id,kind:'management.membership.set',targetId:f.ids['target-human'],projectId:'P',input:{revision,permissions}});
const principal=(f,id='principal',targetId=f.ids['target-human'],change={active:false},revision=1)=>({operationId:id,kind:'management.principal.update',targetId,projectId:'GLOBAL',input:{revision,...change}});
const scope=(f,id='scope',permissions=['view','assign'],revision=1)=>({operationId:id,kind:'management.credential.scope',targetId:f.keys['target-agent'],projectId:'P',input:{revision,permissions}});
const revoke=(f,id='revoke')=>({operationId:id,kind:'management.credential.revoke',targetId:f.keys['target-agent'],projectId:'GLOBAL',input:{revision:1}});
const manage=(f,command,label='global',fault)=>call('/fixture/manage',{method:'POST',headers:bearer(f,label),body:{caseId:f.caseId,command,fault}});
const control=(f,action,label='global')=>call('/fixture/control',{method:'POST',headers:bearer(f,label),body:{caseId:f.caseId,action}});
function hidden(r,status){assert.equal(r.status,status);assert.equal(r.body.snapshot,undefined);assert.equal(r.body.current,undefined);}
async function test(name,fn){report.registered.push(name);const selected=!filter||filter.test(name);if(!selected&&!dependencies.has(name)){report.skipped.push(name);return;}const role=selected?'selected':'dependency';const started=performance.now();try{const details=await fn();report.results.push({name,role,passed:true,wallMs:Math.round(performance.now()-started),...details});console.log('PASS '+name);}
  catch(error){report.failures.push({name,role,error:error.message});await save();throw error;}await save();}
try{
  if(filterText!==null)filter=new RegExp(filterText);
  if(filter?.test('Product API commits persist through runtime restart with matching audit and result')){
    for(const name of ['Actual product routes require authentication, scope and bounded input with no redirects/secrets',
      'Actual product cookie mutation preserves Origin/CSRF and mixed-authentication rejection'])if(!filter.test(name))dependencies.add(name);
  }
  report.dependencyCaseCount=dependencies.size;
  // Preserve the legacy-row backfill test without manually applying schema SQL.
  // Wrangler first owns the exact canonical 0001/0002 prefix, then applies its pending canonical suffix.
  const canonical=(await readdir('migrations')).filter(file=>file.endsWith('.sql')).sort();
  const prefix=canonical.slice(0,2);assert.deepEqual(prefix,['0001_auth.sql','0002_mutations.sql']);
  const prefixDir=join(store,'prefix');await mkdir(prefixDir);
  for(const file of canonical){const bytes=await readFile(join('migrations',file));hashes[`migrations/${file}`]=createHash('sha256').update(bytes).digest('hex');
    if(prefix.includes(file)){await writeFile(join(prefixDir,file),bytes);assert.deepEqual(await readFile(join(prefixDir,file)),bytes);}}
  const prefixConfig=join(store,'prefix.json');await writeFile(prefixConfig,JSON.stringify({name:'projektor-p2-02-isolated-fixture',compatibility_date:'2026-10-09',
    d1_databases:[{binding:'DB',database_name:'projektor-p2-02-isolated-fixture',database_id:'00000000-0000-0000-0000-000000000003',migrations_dir:prefixDir,remote:false}]}));
  await wrangler(['d1','migrations','apply','projektor-p2-02-isolated-fixture','--local','--config',prefixConfig,'--persist-to',store],'migrations-prefix');
  await verifyLedger(prefix,'prefix',prefixConfig);
  await writeFile(`${store}/legacy.sql`,"INSERT INTO principals VALUES('legacy-agent','agent','legacy',NULL,1,1);\nINSERT INTO memberships VALUES('legacy-agent','P','view');\nINSERT INTO api_credentials VALUES('legacy-key','legacy-agent','synthetic-non-auth-hash',9999999999,NULL);\nINSERT INTO api_grants VALUES('legacy-key','P','view');\n");
  await wrangler(['d1','execute','projektor-p2-02-isolated-fixture','--local','--config',prefixConfig,'--persist-to',store,'--file',`${store}/legacy.sql`],'synthetic-legacy-rows');
  await wrangler(['d1','migrations','apply','projektor-p2-02-isolated-fixture','--local','--config',config,'--persist-to',store],'migrations-canonical');
  await verifyLedger(canonical,'canonical');
  await start(config,8793,9235);
  await test('Additive migration backfills records with global administrator false and no membership changes',async()=>{
    const r=await call('/fixture/backfill');assert.equal(r.status,200);assert.ok(r.body.every(rows=>rows.length===1));
    assert.equal(r.body[0][0].global_administrator,0);assert.equal(r.body[0][0].revision,1);assert.equal(r.body[4][0].permission,'view');
  });
  await test('Six capabilities are independent; permission reads never join membership',async()=>{
    const f=await fresh(),before=(await call('/fixture/member-count')).body.count;const caps=['view','edit','assign','transition','execute','manage'];
    for(const held of caps)for(const requested of caps){const r=await call(`/fixture/permission?project=P&permission=${requested}`,{headers:bearer(f,`cap-${held}`)});
      assert.equal(r.status,requested==='view'||requested===held?200:403);}
    for(let i=0;i<3;i++)hidden(await call('/fixture/permission?project=P&permission=view',{headers:session(f,'outsider')}),403);
    assert.equal((await call('/fixture/member-count')).body.count,before);return {matrix:36,outsiderRepeatedReads:3};
  });
  await test('Project manage and all-project manage cannot replace global administration',async()=>{
    const f=await fresh(),before=await state(f);
    for(const label of ['project','all-project'])for(const cmd of [principal(f),revoke(f)])hidden(await manage(f,cmd,label),403);
    assert.deepEqual(await state(f),before);
    assert.equal((await manage(f,membership(f),'project')).status,200);
    assert.equal((await manage(f,scope(f),'project')).status,200);
  });
  await test('Global administrator without project manage can modify unaffiliated/historical subjects but gains no project capability',async()=>{
    const f=await fresh();for(const permission of ['view','edit','assign','transition','execute','manage'])
      hidden(await call(`/fixture/permission?project=P&permission=${permission}`,{headers:bearer(f,'global-no-project')}),403);
    hidden(await call(`/fixture/display?project=P&id=${f.ids.old}`,{headers:bearer(f,'global-no-project')}),403);
    for(const target of [f.ids.outsider,f.ids.old])assert.equal((await manage(f,principal(f,'global-'+target,target,{active:false}),'global-no-project')).status,200);
    assert.equal((await manage(f,revoke(f),'global-no-project')).status,200);
    const s=await state(f);assert.equal(s.audit.length,3);assert.ok(s.operations.every(r=>r.authority_kind==='global-administrator'&&r.required_permissions==='[]'));
  });
  await test('Project membership/scope changes stay in their project; private/missing targets have identical refusal',async()=>{
    const f=await fresh(),before=await state(f),responses=[];
    for(const cmd of [{...membership(f),projectId:'Q'},{...membership(f),targetId:'absent'},{...scope(f),projectId:'Q'},{...scope(f),targetId:'absent-key'}]){
      const r=await manage(f,cmd,'project');hidden(r,403);responses.push(r.body);}
    for(const r of responses)assert.deepEqual(r,{error:'forbidden'});assert.deepEqual(await state(f),before);
    assert.equal((await manage(f,membership(f),'project')).status,200);
    const s=await state(f);assert.equal(s.memberships.filter(r=>r.principal_id===f.ids['target-human']).length,2);
    assert.ok(s.memberships.filter(r=>r.principal_id===f.ids['target-human']).every(r=>r.project_id==='P'));
  });
  await test('Post-preflight project manage/member/scope cancellation and actor disable/credential expiry reject at common batch',async()=>{
    const cases=[['manage',403],['membership',403],['scope',403],['credential',401],['expiry',401],['principal',401]];
    for(const [fault,status]of cases){const f=await fresh(),before=await state(f);hidden(await manage(f,membership(f),'project',fault),status);assert.deepEqual(await state(f),before);}
    return {cases,timing:'Real authentication and successful management preparation, then fault before executeMutation batch'};
  });
  await test('Global administrator cancellation after preparation denies global commit and result disclosure',async()=>{
    const f=await fresh(),before=await state(f);hidden(await manage(f,principal(f),'global','administrator'),403);assert.deepEqual(await state(f),before);
    const g=await fresh();assert.equal((await manage(g,principal(g,'confirmed'))).status,200);assert.equal((await control(g,'administrator')).status,200);
    hidden(await call('/fixture/result?id=confirmed',{headers:bearer(g)}),403);hidden(await manage(g,principal(g,'confirmed')),403);
  });
  await test('Revision/state guard rejects concurrent target change and competing administrative revisions',async()=>{
    const f=await fresh(),changed=await manage(f,principal(f),'global','target-change');assert.equal(changed.status,409);assert.equal(changed.body.reason,'target_changed');
    let s=await state(f);assert.equal(s.audit.length,0);assert.equal(s.operations.length,0);assert.equal(s.guards.length,0);
    const g=await fresh(),rs=await Promise.all([manage(g,membership(g,'race-a')),manage(g,membership(g,'race-b'))]);assert.deepEqual(rs.map(r=>r.status).sort(),[200,409]);
    s=await state(g);assert.equal(s.audit.length,1);assert.equal(s.operations.length,1);assert.equal(s.guards.length,0);
  });
  await test('Audit/result failure rolls back state, revision, permissions and all common batch rows',async()=>{
    for(const operation of ['rollback-audit','rollback-result']){const f=await fresh(),before=await state(f);assert.equal((await manage(f,membership(f,operation))).status,500);assert.deepEqual(await state(f),before);}
  });
  await test('Historical display is separate from current login and immutable audit preserves prior display',async()=>{
    const f=await fresh();const old=await call(`/fixture/display?project=P&id=${f.ids.old}`,{headers:bearer(f)});assert.equal(old.status,200);assert.equal(old.body.displayName,'old');assert.equal(old.body.active,false);
    hidden(await call('/fixture/who',{headers:session(f,'old')}),401);
    assert.equal((await manage(f,principal(f,'rename',f.ids['target-human'],{displayName:'new-label'}))).status,200);
    const s=await state(f);assert.equal(JSON.parse(s.audit[0].before_snapshot).displayName,'target-human');assert.equal(JSON.parse(s.audit[0].after_snapshot).displayName,'new-label');
    const displayed=await call(`/fixture/display?project=P&id=${f.ids['target-human']}`,{headers:bearer(f)});assert.equal(displayed.body.displayName,'new-label');
    assert.equal((await call('/fixture/tamper-audit',{method:'POST',headers:bearer(f),body:{operationId:'rename'}})).status,503);assert.deepEqual(await state(f),s);
  });
  await test('Scope change retains fixed credential principal; global revocation rejects the next authentication',async()=>{
    const f=await fresh(),headers=bearer(f,'target-agent');const a=await call('/fixture/who',{headers});assert.equal(a.body.id,f.ids['target-agent']);
    assert.equal((await manage(f,scope(f))).status,200);const b=await call('/fixture/who',{headers});assert.deepEqual(b.body,a.body);
    assert.equal((await manage(f,{...revoke(f),input:{revision:2}})).status,200);hidden(await call('/fixture/who',{headers}),401);
  });
  await test('Administrative replay normalizes permission sets, detects changed input and writes one audit',async()=>{
    const f=await fresh(),first=await manage(f,membership(f,'replay',['view','assign']));assert.equal(first.status,200);const s=await state(f);
    const second=await manage(f,membership(f,'replay',['assign','view','assign']));assert.equal(second.status,200);assert.equal(second.body.source,'recovered');assert.deepEqual(second.body.snapshot,first.body.snapshot);
    hidden(await manage(f,membership(f,'replay',['view','edit'])),409);assert.deepEqual(await state(f),s);
  });
  await test('Strict management input rejects actor/secret/global-administrator assignment and invalid permissions',async()=>{
    const f=await fresh(),base=membership(f),before=await state(f);
    for(const cmd of [{...base,actor:f.ids.global},{...base,input:{revision:1,permissions:['owner']}},{...principal(f),input:{revision:1,globalAdministrator:true}},
      {...revoke(f),input:{revision:1,token:'synthetic-invalid'}},{...base,input:{revision:0,permissions:[]}}])hidden(await manage(f,cmd),400);
    assert.deepEqual(await state(f),before);
  });
  await test('Prepared global replay cannot disclose after administrator or credential cancellation',async()=>{
    for(const [fault,status]of [['administrator',403],['credential',401]]){
      const f=await fresh(),cmd=principal(f,'prepared-replay');assert.equal((await manage(f,cmd)).status,200);const before=await state(f);
      hidden(await manage(f,cmd,'global',fault),status);assert.deepEqual(await state(f),before);
    }
    return {timing:'Confirmed result read while authorized during preparation, then cancellation before common reserve/recovery'};
  });
  await test('Target validity is checked at batch after preparation for membership and credential scope',async()=>{
    for(const [kind,fault,reason]of [['membership','target-disable','target_inactive'],['scope','target-key-revoke','credential_inactive'],
      ['scope','target-key-expire','credential_inactive'],['scope','target-agent-disable','credential_inactive']]){
      const f=await fresh(),r=await manage(f,kind==='membership'?membership(f):scope(f),'project',fault);
      assert.equal(r.status,409);assert.equal(r.body.reason,reason);const s=await state(f);
      assert.equal(s.audit.length,0);assert.equal(s.operations.length,0);assert.equal(s.guards.length,0);
      assert.equal(s.projectRecords.find(row=>row.principal_id===f.ids['target-human']).revision,1);
      assert.equal(s.credentialManagement[0].revision,1);
    }
  });
  const apiCase=await fresh();await stop();await start('tests/support/p2-02-fixture/product.jsonc',8794,9236);
  await test('Actual product routes require authentication, scope and bounded input with no redirects/secrets',async()=>{
    const f=apiCase,route=`/api/projects/P/memberships/${f.ids['target-human']}`;
    const unauth=await call(route,{method:'PUT',body:{operationId:'x',revision:1,permissions:[]}});hidden(unauth,401);assert.equal(unauth.headers.location,undefined);assert.equal(unauth.headers['cache-control'],'no-store');
    hidden(await call(route,{method:'PUT',headers:bearer(f,'cap-edit'),body:{operationId:'x',revision:1,permissions:[]}}),403);
    hidden(await call(route,{method:'PUT',headers:bearer(f),body:{operationId:'x',revision:1,permissions:[],actor:'override'}}),400);
    hidden(await call(route,{method:'PUT',headers:bearer(f),raw:'x'.repeat(4097)}),413);
    hidden(await call(`/api/management/principals/${f.ids.outsider}`,{method:'PATCH',headers:bearer(f),body:{operationId:'promote',revision:1,globalAdministrator:true}}),400);
    const r=await call(`/api/management/principals/${f.ids.outsider}`,{method:'PATCH',headers:bearer(f,'global-no-project'),body:{operationId:'product-global',revision:1,active:false}});assert.equal(r.status,200);
    hidden(await call('/api/auth/me',{headers:session(f,'outsider')}),401);
    for(const token of Object.values(f.tokens))assert.ok(!JSON.stringify(r.body).includes(token));
  });
  await test('Actual product cookie mutation preserves Origin/CSRF and mixed-authentication rejection',async()=>{
    const f=apiCase,route=`/api/projects/P/memberships/${f.ids['target-human']}`,body={operationId:'product-cookie',revision:1,permissions:['view','edit','manage']};
    const headers=session(f);
    const me=await call('/api/auth/me',{headers});assert.equal(me.status,200);assert.equal(me.body.csrfToken,f.csrf);
    hidden(await call(route,{method:'PUT',headers:{...headers,Origin:origin},body}),403);
    hidden(await call(route,{method:'PUT',headers:{...headers,Origin:'http://attacker.invalid','X-CSRF-Token':f.csrf},body}),403);
    hidden(await call(route,{method:'PUT',headers:{...headers,...bearer(f),Origin:origin,'X-CSRF-Token':f.csrf},body}),400);
    const good=await call(route,{method:'PUT',headers:{...headers,Origin:origin,'X-CSRF-Token':f.csrf},body});assert.equal(good.status,200);assert.equal(good.body.snapshot.revision,2);
    const read=await call('/api/management/operations/product-cookie',{headers});assert.equal(read.status,200);assert.deepEqual(read.body.snapshot,good.body.snapshot);
  });
  await stop();await start(config,8793,9235);
  await test('Product API commits persist through runtime restart with matching audit and result',async()=>{
    const s=await state(apiCase);assert.equal(s.audit.length,2);assert.equal(s.operations.length,2);assert.equal(s.guards.length,0);
    const global=s.operations.find(r=>r.operation_id==='product-global'),project=s.operations.find(r=>r.operation_id==='product-cookie');
    assert.equal(global.authority_kind,'global-administrator');assert.equal(project.authority_kind,'project');
    for(const a of s.audit){assert.equal(a.after_revision,a.before_revision+1);assert.ok(s.operations.some(r=>r.operation_id===a.operation_id&&r.principal_id===a.actor_id));}
  });
  assert.equal(report.registered.length,18,'All 18 original P2-02 groups remain registered');
  report.selectedCaseCount=report.results.filter(result=>result.role==='selected').length;
  assert.ok(report.selectedCaseCount>0,'Filter matched zero P2-02 groups');
  report.completedAt=new Date().toISOString();report.status='completed';report.passed=true;
  report.fullSuitePassed=filterText===null&&report.results.length===18;
  console.log(`P2-02: ${report.selectedCaseCount}/18 selected groups and ${report.dependencyCaseCount} dependencies passed (${report.mode}; fullSuitePassed=${report.fullSuitePassed}).`);
}catch(error){report.passed=false;report.status='failed';report.completedAt=new Date().toISOString();report.error={name:error.name,message:error.message};throw error;}
finally{try{await stop();}finally{await rm(store,{recursive:true,force:true});report.persistenceRemoved=true;await save();}}
