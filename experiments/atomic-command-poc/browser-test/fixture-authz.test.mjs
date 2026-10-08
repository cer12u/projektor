import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {startHarness} from './server.mjs';
async function fixture(t) {
 const h=await startHarness();t.after(()=>h.close());
 const context={cookies:[],async addCookies(c){this.cookies=c;}};
 const login=await h.login(context,'A');
 const headers=()=>({cookie:context.cookies.map(c=>`${c.name}=${c.value}`).join('; '),origin:h.base,'x-projektor-csrf':'same-origin','content-type':'application/json'});
 const binding={principalId:h.ids.actorA,workspaceId:h.ids.workspace,workspaceEpoch:h.ids.epoch,resourceType:'issue',resourceId:h.ids.issue,editorId:'title',projectAtProtection:h.ids.project,draftId:randomUUID()};
 async function key(input={binding},extra={}){const r=await fetch(h.base+'/v1/draft-keys',{method:'POST',headers:{...headers(),...extra},body:JSON.stringify(input)});return {status:r.status,body:await r.json()};}
 return {h,context,login,headers,binding,key};
}
test('signed HttpOnly session and private controls; key lease is bounded and stable across renewal',async t=>{
 const f=await fixture(t);assert.equal(f.context.cookies[0].httpOnly,true);
 const s=await fetch(f.h.base+'/v1/session',{headers:f.headers()});assert.equal(s.status,200);assert.equal(s.headers.get('cache-control'),'no-store');const session=await s.json();assert.equal(session.principalId,f.h.ids.actorA);
 const k=await f.key();assert.equal(k.status,200);assert.equal(Buffer.from(k.body.key,'base64').length,32);assert.ok(k.body.leaseExpiresAt<=session.expiresAt);assert.ok(k.body.leaseExpiresAt<=Date.now()+300000);
 const renewed=await f.h.login(f.context,'A',{renew:true,ttlSeconds:900});assert.equal(renewed.sessionId,f.login.sessionId);const k2=await f.key({binding:f.binding,keyId:k.body.keyId});assert.equal(k2.body.key,k.body.key);assert.equal(k2.body.keyId,k.body.keyId);
 for(const path of ['/sql','/__test/control','/__test/login/A','/browser-test/server.mjs','/browser/%2e%2e/browser-test/server.mjs'])assert.equal((await fetch(f.h.base+path)).status,404);
 assert.equal((await fetch(f.h.base+'/v1/session')).status,401);assert.equal((await f.key({binding:f.binding},{origin:'https://evil.invalid'})).status,403);assert.equal((await f.key({binding:f.binding},{'x-projektor-csrf':''})).status,403);
});
test('key binding rejects actor/workspace/epoch/resource/editor/project/draft substitutions',async t=>{
 const f=await fixture(t),k=await f.key();assert.equal(k.status,200);
 for(const field of ['principalId','workspaceId','workspaceEpoch','resourceId','projectAtProtection','draftId']){const changed={...f.binding,[field]:randomUUID()};assert.ok((await f.key({binding:changed,keyId:k.body.keyId})).status>=400,field);}
 assert.equal((await f.key({binding:{...f.binding,editorId:'body'},keyId:k.body.keyId})).status,400);
 await f.h.login(f.context,'B');assert.equal((await f.key({binding:f.binding,keyId:k.body.keyId})).status,403);assert.equal((await f.key({binding:{...f.binding,principalId:f.h.ids.actorB},keyId:k.body.keyId})).status,403);
});
test('current and original project grant are independently required after resource move',async t=>{
 const f=await fixture(t),k=await f.key();assert.equal(k.status,200);await f.h.control('moveResource');assert.equal((await f.key({binding:f.binding,keyId:k.body.keyId})).status,200);
 await f.h.control('revokeOriginalProject');assert.equal((await f.key({binding:f.binding,keyId:k.body.keyId})).status,403);await f.h.control('grantProject','A',f.h.ids.project);
 await f.h.control('revokeCurrentProject');assert.equal((await f.key({binding:f.binding,keyId:k.body.keyId})).status,403);await f.h.control('grantProject','A',f.h.ids.otherProject);
 assert.equal((await f.key({binding:{...f.binding,draftId:randomUUID()}})).status,403);assert.equal((await f.key({binding:{...f.binding,projectAtProtection:f.h.ids.otherProject,draftId:randomUUID()}})).status,200);
 await f.h.control('deleteResource');assert.equal((await f.key({binding:f.binding,keyId:k.body.keyId})).status,404);
});
test('logout tombstone rejects old cookie, old renewal, and old command; fresh same-principal login restores old key',async t=>{
 const f=await fixture(t),k=await f.key(),oldHeaders=f.headers();
 const out=await fetch(f.h.base+'/v1/logout',{method:'POST',headers:oldHeaders});assert.equal(out.status,200);assert.match(out.headers.get('set-cookie'),/HttpOnly/);
 assert.equal((await fetch(f.h.base+'/v1/session',{headers:oldHeaders})).status,401);assert.equal((await f.key({binding:f.binding,keyId:k.body.keyId})).status,401);await assert.rejects(f.h.login(f.context,'A',{renew:true}),/SESSION_TOMBSTONED/);
 const c={schemaVersion:1,workspaceId:f.h.ids.workspace,workspaceEpoch:f.h.ids.epoch,operationId:randomUUID(),commandType:'Issue.UpdateTitle',entityId:f.h.ids.issue,expectedVersion:7,payload:{title:'blocked'}};
 assert.equal((await fetch(`${f.h.base}/v1/workspaces/${f.h.ids.workspace}/commands`,{method:'POST',headers:{...oldHeaders,'idempotency-key':c.operationId},body:JSON.stringify(c)})).status,403);assert.equal((await f.h.control('effects')).operation,0);
 const next=await f.h.login(f.context,'A');assert.notEqual(next.sessionId,f.login.sessionId);assert.equal((await f.key({binding:f.binding,keyId:k.body.keyId})).body.key,k.body.key);
});
test('DB expiry and membership revocation block key access without issuing new key',async t=>{
 const f=await fixture(t);await f.h.control('expire');assert.equal((await f.key()).status,401);await assert.rejects(f.h.login(f.context,'A',{renew:true}),/SESSION_EXPIRED/);await f.h.login(f.context,'A');assert.equal((await f.key()).status,200);await f.h.control('revokeMembership');assert.equal((await f.key()).status,403);assert.equal((await f.h.control('effects')).draft_key,1);
});
test('real command still commits exactly once and postcommit response loss is recoverable',async t=>{
 const f=await fixture(t),c={schemaVersion:1,workspaceId:f.h.ids.workspace,workspaceEpoch:f.h.ids.epoch,operationId:randomUUID(),commandType:'Issue.UpdateTitle',entityId:f.h.ids.issue,expectedVersion:7,payload:{title:'once'}};
 const send=()=>fetch(`${f.h.base}/v1/workspaces/${f.h.ids.workspace}/commands`,{method:'POST',headers:{...f.headers(),'idempotency-key':c.operationId},body:JSON.stringify(c)});
 assert.equal((await send()).status,200);assert.equal((await send()).status,200);assert.equal((await f.h.control('effects')).operation,1);
 c.operationId=randomUUID();c.expectedVersion=8;c.payload.title='TEST_ONLY_DROP_AFTER_COMMIT';assert.equal((await send()).status,503);
 const r=await fetch(`${f.h.base}/v1/workspaces/${f.h.ids.workspace}/operations/${c.operationId}?workspaceEpoch=${f.h.ids.epoch}`,{headers:f.headers()});assert.equal(r.status,200);assert.equal((await r.json()).data.outcome,'committed');assert.equal((await f.h.control('effects')).operation,2);
});
test('legacy browser fixture serves the exact Issue client policy dependency while keeping other source private',async t=>{
 const h=await startHarness();t.after(()=>h.close());const {readFile}=await import('node:fs/promises');
 for(const path of ['client/recovery.mjs','client/issue-content.mjs','client/access-policy.mjs']){
  const r=await fetch(h.base+'/'+path);assert.equal(r.status,200,path);assert.match(r.headers.get('content-type'),/^text\/javascript/);assert.match(r.headers.get('cache-control'),/no-store/);assert.equal(r.headers.get('x-content-type-options'),'nosniff');assert.equal(await r.text(),await readFile(new URL('../'+path,import.meta.url),'utf8'));
 }
 assert.equal((await fetch(h.base+'/client/access-policy.mjs',{method:'POST'})).status,405);
 const head=await fetch(h.base+'/client/access-policy.mjs',{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
 for(const path of ['/client/agent-workflow.mjs','/client/unknown.mjs','/src/resource-policy.mjs','/src/schema.sql','/client/%2e%2e/src/schema.sql'])assert.equal((await fetch(h.base+path)).status,404,path);
});
