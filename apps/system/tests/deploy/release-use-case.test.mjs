// @module verification
// @role deployment-contract
import test from 'node:test';
import {ACCOUNT,WORKER,DATABASE,configuration} from './synthetic-target.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {createReleaseUseCase} from '../../deploy/release-use-case.mjs';
import {createJournal} from '../../deploy/release-journal.mjs';
import {requiredOperations,managedConnector,assertReleaseIdentity} from '../../deploy/cloudflare-port.mjs';
import {normalizeVersion} from '../../deploy/wrangler-adapter.mjs';

// Operation-contract doubles only. No HTTP server, provider protocol, CLI spawn,
// credentials, synthetic Cloudflare authorization, or external requests.
const oldId='11111111-1111-4111-8111-111111111111',newId='22222222-2222-4222-8222-222222222222';
const target={account:ACCOUNT,worker:WORKER};
const bindings=[{name:'ASSETS',type:'assets'},{name:'AUTH_ORIGIN',type:'plain_text',textSha256:'origin'},
  {name:'DB',type:'d1',id:'approved-db'},{name:'JWT_SECRET',type:'secret_text'}];
const prerequisitePolicy={databaseId:'approved-db',migrationNames:Array.from({length:19},(_,i)=>String(i+1)),gate:{mode:'stopped',epoch:4},security:{accessPoliciesHash:'access',domainsHash:'domains',workerSettingsHash:'settings'}};
const policy={prerequisites:prerequisitePolicy,compatibilityDate:'2026-10-09',compatibilityFlags:['nodejs_compat'],migrationTag:'v2',assets:{notFoundHandling:'single-page-application',runWorkerFirst:['/api/*','/mcp']},bindings:[...bindings.filter(b=>b.name!=='JWT_SECRET'),{name:'MCP_ENABLED',type:'plain_text',textSha256:'false-hash'}]};
const release={...target,artifactTreeSha256:'a'.repeat(64),workerSha256:'b'.repeat(64),policy};
const observedAt='2026-10-12T14:00:00.000Z';
function version(id){return {target,observedAt:new Date().toISOString(),versionId:id,compatibilityDate:policy.compatibilityDate,compatibilityFlags:policy.compatibilityFlags,migrationTag:policy.migrationTag,origin:'wrangler',preview:false,assets:policy.assets,bindings:id===oldId?bindings:[...policy.bindings,{name:'JWT_SECRET',type:'secret_text'}].sort((a,b)=>a.name.localeCompare(b.name))};}
async function harness(t,overrides={}){
  const dir=await mkdtemp(resolve(tmpdir(),'projektor-contract-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const journal=createJournal(dir,release),calls=[];let active=oldId;
  const base={describe:()=>({id:'contract-test-only',runtimeAvailable:true,operations:Object.fromEntries(requiredOperations.map(op=>[op,'supported']))}),ready:async()=>{},
    inspectDeployment:async()=>({target,observedAt:new Date().toISOString(),deploymentId:'33333333-3333-4333-8333-333333333333',versions:[{versionId:active,percentage:100}]}),
    inspectPrerequisites:async(t,id)=>({target,observedAt:new Date().toISOString(),currentVersion:id,database:{id:'approved-db',migrationNames:prerequisitePolicy.migrationNames},gate:prerequisitePolicy.gate,security:prerequisitePolicy.security,service:{projection:'default_environment.script',origin:'wrangler',tags:[],migrationTag:'v2',hasPreview:false}}),
    inspectVersion:async(t,id)=>version(id),uploadStaticVersion:async()=>({kind:'command-reported',versionId:newId,evidence:{effectiveExitCode:0}}),
    promoteVersion:async()=>{active=newId;return {kind:'command-reported',versionId:newId,evidence:{effectiveExitCode:0}};},...overrides};
  const port=Object.fromEntries(Object.entries(base).map(([k,v])=>[k,k==='describe'?v:async(...args)=>{calls.push(k);return v(...args);} ]));
  return {journal,calls,port,useCase:createReleaseUseCase({port,journal,release}),setActive:id=>{active=id;}};
}
test('incomplete whole-release capability stops before any adapter operation or intent',async t=>{
  const h=await harness(t,{describe:()=>managedConnector});
  await assert.rejects(h.useCase.upload(oldId),/INCOMPLETE_STATIC_RELEASE_CAPABILITY/);
  assert.deepEqual(h.calls,[]);assert.equal(await h.journal.read(),null);
});
test('authorization denial dispatches once, stops readback, and blocks reconciliation/replay',async t=>{
  const h=await harness(t,{uploadStaticVersion:async()=>({kind:'outcome-unknown',error:{kind:'auth-denied',code:'DENIED'},evidence:{exitCode:0,effectiveExitCode:1}})});
  const result=await h.useCase.upload(oldId);assert.equal(result.phase,'RECONCILIATION_REQUIRED');assert.equal(result.blocked,true);
  const count=h.calls.length;await assert.rejects(h.useCase.reconcile(),/EXPLICIT_STOP/);await assert.rejects(h.useCase.upload(oldId),/BLOCKS_REPLAY/);
  assert.equal(h.calls.length,count);assert.equal(h.calls.filter(x=>x==='uploadStaticVersion').length,1);
});
test('post-dispatch cancellation cannot become success even with a zero launcher exit',async t=>{
  const h=await harness(t,{uploadStaticVersion:async()=>({kind:'outcome-unknown',error:{kind:'cancelled',code:'CANCELLED'},evidence:{exitCode:0}})});
  assert.equal((await h.useCase.upload(oldId)).phase,'RECONCILIATION_REQUIRED');
  await assert.rejects(h.useCase.promote(oldId),/EXPLICIT_STOP/);assert.equal(h.calls.includes('promoteVersion'),false);
});
test('lost upload outcome remains unknown and cannot be replayed or promoted',async t=>{
  const h=await harness(t,{uploadStaticVersion:async()=>{throw Error('TRANSPORT_LOST');}});
  assert.equal((await h.useCase.upload(oldId)).phase,'RECONCILIATION_REQUIRED');
  assert.match((await h.useCase.reconcile()).recovery,/No trustworthy/);
  await assert.rejects(h.useCase.promote(oldId),/UPLOAD_NOT_VERIFIED/);await assert.rejects(h.useCase.upload(oldId),/BLOCKS_REPLAY/);
});
test('actual matching normalized readback is required; passed:true cannot mint a witness',async t=>{
  const h=await harness(t,{inspectVersion:async(t,id)=>id===oldId?version(id):{passed:true}});
  await assert.rejects(h.useCase.upload(oldId),/TARGET_DRIFT/);
  assert.equal((await h.journal.read()).phase,'RECONCILIATION_REQUIRED');assert.equal(h.calls.includes('promoteVersion'),false);
});
test('metadata mismatch blocks uploaded verification',async t=>{
  const h=await harness(t,{inspectVersion:async(t,id)=>({...version(id),...(id===newId?{bindings:bindings}: {})})});
  await assert.rejects(h.useCase.upload(oldId),/UPLOADED_BINDINGS_MISMATCH/);
  await assert.rejects(h.useCase.promote(oldId),/UPLOAD_NOT_VERIFIED/);
});
test('successful upload verifies exact identity, preserved secret name, and desired settings',async t=>{
  const h=await harness(t);const uploaded=await h.useCase.upload(oldId);
  assert.equal(uploaded.phase,'UPLOAD_VERIFIED');assert.equal(uploaded.uploadedWitness.versionId,newId);assert.equal(uploaded.uploadedWitness.artifactTreeSha256,release.artifactTreeSha256);
  assert.equal(uploaded.uploadedWitness.metadata.bindings.some(b=>b.name==='JWT_SECRET'),true);
  const before=h.calls.length;const done=await h.useCase.promote(oldId);
  assert.equal(done.phase,'TRAFFIC_VERIFIED_EXTERNAL_CHECKS_REQUIRED');
  assert.deepEqual(h.calls.slice(before),['ready','inspectPrerequisites','inspectDeployment','inspectVersion','promoteVersion','inspectDeployment','inspectVersion','inspectPrerequisites']);
  assert.ok(done.externalChecksRequired.length>0);
});
test('active-version drift before promotion causes zero promotion calls',async t=>{
  const h=await harness(t);await h.useCase.upload(oldId);h.setActive(newId);
  await assert.rejects(h.useCase.promote(oldId),/CURRENT_DEPLOYMENT_DRIFT/);assert.equal(h.calls.includes('promoteVersion'),false);
});
test('wrong observed version cannot pass on a prior matching witness',async t=>{
  let wrong=false;const h=await harness(t,{inspectVersion:async(t,id)=>version(wrong?oldId:id)});await h.useCase.upload(oldId);wrong=true;
  await assert.rejects(h.useCase.promote(oldId),/VERSION_ID_MISMATCH/);assert.equal(h.calls.includes('promoteVersion'),false);
});
test('journal artifact identity drift rejects before adapter access',async t=>{
  const h=await harness(t);await h.useCase.upload(oldId);const count=h.calls.length;
  const changed=createReleaseUseCase({port:h.port,journal:h.journal,release:{...release,artifactTreeSha256:'c'.repeat(64)}});
  await assert.rejects(changed.promote(oldId),/RELEASE_DRIFT/);assert.equal(h.calls.length,count);
});
test('wrong observation target stops before upload',async t=>{
  const h=await harness(t,{inspectDeployment:async()=>({target:{...target,worker:'other'},observedAt})});
  await assert.rejects(h.useCase.upload(oldId),/TARGET_DRIFT/);assert.equal(h.calls.includes('uploadStaticVersion'),false);
});
test('unknown promotion reconciles by observation only, with no second mutation',async t=>{
  const h=await harness(t,{promoteVersion:async()=>({kind:'outcome-unknown',error:{kind:'transient',code:'TIMEOUT'}})});await h.useCase.upload(oldId);
  assert.equal((await h.useCase.promote(oldId)).phase,'RECONCILIATION_REQUIRED');await assert.rejects(h.useCase.promote(oldId),/UPLOAD_NOT_VERIFIED/);
  h.setActive(newId);assert.equal((await h.useCase.reconcile()).phase,'TRAFFIC_VERIFIED_EXTERNAL_CHECKS_REQUIRED');
  assert.equal(h.calls.filter(x=>x==='promoteVersion').length,1);
});
test('truncated journal blocks replacement instead of assuming no prior operation',async t=>{
  const h=await harness(t);await h.useCase.upload(oldId);const text=await readFile(h.journal.location,'utf8');await writeFile(h.journal.location,text.slice(0,-1));
  await assert.rejects(h.useCase.upload(oldId),/JOURNAL_TRUNCATED/);
});
test('normalizer excludes secret values and hashes ordinary variable values',()=>{
  const v=normalizeVersion({id:newId,metadata:{source:'wrangler',has_preview:false},resources:{script_runtime:{compatibility_date:'2026-10-09',compatibility_flags:[],migration_tag:'v2'},bindings:[{name:'JWT_SECRET',type:'secret_text',text:'NEVER_EMIT'},{name:'AUTH_ORIGIN',type:'plain_text',text:'https://example.test'}]}},observedAt,target);
  assert.equal(JSON.stringify(v).includes('NEVER_EMIT'),false);assert.equal(JSON.stringify(v).includes('https://example.test'),false);
});
test('a witness for another artifact cannot be promoted or silently replaced',async t=>{
  const h=await harness(t);const state=await h.useCase.upload(oldId);
  await h.journal.append({...state,uploadedWitness:{...state.uploadedWitness,artifactTreeSha256:'d'.repeat(64)}});
  const count=h.calls.length;await assert.rejects(h.useCase.promote(oldId),/UPLOAD_WITNESS_IDENTITY_MISMATCH/);assert.equal(h.calls.length,count);
});

test('missing live prerequisite evidence cannot be replaced with a passed flag',async t=>{
  const h=await harness(t,{inspectPrerequisites:async()=>({passed:true})});
  await assert.rejects(h.useCase.upload(oldId),/TARGET_DRIFT/);assert.equal(h.calls.includes('uploadStaticVersion'),false);assert.equal(await h.journal.read(),null);
});
test('version metadata cannot substitute for the cancelled exact service projection',async t=>{
  const h=await harness(t,{inspectPrerequisites:async(t,id)=>({target,observedAt:new Date().toISOString(),currentVersion:id,database:{id:'approved-db',migrationNames:prerequisitePolicy.migrationNames},gate:prerequisitePolicy.gate,security:prerequisitePolicy.security,service:{projection:'version.resources.script',origin:'wrangler',tags:[],migrationTag:'v2',hasPreview:false}})});
  await assert.rejects(h.useCase.upload(oldId),/EXACT_SERVICE_PREREQUISITE_MISSING/);assert.equal(h.calls.includes('uploadStaticVersion'),false);
});

test('historical prerequisite records cannot stand in for a current permitted read',async t=>{
  const h=await harness(t,{inspectPrerequisites:async(t,id)=>({target,observedAt:'2026-10-12T08:20:21.362Z',currentVersion:id})});
  await assert.rejects(h.useCase.upload(oldId),/STALE_OR_FUTURE_OBSERVATION/);assert.equal(h.calls.includes('uploadStaticVersion'),false);
});

test('one release identity rule accepts modular tags and rejects stale architecture tags before adapter access',()=>{
  const r={releaseId:'projektor-modular-20261012',artifactTreeSha256:'a'.repeat(64),uploadTag:'projektor-modular-20261012-aaaaaaaaaaaa'};
  assert.doesNotThrow(()=>assertReleaseIdentity(r));
  assert.throws(()=>assertReleaseIdentity({...r,uploadTag:'projektor-architecture-20261012-aaaaaaaaaaaa'}),/RELEASE_UPLOAD_TAG_MISMATCH/);
  assert.throws(()=>assertReleaseIdentity({...r,releaseId:'projektor-architecture-20261012'}),/RELEASE_ID_MISMATCH/);
});

test('active-version changes during baseline inspection stop before the mutation intent',async t=>{
  let h;h=await harness(t,{inspectVersion:async(t,id)=>{h.setActive(newId);return version(id);}});
  await assert.rejects(h.useCase.upload(oldId),/CURRENT_DEPLOYMENT_DRIFT/);
  assert.equal(h.calls.includes('uploadStaticVersion'),false);assert.equal(await h.journal.read(),null);
});
