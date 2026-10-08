import { denyOutbound } from '../test-support/offline.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Miniflare } from 'miniflare';
import { MUTATION_STEPS } from '../src/shared-core.mjs';
import { command, ids } from '../test/fixture.mjs';
const persistence=mkdtempSync(join(tmpdir(),'projektor-workerd-'));
const config={cf:false,fetchMock:denyOutbound(),durableObjectsPersist:persistence,modules:true,scriptPath:new URL('./harness.mjs',import.meta.url).pathname,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],modulesRules:[{type:'Text',include:['**/*.sql'],fallthrough:true}],durableObjects:{WORKSPACE:{className:'FixtureWorkspace',useSQLite:true}}};
let mf;
before(async()=>{mf=new Miniflare(config);await mf.ready;});
after(async()=>{await mf?.dispose();rmSync(persistence,{recursive:true,force:true});});
async function call(object,action,...args){const r=await mf.dispatchFetch('http://fixture.test',{method:'POST',body:JSON.stringify({object,action,args})});return r.json();}
async function fixture(){const object=randomUUID();const runtime=await call(object,'seed');assert.equal(runtime.seeded,true);return {object,call:(action,...args)=>call(object,action,...args)};}
const lookup=c=>({workspaceId:c.workspaceId,workspaceEpoch:c.workspaceEpoch,operationId:c.operationId});
function effects(s){assert.equal(s.issue[0].version,8);assert.equal(s.workspace[0].change_seq,1);for(const t of ['activity','outbox','operation','issue_fts'])assert.equal(s[t].length,1);}
test('workerd SQLite atomically stores CAS, history, FTS, receipt and outbox',async()=>{
 const f=await fixture(),c=command();const r=await f.call('command',c);assert.equal(r.data?.outcome,'committed',JSON.stringify(r));const s=await f.call('snapshot');effects(s);assert.equal(s.issue[0].title,c.payload.title);assert.equal(s.activity[0].before_title,'original title');assert.equal(s.activity[0].after_title,c.payload.title);assert.equal(s.issue_fts[0].title,c.payload.title.normalize('NFKC').toLowerCase());assert.deepEqual(JSON.parse(s.operation[0].result_json),r);assert.equal(s.outbox[0].change_seq,s.activity[0].change_seq);
});
for(const faultAt of MUTATION_STEPS)test(`real transactionSync rollback at ${faultAt}`,async()=>{
 const f=await fixture(),c=command(),before=await f.call('snapshot');const r=await f.call('command',c,{faultAt});assert.equal(r.error?.outcome,'unknown');assert.equal(r.attemptOutcome,'not_committed');assert.equal('effectApplied' in r.error,false);assert.deepEqual(await f.call('snapshot'),before);assert.deepEqual((await f.call('lookup',lookup(c))).data,{outcome:'not_observed',absenceIsProofOfNonExecution:false});assert.equal((await f.call('command',c)).data.outcome,'committed');effects(await f.call('snapshot'));
});
test('16 concurrent HTTP deliveries through workerd RPC apply same ID once',async()=>{
 const f=await fixture(),c=command();const results=await Promise.all(Array.from({length:16},()=>f.call('command',c)));for(const r of results)assert.deepEqual(r,results[0]);assert.equal(results[0].data.outcome,'committed');effects(await f.call('snapshot'));
});
test('different IDs competing for expected version yield one winner and retained conflict',async()=>{
 const f=await fixture(),a=command(),b=command({payload:{title:'competitor'}});const r=await Promise.all([f.call('command',a),f.call('command',b)]);assert.equal(r.filter(x=>x.data?.outcome==='committed').length,1);assert.equal(r.filter(x=>x.error?.code==='VERSION_CONFLICT').length,1);const s=await f.call('snapshot');assert.equal(s.issue[0].version,8);assert.equal(s.activity.length,1);assert.equal(s.outbox.length,1);assert.equal(s.operation.length,2);
});
test('committed response loss stays unknown and retry/lookup return original receipt',async()=>{
 const f=await fixture(),c=command();const lost=await f.call('command',c,{dropResponse:true});assert.equal(lost.error.outcome,'unknown');assert.equal('effectApplied' in lost.error,false);const receipt=await f.call('lookup',lookup(c));assert.equal(receipt.data.outcome,'committed');assert.deepEqual(await f.call('command',c),receipt);effects(await f.call('snapshot'));
});
test('retry rollback does not assert original outcome was not committed',async()=>{
 const f=await fixture(),original=command();await f.call('command',original,{dropResponse:true});const r=await f.call('command',original,{faultAt:'before_authorization'});assert.equal(r.attemptOutcome,'not_committed');assert.equal(r.error.outcome,'unknown');assert.equal((await f.call('lookup',lookup(original))).data.outcome,'committed');effects(await f.call('snapshot'));
});
test('same ID with changed intent is rejected without another mutation',async()=>{
 const f=await fixture(),c=command();await f.call('command',c);assert.equal((await f.call('command',{...c,payload:{title:'other'}})).error.code,'KEY_REUSE');effects(await f.call('snapshot'));
});
test('business rejection has durable receipt and no business effect',async()=>{
 const f=await fixture(),c=command({payload:{title:'  '}}),before=await f.call('snapshot');const r=await f.call('command',c);assert.equal(r.error.code,'TITLE_EMPTY');assert.equal(r.error.outcome,'rejected');assert.deepEqual(await f.call('command',c),r);const s=await f.call('snapshot');assert.equal(s.operation.length,1);s.operation=[];assert.deepEqual(s,before);
});
test('ACL revocation conceals receipt and hash mismatch; read query conceals issue',async()=>{
 const f=await fixture(),c=command();await f.call('command',c);await f.call('sql','UPDATE project_grant SET can_read=0');for(const r of [await f.call('lookup',lookup(c)),await f.call('command',c),await f.call('command',{...c,payload:{title:'changed'}})]){assert.equal(r.error.code,'FORBIDDEN');assert.equal(r.error.outcome,'unknown');assert.equal(r.data,undefined);}assert.equal((await f.call('query',{workspaceId:ids.workspace,workspaceEpoch:ids.epoch,entityId:ids.issue})).error.code,'NOT_FOUND');
});
test('hidden and absent target yield identical non-disclosing rejection shape',async()=>{
 const f=await fixture();await f.call('sql','UPDATE project_grant SET can_read=0');const hidden=await f.call('command',command()),absent=await f.call('command',command({entityId:randomUUID()}));assert.deepEqual(hidden,absent);assert.equal(hidden.error.code,'NOT_FOUND');
});
test('loss of write only permits read-authorized receipt replay',async()=>{
 const f=await fixture(),c=command();const r=await f.call('command',c);await f.call('sql','UPDATE project_grant SET can_write=0');assert.deepEqual(await f.call('command',c),r);assert.deepEqual(await f.call('lookup',lookup(c)),r);
});
test('credential revocation blocks receipt and new mutation',async()=>{
 const f=await fixture(),c=command();await f.call('command',c);await f.call('sql','UPDATE credential SET revoked=1');assert.equal((await f.call('lookup',lookup(c))).error.code,'FORBIDDEN');assert.equal((await f.call('command',command({expectedVersion:8}))).error.code,'FORBIDDEN');effects(await f.call('snapshot'));
});

test('receipt survives clean workerd process restart and retry still has one effect',async()=>{
 const f=await fixture(),c=command();const expected=await f.call('command',c);assert.equal(expected.data.outcome,'committed');
 await mf.dispose();mf=new Miniflare(config);await mf.ready;
 assert.deepEqual(await f.call('lookup',lookup(c)),expected);assert.deepEqual(await f.call('command',c),expected);effects(await f.call('snapshot'));
});
