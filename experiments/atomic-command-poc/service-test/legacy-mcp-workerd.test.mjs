import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Miniflare} from 'miniflare';
import {denyOutbound} from '../test-support/offline.mjs';
let mf;
before(async()=>{mf=new Miniflare({cf:false,fetchMock:denyOutbound(),modules:true,scriptPath:new URL('./legacy-mcp-fixture.mjs',import.meta.url).pathname,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],modulesRules:[{type:'Text',include:['**/*.sql'],fallthrough:true}],durableObjects:{WORKSPACE:{className:'LegacyMCPFixture',useSQLite:true}}});await mf.ready;});
after(async()=>{await mf?.dispose();});
function fixture(){const object=randomUUID();const call=async(action,...args)=>{const response=await mf.dispatchFetch('https://fixture.invalid',{method:'POST',body:JSON.stringify({object,action,args})});return response.json();};return {snapshot:()=>call('snapshot'),invoke:(...args)=>call('invoke',...args)};}
const create=f=>f.invoke('create_issue',{projectId:'TEST',title:'source',body:'body',status:'backlog'});
test('real workerd derives omitted legacy create status from verified preserved metadata',async()=>{
 const f=fixture(),created=await f.invoke('create_issue',{projectId:'TEST',title:'source default'});assert.ok(created.data?.id,JSON.stringify(created));const result=await f.invoke('get_issue',{id:created.data.id});assert.equal(result.data.status,'backlog');assert.equal((await f.snapshot()).issue_queue[0].status_category,'backlog');
});
test('real workerd nested transactionSync rolls back all prior fields on domain rejection',async()=>{
 const f=fixture(),created=await create(f);assert.ok(created.data?.id,JSON.stringify(created));const before=await f.snapshot();const denied=await f.invoke('update_issue',{id:created.data.id,title:'must not survive',assigneeId:randomUUID()});assert.equal(denied.error.code,'ASSIGNEE_INVALID');assert.deepEqual(await f.snapshot(),before);
});
test('real workerd fault after second core receipt rolls back both commands and every projection',async()=>{
 const f=fixture(),created=await create(f),before=await f.snapshot();const failed=await f.invoke('update_issue',{id:created.data.id,title:'new title',body:'new body'},{faultOnReceipt:2});assert.equal(failed.error.code,'TRANSPORT_UNKNOWN');assert.equal(failed.attemptOutcome,'not_committed');assert.deepEqual(await f.snapshot(),before);
 const retry=await f.invoke('update_issue',{id:created.data.id,title:'new title',body:'new body'});assert.equal(retry.data.ok,true);const after=await f.snapshot();assert.equal(after.operation.length,before.operation.length+2);assert.equal(after.issue[0].version,before.issue[0].version+2);assert.equal(after.activity.length,before.activity.length+2);assert.equal(after.outbox.length,before.outbox.length+2);
});
test('real workerd fresh legacy invocations serialize as last-write-wins and do not dedupe creates',async()=>{
 const f=fixture(),created=await create(f);const writes=await Promise.all(['one','two'].map(title=>f.invoke('update_issue',{id:created.data.id,title})));assert.ok(writes.every(x=>x.data?.ok));const snapshot=await f.snapshot();assert.equal(snapshot.issue[0].version,3);assert.equal(snapshot.operation.length,3);
 const repeated=await Promise.all([1,2].map(()=>f.invoke('add_comment',{issueId:created.data.id,body:'same payload'})));assert.notEqual(repeated[0].data.id,repeated[1].data.id);assert.equal((await f.snapshot()).issue_entry.length,2);
});
test('real workerd response loss stays unknown and legacy create retry can duplicate',async()=>{
 const f=fixture();const args={projectId:'TEST',title:'lost response',status:'backlog'};const lost=await f.invoke('create_issue',args,{dropResponse:true});assert.equal(lost.error.outcome,'unknown');const retry=await f.invoke('create_issue',args);assert.ok(retry.data?.id);assert.equal((await f.snapshot()).issue.length,2);
});
