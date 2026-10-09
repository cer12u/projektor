// Exact UI client -> HTTP entry -> workerd/Store/KDF wire contract.
// No Chromium or browser cookie-policy/DraftVault claim is made by this test.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createAppAuth,createPairing,needsLogin} from '../src/app-auth.mjs';
const core=resolve(process.env.PROJEKTOR_CORE_SOURCE??resolve(import.meta.dirname,'../../atomic-command-poc'));
const {startAppAuthHarness}=await import(pathToFileURL(resolve(core,'browser-test/app-auth-server.mjs')));
test('actual app-auth entry agrees on receipts, refresh, same-account family adoption and logout',async t=>{
 const h=await startAppAuthHarness();t.after(()=>h.close());const jar=new Map(),calls=[];let loseLogin=true;
 const fetchImpl=async(url,options)=>{
  const path=new URL(url).pathname;calls.push(path);
  const response=await h.fetch(url.toString(),{...options,headers:{...options.headers,cookie:[...jar].map(([key,value])=>key+'='+value).join(';'),...(options.method==='POST'?{origin:h.base,'sec-fetch-site':'same-origin'}:{})}});
  if(path==='/v1/auth/login'&&loseLogin){loseLogin=false;assert.equal(response.status,200);throw Error('synthetic lost reply including Set-Cookie');}
  for(const cookie of response.headers.getSetCookie()){assert.match(cookie,/HttpOnly; Secure; SameSite=Strict/);const [name,...parts]=cookie.split(';')[0].split('=');if(/Max-Age=0(?:;|$)/.test(cookie))jar.delete(name);else jar.set(name,parts.join('='));}return response;
 };
 const auth=createAppAuth({baseUrl:h.base,fetchImpl});
 const pair=await createPairing('enroll');assert.equal((await auth.grantStatus(pair)).state,'pending');await h.approveGrant({grantId:pair.grantId,fingerprint:pair.fingerprint,purpose:pair.purpose});assert.equal((await auth.grantStatus(pair)).purpose,'enroll');
 const operationId=randomUUID(),receipt=await auth.completeGrant(pair,'synthetic browser password 日本語',operationId);assert.equal(receipt.loginRequired,true);assert.deepEqual(await auth.grantReceipt(pair,operationId),receipt);assert.equal((await h.control('inspect')).sessions,0);
 const logged=await auth.login('synthetic browser password 日本語');assert.equal(logged.principalId,h.ids.actor);assert.equal(calls.filter(path=>path==='/v1/auth/login').length,1);assert.equal(calls.filter(path=>path==='/v1/auth/login-receipt').length,1);assert.equal((await h.control('inspect')).sessions,1);
 const issueResponse=await fetchImpl(h.base+'/v1/workspaces/'+h.ids.workspace+'/issues/'+h.ids.issue+'?workspaceEpoch='+h.ids.epoch,{method:'GET'});assert.equal(issueResponse.status,200);const issue=(await issueResponse.json()).data;assert.equal(issue.description,'Synthetic editable content');assert.equal(issue.priority,'P1');assert.equal(issue.assigneeId,h.ids.actor);assert.equal(typeof issue.bodyRevisionId,'string');
 const refreshed=await auth.restore({refresh:true});assert.equal(refreshed.sessionId,logged.sessionId);assert.equal(refreshed.absoluteExpiresAt,logged.absoluteExpiresAt);assert.ok(jar.has('__Host-projektor_session'));
 // A second browser tab performs an explicit legitimate login using the same
 // HttpOnly cookie jar. The first client must adopt it without submitting a password.
 const peer=createAppAuth({baseUrl:h.base,fetchImpl}),newFamily=await peer.login('synthetic browser password 日本語');assert.notEqual(newFamily.sessionId,refreshed.sessionId);
 const passwordSubmissions=calls.filter(path=>path==='/v1/auth/login').length,adopted=await auth.restore({refresh:true});assert.equal(adopted.sessionId,newFamily.sessionId);assert.equal(adopted.principalId,refreshed.principalId);assert.equal(adopted.authVersion,refreshed.authVersion);assert.equal(adopted.absoluteExpiresAt,newFamily.absoluteExpiresAt);assert.equal(calls.filter(path=>path==='/v1/auth/login').length,passwordSubmissions);assert.equal((await h.control('inspect')).sessions,2);
 await auth.logout();assert.equal(jar.has('__Host-projektor_session'),false);await assert.rejects(auth.restore(),error=>needsLogin(error.code));
});
