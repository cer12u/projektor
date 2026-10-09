// Independent review counterexamples retained as publication regressions.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {MachineWorkflowClient} from '../client/agent-workflow.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(){
 let time=0,sent=[];const runtime=randomUUID(),context={workspaceId:randomUUID(),workspaceEpoch:randomUUID(),principalId:randomUUID(),issueId:randomUUID()},saved=new Map();
 const claim={live:true,workspaceEpoch:context.workspaceEpoch,principalId:context.principalId,runtimeInstanceId:runtime,attemptId:randomUUID(),claimId:randomUUID(),fencingToken:'1',leaseExpiresAt:300000};
 const profile={data:{profile:'projektor-machine-v1',schemaVersions:[1],hashVersion:'command-json-v1',...context,commands:{'Issue.AppendProgress':{payloadVersion:2}},features:{'claim-runtime-binding-v1':true,'fenced-progress-v1':true}}};
 const transport={async command(c){sent.push(structuredClone(c));return {data:{outcome:'committed',effectApplied:true,entityId:context.issueId,committedVersion:2,commitSeq:2,serverTime:1},meta:{workspaceId:context.workspaceId,actorId:context.principalId,operationId:c.operationId}};},async query(name){if(name==='capabilities_get')return profile;if(name==='claim_get')return {data:{claim,serverTime:0,currentWriteAllowed:true}};if(name==='attempt_checkpoint_get')return {data:{blocked:false,effects:[]}};if(name==='issue_get')return {data:{id:context.issueId,status:'in_progress'}};return {data:{outcome:'not_observed'}};}};
 const journal={async listUnresolved(){return [...saved.values()].filter(r=>!['committed','rejected'].includes(r.state));},async load(id){return structuredClone(saved.get(id));},async save(r){saved.set(r.envelope.operationId,structuredClone(r));}};
 const client=new MachineWorkflowClient({transport,journal,runtimeInstanceId:runtime,monotonicNow:()=>time});
 const command=()=>({schemaVersion:1,workspaceId:context.workspaceId,workspaceEpoch:context.workspaceEpoch,operationId:randomUUID(),commandType:'Issue.AppendProgress',entityId:context.issueId,expectedVersion:1,payload:{payloadVersion:2,entryId:randomUUID(),bodyMarkdown:'original',claim:Object.fromEntries(['claimId','fencingToken','runtimeInstanceId','attemptId'].map(k=>[k,claim[k]]))}});
 return {client,transport,journal,saved,context,claim,profile,runtime,command,sent,advance:t=>time=t};
}
test('partial or mismatched mutation receipts stay unknown, never committed',async()=>{
 for(const response of [{},{data:{}},{data:{outcome:'committed'}},{data:{outcome:'committed',effectApplied:true,entityId:randomUUID(),committedVersion:2,commitSeq:1,serverTime:0},meta:{operationId:randomUUID(),workspaceId:randomUUID(),actorId:randomUUID()}}]){
  const f=fixture();await f.client.revalidate(f.context);f.transport.command=async()=>response;const c=f.command();await f.client.submit(c).catch(()=>{});
  assert.equal(f.saved.get(c.operationId)?.state,'unknown',JSON.stringify(response));assert.equal(f.client.mayStartAuthorizedWork(true),false);
 }
});
test('pause during delayed revalidation cannot be undone by a stale success',async()=>{
 const f=fixture(),gate=deferred(),query=f.transport.query;f.transport.query=async(name,...rest)=>name==='capabilities_get'?gate.promise:query(name,...rest);
 const pending=f.client.revalidate(f.context).catch(()=>{});f.client.pause();gate.resolve(f.profile);await pending;
 assert.equal(f.client.mayStartAuthorizedWork(true),false);
});
test('later failed revalidation wins over earlier delayed success',async()=>{
 const f=fixture(),gate=deferred(),query=f.transport.query;let profiles=0;f.transport.query=async(name,...rest)=>{if(name==='capabilities_get'){if(++profiles===1)return gate.promise;throw Error('revoked');}return query(name,...rest);};
 const old=f.client.revalidate(f.context).catch(()=>{});await assert.rejects(f.client.revalidate(f.context),/revoked/);gate.resolve(f.profile);await old;
 assert.equal(f.client.mayStartAuthorizedWork(true),false);
});
test('prepared immutable envelope equals dispatch after caller mutates the input',async()=>{
 const f=fixture(),started=deferred(),gate=deferred(),save=f.journal.save;await f.client.revalidate(f.context);f.journal.save=async r=>{await save(r);if(r.state==='prepared'){started.resolve();await gate.promise;}};
 const c=f.command(),pending=f.client.submit(c);await started.promise;c.payload.bodyMarkdown='mutated';gate.resolve();await pending;
 assert.equal(f.sent[0].payload.bodyMarkdown,'original');assert.equal(f.saved.get(c.operationId).envelope.payload.bodyMarkdown,'original');
});
test('delayed journal completion cannot dispatch beyond the validated safe lease',async()=>{
 const f=fixture(),started=deferred(),gate=deferred(),save=f.journal.save;await f.client.revalidate(f.context);f.journal.save=async r=>{await save(r);if(r.state==='prepared'){started.resolve();await gate.promise;}};
 const pending=f.client.submit(f.command()).catch(()=>{});await started.promise;f.advance(300000);gate.resolve();await pending;assert.equal(f.sent.length,0);
});
test('claim acquisition cannot attribute a new command to another runtime incarnation',async()=>{
 const f=fixture(),c=f.command();c.commandType='Issue.Claim';c.payload={payloadVersion:1,attemptId:randomUUID(),runtimeInstanceId:randomUUID(),agentDefinition:{id:'other',revision:'1'},expectedClaimVersion:0};
 await f.client.submit(c).catch(()=>{});assert.equal(f.sent.length,0);
});
