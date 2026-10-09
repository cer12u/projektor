import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {APP_AUTH_SCHEMA,createAppAuth,validatePolicy} from '../service/app-auth.mjs';
const PASSWORD='A synthetic passphrase for test only.';
const SECOND='A separate synthetic password phrase.';
const secret=()=>randomBytes(32).toString('base64url');
const digest=value=>createHash('sha256').update(Buffer.from(value,'base64url')).digest('hex');
const derived=({passwordBytes,saltBytes})=>createHash('sha256').update('synthetic-KDF-port').update(passwordBytes).update(saltBytes).digest();
function fixture(){
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');
 db.exec('CREATE TABLE membership(principal_id TEXT PRIMARY KEY,kind TEXT,revoked INTEGER,read_own INTEGER); CREATE TABLE credential(id TEXT PRIMARY KEY,principal_id TEXT,expires_at INTEGER,revoked INTEGER,can_read INTEGER,can_write INTEGER); CREATE TABLE principal_scope(principal_id TEXT,scope TEXT); CREATE TABLE credential_scope(credential_id TEXT,scope TEXT);');db.exec(APP_AUTH_SCHEMA);
 const principal=randomUUID(),credential=randomUUID(),workspaceId=randomUUID(),authEpoch=randomUUID(),origin='https://password-auth.invalid';let clock=1800000000000,calls=0,hook=null,sequence=0;
 db.prepare("INSERT INTO membership VALUES(?,'human',0,0)").run(principal);db.prepare('INSERT INTO credential VALUES(?,?,?,0,1,1)').run(credential,principal,Number.MAX_SAFE_INTEGER);db.prepare("INSERT INTO principal_scope VALUES(?,'issue:read')").run(principal);db.prepare("INSERT INTO credential_scope VALUES(?,'issue:read')").run(credential);
 db.prepare("INSERT INTO app_auth_principal VALUES(?,?,'owner',0,0,NULL,NULL,NULL,0)").run(principal,credential);
 const port={prepare:sql=>db.prepare(sql),transactionSync(fn){const name='t'+sequence++;db.exec('SAVEPOINT '+name);try{const result=fn();db.exec('RELEASE '+name);return result;}catch(e){db.exec('ROLLBACK TO '+name);db.exec('RELEASE '+name);throw e;}}};
 const config={db:port,workspaceId,humanPrincipalId:principal,origin,authEpoch,sealKey:randomBytes(32).toString('hex'),policy:{idleMs:86400000,absoluteMs:7*86400000,rotationIntervalMs:60000,retryGraceMs:10000,maxAttempts:3},now:()=>clock,kdf:{async derive(input){calls++;if(hook)await hook();return derived(input);}}};
 let auth=createAppAuth(config),csrf='',sessionCsrf='';const jar=new Map();
 const headers=()=>({cookie:[...jar].map(([k,v])=>k+'='+v).join(';')});
 const remember=response=>{for(const line of response.headers.getSetCookie()){const [name,...value]=line.split(';')[0].split('=');if(/Max-Age=0(?:;|$)/.test(line))jar.delete(name);else jar.set(name,value.join('='));}};
 const req=(path,input,{session=false,extra={},cookies=headers().cookie}={})=>new Request(origin+'/v1/auth/'+path,{method:input===undefined?'GET':'POST',headers:{cookie:cookies,...(input===undefined?{}:{origin,'sec-fetch-site':'same-origin','content-type':'application/json','x-projektor-auth-csrf':session?sessionCsrf:csrf}),...extra},...(input===undefined?{}:{body:JSON.stringify(input)})});
 const call=async(path,input,options={})=>{const request=req(path,input,options),response=await auth.handleAuth(request),value=await response.clone().json();if(options.remember!==false){remember(response);if(value.csrfToken){if(path==='csrf')csrf=value.csrfToken;else sessionCsrf=value.csrfToken;}}return{response,value,status:response.status,request};};
 const approve=(purpose='enroll')=>{const a=db.prepare('SELECT * FROM app_auth_principal').get(),grantId=randomUUID(),raw=secret(),plan={grantId,principalId:principal,role:'owner',purpose,expectedAuthVersion:a.auth_version,generation:a.grant_generation+1,secretDigest:digest(raw),expiresAt:clock+600000};auth.approveGrant(plan);return{grantId,secret:raw,plan};};
 const complete=async(g,password=PASSWORD,operationId=randomUUID())=>{const result=await call('grants/complete',{grantId:g.grantId,secret:g.secret,password,operationId});return{...result,operationId};};
 const enroll=async()=>{await call('csrf');const g=approve(),result=await complete(g);assert.equal(result.status,200,JSON.stringify(result.value));return g;};
 const login=async(password=PASSWORD,options={})=>call('login',{password,operationId:randomUUID(),retrySecret:secret()},options);
 const authority=()=>JSON.stringify(['membership','credential','principal_scope','credential_scope'].map(t=>db.prepare('SELECT * FROM '+t).all()));
 const state=()=>JSON.stringify(['app_auth_principal','app_auth_grant','app_auth_session','app_auth_login_receipt','app_auth_refresh_receipt'].map(t=>db.prepare('SELECT * FROM '+t).all()));
 return{db,port,config,principal,credential,jar,call,req,approve,complete,enroll,login,authority,state,get auth(){return auth;},get calls(){return calls;},get clock(){return clock;},advance:n=>clock+=n,setHook:f=>hook=f,recreate(changes={}){Object.assign(config,changes);auth=createAppAuth(config);},close:()=>db.close()};
}
const use=async fn=>{const f=fixture();try{return await fn(f);}finally{f.close();}};
const expected=s=>Object.fromEntries(['principalId','credentialId','sessionId','authVersion','grantGeneration','absoluteExpiresAt'].map(k=>[k,s[k]]));

