// Focused client-state contracts. Browser/cookie/IndexedDB acceptance is separate.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createAppAuth,createPairing,validPassword,canAdoptSession} from '../src/app-auth.mjs';
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const now=Date.now();
const current={principalId:id(1),credentialId:id(2),sessionId:id(3),authVersion:1,grantGeneration:3,expiresAt:now+1000,idleExpiresAt:now+3600000,absoluteExpiresAt:now+86400000};
const envelope=session=>({ok:true,session,csrfToken:'synthetic-csrf'});
function api(run){const calls=[];const auth=createAppAuth({baseUrl:'https://product.test',fetchImpl:async(url,options)=>{const call={path:new URL(url).pathname,...options,body:options.body?JSON.parse(options.body):undefined};calls.push(call);assert.equal(new URL(url).origin,'https://product.test');assert.equal(options.credentials,'same-origin');return run(call,calls);}});return {auth,calls};}
test('pairing fingerprint identifies raw 256-bit secret and password validation preserves Unicode',async()=>{
 const pair=await createPairing('enroll'),raw=Buffer.from(pair.secret,'base64url');assert.equal(raw.length,32);assert.equal(pair.secret.length,43);assert.equal(pair.fingerprint,createHash('sha256').update(raw).digest('hex'));assert.ok(!pair.fingerprint.includes(pair.secret));
 assert.equal(validPassword('日本語🙂'.repeat(4)),true);assert.equal(validPassword('🙂'.repeat(14)),false);assert.equal(validPassword('a'.repeat(1025)),false);assert.equal(validPassword('\ud800'.repeat(15)),false);
});
test('parallel expired-session checks perform one same-authority refresh without business replay',async()=>{
 const {auth,calls}=api(async call=>call.path.endsWith('/session')?Response.json(envelope(current)):Response.json(envelope({...current,expiresAt:now+600000})));
 const values=await Promise.all([auth.restore(),auth.restore(),auth.restore()]);assert.equal(calls.length,2);assert.equal(calls[1].path,'/v1/auth/refresh');assert.deepEqual(calls[1].body.expected,{principalId:id(1),credentialId:id(2),sessionId:id(3),authVersion:1,grantGeneration:3,absoluteExpiresAt:current.absoluteExpiresAt});assert.ok(values.every(value=>value.expiresAt===now+600000));assert.equal(calls[1].headers['X-Projektor-Auth-CSRF'],'synthetic-csrf');
});
test('changed authority cannot silently become an automatic refreshed session',async()=>{
 let changed=false;const {auth,calls}=api(call=>Response.json(envelope({...current,expiresAt:now+600000,grantGeneration:changed?4:3})));
 await auth.restore();changed=true;await assert.rejects(auth.restore({refresh:true}),/AUTHORITY_CHANGED/);assert.equal(calls.filter(c=>c.path.endsWith('/refresh')).length,0);
});
test('lost login reply uses receipt proof and never resubmits a password',async()=>{
 const {auth,calls}=api(call=>{if(call.path.endsWith('/csrf'))return Response.json({csrfToken:'preauth',expiresAt:now+600000});if(call.path.endsWith('/login'))throw Error('synthetic lost reply');return Response.json(envelope({...current,expiresAt:now+600000}));});
 await auth.login('synthetic password only');assert.deepEqual(calls.map(c=>c.path),['/v1/auth/csrf','/v1/auth/login','/v1/auth/csrf','/v1/auth/login-receipt']);assert.equal(calls[3].body.operationId,calls[1].body.operationId);assert.equal(calls[3].body.retrySecret,calls[1].body.retrySecret);assert.equal(calls[3].body.password,undefined);assert.equal(calls[1].body.loginName,undefined);
});
test('401 reports one recovery event, leaves each failed command unresent, and rearms explicitly',async()=>{
 const {auth,calls}=api(()=>new Response(null,{status:401}));let events=0;auth.subscribe(()=>events++);
 await Promise.all([auth.fetch('https://product.test/v1/workspaces/x/commands',{method:'POST',credentials:'same-origin'}),auth.fetch('https://product.test/v1/session',{credentials:'same-origin'})]);await Promise.resolve();assert.equal(events,1);assert.equal(calls.length,2);assert.equal(calls.filter(c=>c.method==='POST').length,1);
 auth.confirmAccess();await auth.fetch('https://product.test/v1/session',{credentials:'same-origin'});await Promise.resolve();assert.equal(events,2);
});
test('refresh race is resolved by a session read; setup receipt cannot resend completion',async()=>{
 let reads=0;const {auth,calls}=api(call=>{if(call.path.endsWith('/session'))return Response.json(envelope({...current,expiresAt:++reads===1?current.expiresAt:now+600000}));if(call.path.endsWith('/refresh'))return Response.json({error:{code:'SESSION_ROTATION_RACE'}},{status:409});if(call.path.endsWith('/csrf'))return Response.json({csrfToken:'preauth',expiresAt:now+600000});return Response.json({ok:true,operationId:id(9),purpose:'enroll',loginRequired:true});});
 await auth.restore();assert.deepEqual(calls.map(c=>c.path),['/v1/auth/session','/v1/auth/refresh','/v1/auth/session']);
 await auth.grantReceipt({grantId:id(8),secret:'synthetic-secret'},id(9));assert.equal(calls.at(-1).path,'/v1/auth/grants/receipt');assert.equal(calls.at(-1).body.password,undefined);assert.ok(calls.every(c=>!c.path.endsWith('/complete')));
});

test('unobserved login receipt retains proof and blocks another password submission until explicitly reset',async()=>{
 let found=false;const {auth,calls}=api(call=>{if(call.path.endsWith('/csrf'))return Response.json({csrfToken:'preauth',expiresAt:now+600000});if(call.path.endsWith('/login'))throw Error('synthetic lost reply');return Response.json(found?envelope({...current,expiresAt:now+600000}):{state:'not_observed',absenceIsProofOfNonExecution:false});});
 await assert.rejects(auth.login('synthetic password'),/AUTH_LOGIN_UNCONFIRMED/);assert.equal(auth.loginPending,true);await assert.rejects(auth.login('a second password'),/AUTH_LOGIN_PENDING/);found=true;await auth.loginReceipt();assert.equal(auth.loginPending,false);assert.equal(calls.filter(c=>c.path.endsWith('/login')).length,1);
});

test('family adoption permits only a fresh family for unchanged account authority',()=>{
 const next={...current,sessionId:id(20),absoluteExpiresAt:current.absoluteExpiresAt+60000};assert.equal(canAdoptSession(current,next),true);
 for(const change of [{principalId:id(9)},{credentialId:id(9)},{authVersion:2},{grantGeneration:4}])assert.equal(canAdoptSession(current,{...next,...change}),false);
 assert.equal(canAdoptSession(current,{...current,absoluteExpiresAt:current.absoluteExpiresAt+60000}),false);
});
