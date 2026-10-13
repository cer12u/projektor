// Deterministic IndexedDB-emulator integration. Actual Chromium H01 remains the
// browser acceptance test; these checks exercise the real controller and vault.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {HumanWorkflowController} from '../vendor/session-ports/human-workflow.mjs';
import {createContentProtection} from '../vendor/session-ports/client.mjs';
const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;

function fixture(t){
 const prior=globalThis.indexedDB;globalThis.indexedDB=new IDBFactory();t.after(()=>{globalThis.indexedDB=prior;});
 let family=id(5),barrier=null,arrivals=0,release,reached;
 const controllers=[],protections=[],reads={session:0,key:0,issue:0},issue={id:id(6),project_id:id(7),version:1,title:'Issue',description:'Server body',priority:null,assigneeId:null,status:'ready'};
 const session=()=>({principalId:id(1),workspaceId:id(2),workspaceEpoch:id(3),sessionId:family,actorKind:'human',authzVersion:1,expiresAt:Date.now()+60000,scopes:['issue:read','issue:write','operations:read_own']});
 const wrap=data=>({data:structuredClone(data),meta:{workspaceId:id(2),workspaceEpoch:id(3),actorId:id(1)}});
 const api={session:async()=>{reads.session++;return session();},issue:async()=>{reads.issue++;return wrap(issue);},entries:async()=>{if(barrier){arrivals++;if(arrivals===2)reached();await barrier;}return wrap({items:[]});},transport:{submit:()=>{throw Error('UNEXPECTED_COMMAND');}}};
 function tab(){
  let c;const protection=createContentProtection({api,issueId:issue.id,draftId:id(8),projectAtProtection:issue.project_id,dbName:'draft-revalidation',dirty:()=>c.protectionState!=='protected',keyProvider:async()=>{reads.key++;return {keyId:'fixture-key',key:Buffer.alloc(32,7).toString('base64'),session:session(),leaseExpiresAt:Date.now()+60000};}});
  c=new HumanWorkflowController({api,protection,issueId:issue.id});controllers.push(c);protections.push(protection);return c;
 }
 t.after(async()=>{release?.();for(const c of controllers)c.dispose();for(const p of protections)(await p.vault.db()).close();});
 return {tab,issue,reads,protections,newFamily(){family=id(9);},holdBoth(){arrivals=0;barrier=new Promise(r=>release=r);return new Promise(r=>reached=r);},release(){barrier=null;release();}};
}

async function protectedPair(t){
 const f=fixture(t),first=f.tab();assert.equal((await first.revalidate()).kind,'ready');
 first.edit({description:'Protected latest draft 日本語'});assert.equal((await first.flush()).kind,'protected');
 const second=f.tab();assert.equal((await second.revalidate()).kind,'ready');
 return {...f,first,second};
}

test('same protected draft in two tabs reauthorizes a new family without a synthetic write conflict',async t=>{
 const f=await protectedPair(t),before=await f.protections[1].vault.get(f.protections[1].binding),reads={...f.reads};
 f.newFamily();const reached=f.holdBoth(),pending=Promise.all([f.first.sessionChanged(),f.second.sessionChanged()]);await reached;f.release();
 const outcomes=await pending;
 const blocked=[f.first,f.second].find(c=>c.locked);
 if(blocked)t.diagnostic(`raced verification: ${JSON.stringify(outcomes)}; next verification: ${JSON.stringify(await blocked.revalidate())}`);
 assert.deepEqual(outcomes.map(x=>x.kind),['ready','ready']);
 for(const c of [f.first,f.second]){assert.equal(c.record.drafts.body.value.description,'Protected latest draft 日本語');assert.equal(c.protectionState,'protected');assert.equal(c.session.sessionId,id(9));}
 const after=await f.protections[0].vault.get(f.protections[0].binding);
 assert.equal(after.nonce,before.nonce,'read-only verification must not manufacture another draft head');assert.equal(after.editorRevision,before.editorRevision);
 assert.equal(f.reads.session-reads.session,2);assert.equal(f.reads.issue-reads.issue,2);assert.ok(f.reads.key-reads.key>=4,'both tabs freshly restore and unlock their authorized key');
});

test('a genuine unprotected branch still cannot adopt or overwrite the other tab head',async t=>{
 const f=await protectedPair(t);await f.first.revalidate();await f.second.revalidate();
 f.first.edit({description:'First tab unprotected branch'});clearTimeout(f.first.flushTimer);
 f.second.edit({description:'Second tab protected branch'});assert.equal((await f.second.flush()).kind,'protected');
 for(let attempt=0;attempt<2;attempt++){const result=await f.first.revalidate();assert.equal(result.kind,'locked');assert.equal(result.code,'DRAFT_WRITE_CONFLICT');}
 assert.equal(f.first.record.drafts.body.value.description,'First tab unprotected branch');assert.equal((await f.first.flush()).kind,'protection-failed');
 const stored=await f.protections[1].vault.restore(f.protections[1].binding,f.second.session,()=>true);assert.equal(stored.drafts.body.value.description,'Second tab protected branch');
});

test('changed authorized resource metadata is still protected before unlocking',async t=>{
 const f=fixture(t),c=f.tab();await c.revalidate();const p=f.protections[0],before=await p.vault.get(p.binding);
 f.issue.version=2;f.issue.description='New server body';assert.equal((await c.revalidate()).kind,'ready');
 const after=await p.vault.get(p.binding),stored=await p.vault.restore(p.binding,c.session,()=>true);
 assert.notEqual(after.nonce,before.nonce);assert.ok(after.editorRevision>before.editorRevision);assert.equal(stored.drafts.body.value.description,'New server body');assert.equal(stored.baseVersion,2);
});