test('closed enrollment checks cheap secret/CSRF before KDF and returns receipt without a session',()=>use(async f=>{
 const before=f.authority();await f.call('csrf');const grant=f.approve(),op=randomUUID();
 const forged=await f.call('grants/complete',{grantId:grant.grantId,secret:secret(),operationId:op,password:PASSWORD});assert.equal(forged.status,403);assert.equal(f.calls,0);
 const csrf=await f.call('grants/complete',{grantId:grant.grantId,secret:grant.secret,operationId:op,password:PASSWORD},{extra:{'x-projektor-auth-csrf':'wrong'}});assert.equal(csrf.status,403);assert.equal(f.calls,0);
 const result=await f.complete(grant,PASSWORD,op);assert.equal(result.status,200);assert.equal(result.value.loginRequired,true);assert.equal(f.calls,1);assert.equal(f.db.prepare('SELECT count(*) n FROM app_auth_session').get().n,0);
 const stored=f.state(),receipt=await f.call('grants/receipt',{grantId:grant.grantId,secret:grant.secret,operationId:op});assert.deepEqual(receipt.value,result.value);assert.equal(f.state(),stored);assert.equal(f.calls,1);
 const repeat=await f.complete(grant,PASSWORD,op);assert.deepEqual(repeat.value,result.value);assert.equal(f.calls,1);assert.equal(f.authority(),before);
 const mismatch=await f.complete(grant,SECOND,op);assert.equal(mismatch.value.error.code,'AUTH_OPERATION_REUSED');
}));

test('reset consumption/password/version/session revocation is atomic; late failure rolls all back',()=>use(async f=>{
 await f.enroll();const logged=await f.login();assert.equal(logged.status,200);const grant=f.approve('reset'),op=randomUUID(),before=f.state();
 f.db.exec("CREATE TRIGGER fail_consume BEFORE UPDATE OF consumed_operation_id ON app_auth_grant BEGIN SELECT RAISE(ABORT,'synthetic late write failure'); END");
 const failed=await f.complete(grant,SECOND,op);assert.equal(failed.status,503);assert.equal(f.state(),before);
 f.db.exec('DROP TRIGGER fail_consume');const success=await f.complete(grant,SECOND,op);assert.equal(success.status,200);assert.equal(f.db.prepare('SELECT auth_version FROM app_auth_principal').get().auth_version,2);assert.equal(f.db.prepare('SELECT revoked FROM app_auth_session').get().revoked,1);
 assert.equal((await f.call('session')).status,401);assert.equal((await f.login(PASSWORD)).status,401);assert.equal((await f.login(SECOND)).status,200);
}));

test('superseding generation during asynchronous KDF prevents old grant commit and cannot be rolled back by reapproval',()=>use(async f=>{
 await f.enroll();const grant=f.approve('reset');let release,started;const began=new Promise(r=>started=r);f.setHook(()=>{started();return new Promise(r=>release=r);});
 const pending=f.complete(grant,SECOND);await began;const newer=f.approve('reset');release();const old=await pending;assert.equal(old.value.error.code,'GRANT_SUPERSEDED');assert.equal(f.db.prepare('SELECT auth_version FROM app_auth_principal').get().auth_version,1);
 assert.throws(()=>f.auth.approveGrant(grant.plan),{code:'GRANT_ID_REUSED'});f.auth.revokeGrant({grantId:newer.grantId,generation:newer.plan.generation});assert.throws(()=>f.auth.approveGrant(newer.plan),{code:'GRANT_ID_REUSED'});assert.equal(f.db.prepare('SELECT grant_generation FROM app_auth_principal').get().grant_generation,3);
 f.setHook(null);
}));

