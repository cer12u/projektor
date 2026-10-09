// Actual app-auth HTTP/session/key boundary and the real browser DraftVault.key.
// IndexedDB and browser interactions remain covered by the unchanged CI scenarios.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createAppAuth,createPairing} from '../src/app-auth.mjs';
import {createSessionAPI} from '../vendor/session-ports/client.mjs';
import {DraftVault} from '../vendor/browser/draft-vault.mjs';
const core=resolve(process.env.PROJEKTOR_CORE_SOURCE??resolve(import.meta.dirname,'../../atomic-command-poc'));
const {startAppAuthHarness}=await import(pathToFileURL(resolve(core,'browser-test/app-auth-server.mjs')));
test('later same-family draft key is capped to the verified editor lease, including a shorter cached lease',async t=>{
 const h=await startAppAuthHarness();t.after(()=>h.close());const jar=new Map();
 const fetchImpl=async(url,init)=>{const response=await h.fetch(url,{...init,headers:{...init.headers,cookie:[...jar].map(([name,value])=>name+'='+value).join(';'),...(init.method==='POST'?{origin:h.base,'sec-fetch-site':'same-origin'}:{})}});for(const line of response.headers.getSetCookie()){const[name,...parts]=line.split(';')[0].split('=');jar.set(name,parts.join('='));}return response;};
 const auth=createAppAuth({baseUrl:h.base,fetchImpl}),pair=await createPairing('enroll');await h.approveGrant({grantId:pair.grantId,fingerprint:pair.fingerprint,purpose:pair.purpose});await auth.completeGrant(pair,'synthetic draft lease boundary password',randomUUID());await auth.login('synthetic draft lease boundary password');
 const api=createSessionAPI({baseUrl:h.base,fetchImpl}),session=await api.session({workspaceId:h.ids.workspace}),binding={principalId:session.principalId,workspaceId:session.workspaceId,workspaceEpoch:session.workspaceEpoch,resourceType:'issue',resourceId:h.ids.issue,editorId:'content',projectAtProtection:h.ids.project,draftId:randomUUID()};
 // The next real HTTP request occurs after the previously verified lease was read.
 await new Promise(resolve=>setTimeout(resolve,5));let response,reads=0;const vault=new DraftVault({keyProvider:async(...args)=>{reads++;response=await api.keyProvider(...args);return response;}});
 const key=await vault.key(binding,null,session,{fresh:true});assert.equal(response.session.sessionId,session.sessionId);assert.ok(response.leaseExpiresAt>session.expiresAt);assert.equal(key.leaseExpiresAt,session.expiresAt);assert.equal(key.key.extractable,false);
 const earlier={...session,expiresAt:session.expiresAt-1000},cached=await vault.key(binding,key.keyId,earlier);assert.equal(reads,1);assert.equal(cached.leaseExpiresAt,earlier.expiresAt);await assert.rejects(vault.key(binding,key.keyId,{...session,expiresAt:Date.now()-1}),/KEY_LEASE_EXPIRED/);
 const foreign=new DraftVault({keyProvider:async()=>({...response,session:{...response.session,sessionId:randomUUID()}})});await assert.rejects(foreign.key(binding,response.keyId,session,{fresh:true}),/KEY_SESSION_CHANGED/);
 const oversized=new DraftVault({keyProvider:async()=>({...response,leaseExpiresAt:Date.now()+600000})});await assert.rejects(oversized.key(binding,response.keyId,session,{fresh:true}),/INVALID_KEY_LEASE/);
});
