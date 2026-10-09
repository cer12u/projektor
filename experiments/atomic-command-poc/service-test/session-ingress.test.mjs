import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {startHarness} from '../browser-test/session-server.mjs';
import {createSessionAPI} from '../session-ports/client.mjs';
import {DraftVault} from '../browser/draft-vault.mjs';
async function setup(t){const h=await startHarness();t.after(()=>h.close());let cookie;const context={addCookies:async([c])=>{cookie=c.name+'='+c.value;}};await h.login(context);const fetchImpl=(url,init={})=>fetch(url,{...init,headers:{...Object.fromEntries(new Headers(init.headers)),cookie,origin:h.base}});const api=createSessionAPI({baseUrl:h.base,fetchImpl});return {h,context,api,fetchImpl};}
test('actual service bootstrap 0/1/multi and selected Stores retain independent identities',async t=>{
 const {h,api,fetchImpl}=await setup(t);let b=await api.bootstrap();assert.equal(b.workspaces.length,1);assert.equal(b.principalId,h.ids.actorA);
 await h.setBootstrapMode('multi');b=await api.bootstrap();assert.equal(b.workspaces.length,2);assert.equal(b.principalId,null);
 const second=await api.session({workspaceId:h.ids.secondWorkspace});assert.equal(second.principalId,h.ids.secondActorA);assert.notEqual(second.principalId,h.ids.actorA);
 const first=await api.session({workspaceId:h.ids.workspace});assert.equal(first.principalId,h.ids.actorA);
 await h.setBootstrapMode('zero');assert.equal((await api.bootstrap()).workspaces.length,0);await assert.rejects(api.session({workspaceId:h.ids.workspace}));
 await h.setBootstrapMode('one');await h.control('sql','DELETE FROM identity_binding');b=await api.bootstrap();assert.equal(b.workspaces.length,0);assert.equal((await h.control('sql','SELECT count(*) AS n FROM membership'))[0].n,2);
 assert.equal((await fetchImpl(h.base+'/v1/session')).status,400);
});
test('actual key port uses same credential-bound Store and DraftVault key/crypto recovery',async t=>{
 const {h,api}=await setup(t),session=await api.session({workspaceId:h.ids.workspace});
 const binding={principalId:session.principalId,workspaceId:session.workspaceId,workspaceEpoch:session.workspaceEpoch,resourceType:'issue',resourceId:h.ids.issue,editorId:'content',projectAtProtection:h.ids.project,draftId:randomUUID()};
 const vault=new DraftVault({keyProvider:api.keyProvider}),key=await vault.key(binding,undefined,session),nonce=crypto.getRandomValues(new Uint8Array(12)),plain=new TextEncoder().encode('same Store protected draft');
 const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce},key.key,plain);vault.clearKeys();const recovered=await vault.key(binding,key.keyId,session,{fresh:true});assert.equal(recovered.keyId,key.keyId);assert.equal(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:nonce},recovered.key,cipher)),'same Store protected draft');assert.equal((await h.control('inspect')).draft_key,1);
 await assert.rejects(api.keyProvider({...binding,principalId:randomUUID()},key.keyId));await assert.rejects(api.keyProvider(binding,randomUUID()));assert.equal((await h.control('inspect')).draft_key,1);
 await h.control('moveResource');assert.equal((await api.keyProvider(binding,key.keyId)).keyId,key.keyId);await h.control('revokeOriginalProject');await assert.rejects(api.keyProvider(binding,key.keyId));assert.equal((await h.control('inspect')).draft_key,1);
});
test('session rechecks current scopes and refuses caller actor/current credential revocation',async t=>{
 const {h,api,fetchImpl}=await setup(t),first=await api.session({workspaceId:h.ids.workspace});await h.control('sql','DELETE FROM principal_scope WHERE scope=?',['issue:write']);const next=await api.session({workspaceId:h.ids.workspace});assert.ok(next.authzVersion>first.authzVersion);assert.ok(!next.scopes.includes('issue:write'));
 const response=await fetchImpl(h.base+'/v1/draft-keys',{method:'POST',headers:{'content-type':'application/json','x-projektor-csrf':'same-origin'},body:JSON.stringify({actor:{principalId:h.ids.actorA},binding:{}})});assert.equal(response.status,400);
 await h.control('revokeCredential');await assert.rejects(api.session({workspaceId:h.ids.workspace}));assert.equal((await api.bootstrap()).workspaces.length,0);
});
test('fresh binding original scope mismatch and revoked keys never mint replacements',async t=>{
 const {h,api}=await setup(t),s=await api.session({workspaceId:h.ids.workspace}),binding={principalId:s.principalId,workspaceId:s.workspaceId,workspaceEpoch:s.workspaceEpoch,resourceType:'issue',resourceId:h.ids.issue,editorId:'content',projectAtProtection:h.ids.project,draftId:randomUUID()};
 await assert.rejects(api.keyProvider({...binding,projectAtProtection:h.ids.otherProject}));assert.equal((await h.control('inspect')).draft_key,0);const key=await api.keyProvider(binding);await h.control('revokeKey',key.keyId);await assert.rejects(api.keyProvider(binding));await assert.rejects(api.keyProvider(binding,key.keyId));assert.equal((await h.control('inspect')).draft_key,1);
});
test('session/key and actual command/receipt share one Store without replacement transaction API',async t=>{
 const {h,api,fetchImpl}=await setup(t),s=await api.session({workspaceId:h.ids.workspace});
 const command={schemaVersion:1,workspaceId:s.workspaceId,workspaceEpoch:s.workspaceEpoch,operationId:randomUUID(),commandType:'Issue.UpdateTitle',entityId:h.ids.issue,expectedVersion:7,payload:{title:'same Store commit'}};
 const url=h.base+`/v1/workspaces/${s.workspaceId}/commands`,init={method:'POST',headers:{'content-type':'application/json','x-projektor-csrf':'same-origin','idempotency-key':command.operationId},body:JSON.stringify(command)};
 const r=await fetchImpl(url,init);assert.equal(r.status,200);const result=await r.json();assert.deepEqual(await (await fetchImpl(url,init)).json(),result);
 assert.deepEqual(await (await fetchImpl(h.base+`/v1/workspaces/${s.workspaceId}/operations/${command.operationId}?workspaceEpoch=${s.workspaceEpoch}`)).json(),result);
 const state=await h.control('inspect');assert.equal(state.issue.title,'same Store commit');assert.equal(state.issue.version,8);for(const table of ['activity','outbox','operation'])assert.equal(state[table],1);
 assert.equal((await api.session({workspaceId:s.workspaceId})).sessionId,s.sessionId);
});