test('lost login reply recovers the identical cookie once without KDF or new sessions; restart/reload persists',()=>use(async f=>{
 await f.enroll();const input={password:PASSWORD,operationId:randomUUID(),retrySecret:secret()},lost=await f.call('login',input,{remember:false});assert.equal(lost.status,200);assert.equal((await f.call('session')).status,401);const calls=f.calls;
 const recovered=await f.call('login-receipt',{operationId:input.operationId,retrySecret:input.retrySecret});assert.equal(recovered.status,200);assert.deepEqual(recovered.value,lost.value);assert.equal(recovered.response.headers.getSetCookie()[0],lost.response.headers.getSetCookie()[0]);assert.equal(f.calls,calls);assert.equal(f.db.prepare('SELECT count(*) n FROM app_auth_session').get().n,1);
 assert.match(recovered.response.headers.getSetCookie()[0],/HttpOnly; Secure; SameSite=Strict/);assert.match(recovered.response.headers.getSetCookie()[0],/Max-Age=[1-9]/);
 const sid=recovered.value.session.sessionId;f.recreate();f.advance(f.config.policy.accessLeaseMs??300000);f.advance(1);const current=await f.call('session');assert.equal(current.status,200);assert.equal(current.value.session.sessionId,sid);assert.ok(current.value.session.expiresAt>f.clock);assert.equal(f.auth.authenticate(f.req('session')).sessionId,sid);
 const none=await f.call('login-receipt',{operationId:randomUUID(),retrySecret:secret()});assert.equal(none.value.absenceIsProofOfNonExecution,false);
}));

test('bounded session rotation converges same-operation retries, refuses competing replay, keeps family and absolute deadline',()=>use(async f=>{
 await f.enroll();const logged=await f.login(),absolute=logged.value.session.absoluteExpiresAt;f.advance(60001);const oldCookies=[...f.jar].map(([k,v])=>k+'='+v).join(';'),op=randomUUID(),input={operationId:op,expected:expected(logged.value.session)};
 const first=await f.call('refresh',input,{session:true,remember:false,cookies:oldCookies});assert.equal(first.status,200);assert.equal(first.value.session.sessionId,logged.value.session.sessionId);assert.equal(first.value.session.absoluteExpiresAt,absolute);
 const retry=await f.call('refresh',input,{session:true,remember:false,cookies:oldCookies});assert.equal(retry.status,200);assert.deepEqual(retry.value,first.value);assert.deepEqual(retry.response.headers.getSetCookie(),first.response.headers.getSetCookie());
 // Cookie headers may arrive even when the response body is lost. After GET
 // session obtains the current CSRF value, the same operation still replays.
 const newCookie=first.response.headers.getSetCookie()[0].split(';')[0];const newCookies=oldCookies.split(';').filter(x=>!x.trim().startsWith('__Host-projektor_session=')).concat(newCookie).join(';');
 const current=await f.call('session',undefined,{cookies:newCookies});assert.equal(current.status,200);
 const partialReply=await f.call('refresh',input,{session:true,remember:false,cookies:newCookies});assert.equal(partialReply.status,200);assert.deepEqual(partialReply.value,first.value);
 // Restore the old token's matching CSRF to exercise a real competing request.
 const oldCsrf=logged.value.csrfToken;
 const race=await f.call('refresh',{operationId:randomUUID()},{session:true,remember:false,cookies:oldCookies,extra:{'x-projektor-auth-csrf':oldCsrf}});assert.equal(race.value.error.code,'SESSION_ROTATION_RACE');assert.equal(f.db.prepare('SELECT revoked FROM app_auth_session').get().revoked,0);
 f.advance(10001);const replay=await f.call('refresh',{operationId:randomUUID()},{session:true,remember:false,cookies:oldCookies,extra:{'x-projektor-auth-csrf':oldCsrf}});assert.equal(replay.value.error.code,'SESSION_REPLAY_REJECTED');assert.equal(f.db.prepare('SELECT revoked FROM app_auth_session').get().revoked,1);
}));

test('refresh without rotation has a durable same-result receipt and fixed lifetime; logout revokes synchronously',()=>use(async f=>{
 await f.enroll();const logged=await f.login(),input={operationId:randomUUID(),expected:expected(logged.value.session)},first=await f.call('refresh',input,{session:true});assert.equal(first.status,200);const idle=first.value.session.idleExpiresAt;
 f.advance(1000);const again=await f.call('refresh',input,{session:true});assert.equal(again.status,200);assert.deepEqual(again.value,first.value);assert.equal(f.db.prepare('SELECT idle_expires_at FROM app_auth_session').get().idle_expires_at,idle);
 f.advance(10000);const expired=await f.call('refresh',input,{session:true});assert.equal(expired.value.error.code,'AUTH_OPERATION_REUSED');assert.equal(f.db.prepare('SELECT count(*) n FROM app_auth_refresh_receipt').get().n,1);
 const fresh=await f.call('refresh',{operationId:randomUUID()},{session:true});assert.equal(fresh.status,200);assert.equal(f.db.prepare('SELECT count(*) n FROM app_auth_refresh_receipt').get().n,1);assert.equal(f.db.prepare('SELECT count(*) n FROM app_auth_refresh_receipt WHERE operation_id=?').get(input.operationId).n,0);
 assert.equal((await f.call('logout',{}, {session:true})).status,200);assert.throws(()=>f.auth.authenticate(f.req('session')),{code:'AUTH_UNAUTHENTICATED'});
 const second=await f.login();f.advance(second.value.session.absoluteExpiresAt-f.clock);assert.equal((await f.call('session')).status,401);assert.equal((await f.call('refresh',{operationId:randomUUID()},{session:true})).status,401);
}));

test('account authority changes after KDF admission reject login before any new session',()=>use(async f=>{
 await f.enroll();let release,started;const began=new Promise(r=>started=r);f.setHook(()=>{started();return new Promise(r=>release=r);});const pending=f.login();await began;f.db.exec('UPDATE app_auth_principal SET auth_version=auth_version+1');release();const login=await pending;assert.equal(login.value.error.code,'SESSION_AUTHORITY_CHANGED');assert.equal(f.db.prepare('SELECT count(*) n FROM app_auth_session').get().n,0);
}));

test('credential revocation and fresh outside-backup auth epoch invalidate sessions, grants and restored password records',()=>use(async f=>{
 const enrollment=await f.enroll();await f.login();f.db.prepare('UPDATE credential SET revoked=1 WHERE id=?').run(f.credential);assert.equal((await f.call('session')).status,401);f.db.prepare('UPDATE credential SET revoked=0 WHERE id=?').run(f.credential);
 const grant=f.approve('reset');f.recreate({authEpoch:randomUUID()});assert.equal((await f.call('session')).status,401);await f.call('csrf');assert.equal((await f.call('grants/status',{grantId:grant.grantId,secret:grant.secret})).value.state,'unavailable');const login=await f.login();assert.equal(login.value.error.code,'AUTH_EPOCH_CHANGED');assert.equal(f.db.prepare('SELECT auth_version FROM app_auth_principal').get().auth_version,1);
}));

test('KDF failures have no weak fallback, wrong-password admission is bounded and no arbitrary principal is accepted',()=>use(async f=>{
 await f.enroll();const base=f.calls;for(let i=0;i<3;i++)assert.equal((await f.login(SECOND)).status,401);assert.equal((await f.login(SECOND)).status,429);assert.equal(f.calls,base+3);
 const bad=await f.call('login',{password:PASSWORD,operationId:randomUUID(),retrySecret:secret(),principalId:randomUUID()});assert.equal(bad.status,400);assert.equal(f.calls,base+3);
 f.advance(60001);f.setHook(()=>{throw Error('synthetic KDF failure');});const failed=await f.login();assert.equal(failed.value.error.code,'AUTH_KDF_UNAVAILABLE');assert.equal(f.db.prepare('SELECT count(*) n FROM app_auth_session').get().n,0);
}));

test('session lifetime policy and internal seal key fail closed instead of inventing defaults',()=>use(async f=>{
 assert.throws(()=>validatePolicy({}),{code:'APP_AUTH_POLICY_INVALID'});assert.throws(()=>validatePolicy({idleMs:86400000,absoluteMs:Infinity}),{code:'APP_AUTH_POLICY_INVALID'});assert.throws(()=>createAppAuth({...f.config,sealKey:'weak'}),{code:'APP_AUTH_SEAL_KEY_INVALID'});
}));
