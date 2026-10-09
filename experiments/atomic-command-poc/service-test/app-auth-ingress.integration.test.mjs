import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
import {startAppAuthHarness} from '../browser-test/app-auth-server.mjs';

// Synthetic inputs only. Real entry, WorkspaceService, SQL, native scrypt and
// session/key/command ports run under the existing 2024-09-23 Workers profile.
const PASSWORD='Synthetic business ingress passphrase.';
const RESET_PASSWORD='Synthetic replacement ingress passphrase.';
const secret=()=>randomBytes(32).toString('base64url');
async function setup(t){
 const h=await startAppAuthHarness();t.after(()=>h.close());
 const jar=new Map();let preCsrf,sessionCsrf;
 const cookies=()=>[...jar].map(([k,v])=>k+'='+v).join('; ');
 async function send(path,{method='GET',input,body,headers={},cookie=cookies(),auth=false,remember=true}={}){
  const response=await h.fetch(h.base+path,{method,headers:{cookie,origin:h.base,'sec-fetch-site':'same-origin',
   ...(method==='POST'?{'content-type':'application/json',...(auth?{'x-projektor-auth-csrf':['login','login-receipt','grants/complete','grants/status','grants/receipt'].some(p=>path.endsWith('/'+p))?preCsrf:sessionCsrf}:{'x-projektor-csrf':'same-origin'})}:{}),...headers},
   ...(input!==undefined?{body:JSON.stringify(input)}:body!==undefined?{body}:{})});
  const value=await response.json();
  if(remember){for(const line of response.headers.getSetCookie()){const [name,...parts]=line.split(';')[0].split('=');if(/Max-Age=0(?:;|$)/.test(line))jar.delete(name);else jar.set(name,parts.join('='));}
   if(value.csrfToken){if(path==='/v1/auth/csrf')preCsrf=value.csrfToken;else sessionCsrf=value.csrfToken;}}
  return {status:response.status,value};
 }
 const auth=(path,input,options={})=>send('/v1/auth/'+path,{...(input===undefined?{}:{method:'POST',input}),auth:true,...options});
 const sql=(query,args=[])=>h.control('sql',query,args);
 const authority=async()=>JSON.stringify(await Promise.all(['membership','credential','principal_scope','credential_scope','project_grant','identity_binding'].map(table=>sql('SELECT * FROM '+table+' ORDER BY 1,2'))));
 const businessState=async()=>JSON.stringify(await Promise.all(['issue','activity','outbox','operation','draft_key'].map(table=>sql('SELECT * FROM '+table+' ORDER BY 1'))));
 async function complete(purpose='enroll',password=PASSWORD){
  const challenge=await auth('csrf');assert.equal(challenge.status,200,'CSRF admission');
  const grantId=randomUUID(),raw=secret(),fingerprint=createHash('sha256').update(Buffer.from(raw,'base64url')).digest('hex');
  await h.approveGrant({grantId,fingerprint,purpose});
  const result=await auth('grants/complete',{grantId,secret:raw,operationId:randomUUID(),password});
  assert.equal(result.status,200,JSON.stringify(result.value));assert.equal(result.value.loginRequired,true);return result;
 }
 async function login(password=PASSWORD){const result=await auth('login',{password,operationId:randomUUID(),retrySecret:secret()});assert.equal(result.status,200,JSON.stringify(result.value));return result.value.session;}
 const prefix=`/v1/workspaces/${h.ids.workspace}`;
 const issue=options=>send(`${prefix}/issues/${h.ids.issue}?workspaceEpoch=${h.ids.epoch}`,options);
 const command=(title,version=1)=>({schemaVersion:1,workspaceId:h.ids.workspace,workspaceEpoch:h.ids.epoch,operationId:randomUUID(),commandType:'Issue.UpdateTitle',entityId:h.ids.issue,expectedVersion:version,payload:{title}});
 const execute=(value,options={})=>send(prefix+'/commands',{method:'POST',input:value,headers:{'idempotency-key':value.operationId},...options});
 const binding={principalId:h.ids.actor,workspaceId:h.ids.workspace,workspaceEpoch:h.ids.epoch,resourceType:'issue',resourceId:h.ids.issue,editorId:'content',projectAtProtection:h.ids.project,draftId:randomUUID()};
 const key=(keyId,options={})=>send('/v1/draft-keys',{method:'POST',input:{binding,...(keyId?{keyId}:{})},...options});
 async function deniedBusiness(cookie,keyId){
  const before=await businessState();
  for(const result of [await issue({cookie}),await key(keyId,{cookie}),await execute(command('Must not commit',2),{cookie})]){
   assert.equal(result.status,401,JSON.stringify(result.value));assert.equal(result.value.error.code,'AUTH_UNAUTHENTICATED');
  }
  assert.equal(await businessState(),before,'denials must leave all business/key rows unchanged');
 }
 return {h,send,auth,sql,authority,businessState,complete,login,issue,command,execute,binding,key,cookies,deniedBusiness};
}

test('real opaque-session ingress preserves existing authority, command receipts and draft access across logout/reset/revocation', {timeout:40000},async t=>{
 const f=await setup(t),initial=await f.authority(),before=await f.businessState();
 assert.equal((await f.issue()).status,401);
 // An Access assertion by itself is never an app session or a signup path.
 const assertion=[{alg:'RS256',kid:'synthetic'}, {sub:'synthetic-subject',email:'synthetic@example.invalid',exp:Math.floor(Date.now()/1000)+600}].map(x=>Buffer.from(JSON.stringify(x)).toString('base64url')).concat('synthetic-signature').join('.');
 assert.equal((await f.issue({headers:{'cf-access-jwt-assertion':assertion}})).status,401);
 await f.auth('csrf');assert.equal((await f.auth('login',{password:PASSWORD,operationId:randomUUID(),retrySecret:secret()})).status,401);
 assert.equal(await f.businessState(),before);assert.equal(await f.authority(),initial);
 await f.complete();assert.equal((await f.sql('SELECT count(*) n FROM app_auth_session'))[0].n,0);
 const authenticated=await f.login();assert.equal(authenticated.principalId,f.h.ids.actor);assert.equal(authenticated.credentialId,f.h.ids.credential);
 const bootstrap=await f.send('/v1/bootstrap');assert.equal(bootstrap.status,200);assert.equal(bootstrap.value.principalId,f.h.ids.actor);assert.equal(bootstrap.value.workspaces.length,1);
 const session=await f.send('/v1/session?workspaceId='+f.h.ids.workspace);assert.equal(session.status,200);assert.equal(session.value.sessionId,authenticated.sessionId);
 const read=await f.issue();assert.equal(read.status,200);assert.equal(read.value.data.id,f.h.ids.issue);
 const update=f.command('Committed using existing app principal'),result=await f.execute(update);assert.equal(result.status,200,JSON.stringify(result.value));
 assert.deepEqual((await f.execute(update)).value,result.value);
 const receipt=await f.send(`/v1/workspaces/${f.h.ids.workspace}/operations/${update.operationId}?workspaceEpoch=${f.h.ids.epoch}`);assert.deepEqual(receipt.value,result.value);
 const persisted=(await f.sql('SELECT title,version FROM issue WHERE id=?',[f.h.ids.issue]))[0];assert.deepEqual(persisted,{title:update.payload.title,version:2});
 for(const table of ['operation','activity','outbox'])assert.equal((await f.sql('SELECT count(*) n FROM '+table))[0].n,1);
 const draft=await f.key();assert.equal(draft.status,200,JSON.stringify(draft.value));assert.equal((await f.key(draft.value.keyId)).value.key,draft.value.key);
 const forged=await f.send('/v1/draft-keys',{method:'POST',input:{binding:{...f.binding,principalId:randomUUID()},keyId:draft.value.keyId}});assert.equal(forged.status,403);assert.equal((await f.sql('SELECT count(*) n FROM draft_key'))[0].n,1);
 assert.equal(await f.authority(),initial,'enrollment/login must not create memberships, identities, credentials, roles or scopes');
 const loggedOutCookie=f.cookies();assert.equal((await f.auth('logout',{})).status,200);await f.deniedBusiness(loggedOutCookie,draft.value.keyId);
 await f.login();const resetCookie=f.cookies();await f.complete('reset',RESET_PASSWORD);await f.deniedBusiness(resetCookie,draft.value.keyId);
 await f.login(RESET_PASSWORD);assert.equal((await f.key(draft.value.keyId)).status,200);
 assert.equal(await f.authority(),initial,'reset must preserve existing business authority');
 const revokedCookie=f.cookies();await f.sql('UPDATE credential SET revoked=1 WHERE id=?',[f.h.ids.credential]);await f.deniedBusiness(revokedCookie,draft.value.keyId);
});

test('real business and draft ports intersect current scopes and membership after password login', {timeout:30000},async t=>{
 const f=await setup(t);await f.sql("INSERT INTO resource_access VALUES('issue',?,1,'inherit','[]','[]')",[f.h.ids.issue]);
 await f.complete();await f.login();const draft=await f.key();assert.equal(draft.status,200);
 await f.sql("DELETE FROM credential_scope WHERE credential_id=? AND scope='issue:write'",[f.h.ids.credential]);
 const effects=async()=>JSON.stringify(await Promise.all(['issue','activity','outbox','draft_key'].map(table=>f.sql('SELECT * FROM '+table+' ORDER BY 1'))));
 const before=await effects(),denied=await f.execute(f.command('Downscope must deny'));assert.equal(denied.status,403,JSON.stringify(denied.value));assert.equal(denied.value.error.effectApplied,false);assert.equal(await effects(),before);
 const rejected=await f.sql('SELECT result_json FROM operation');assert.equal(rejected.length,1);assert.equal(JSON.parse(rejected[0].result_json).error.code,'FORBIDDEN');
 assert.equal((await f.issue()).status,200);
 await f.sql('UPDATE project_grant SET can_read=0,can_write=0 WHERE principal_id=? AND project_id=?',[f.h.ids.actor,f.h.ids.project]);
 const noAcl=await f.businessState();assert.notEqual((await f.issue()).status,200);assert.equal((await f.key(draft.value.keyId)).status,403);assert.equal(await f.businessState(),noAcl);
 const cookie=f.cookies();await f.h.control('revokeMembership');await f.deniedBusiness(cookie,draft.value.keyId);
});

test('logout during a deterministically paused command body is rechecked in the final Store transaction', {timeout:30000},async t=>{
 const f=await setup(t);await f.complete();await f.login();const before=await f.businessState(),update=f.command('Stale cookie must never commit');
 assert.equal((await f.h.control('armBodyBarrier')).state,'armed');
 const pending=f.execute(update);
 let entered=false;
 try{
  const deadline=Date.now()+800;
  while(Date.now()<deadline){const state=await f.h.control('bodyBarrierState');if(state.state==='entered'){entered=true;break;}await pause(5);}
  assert.equal(entered,true,'fixture did not reach body read after initial authentication');
  const logout=await f.auth('logout',{});assert.equal(logout.status,200,JSON.stringify(logout.value));
  assert.equal((await f.sql('SELECT revoked FROM app_auth_session'))[0].revoked,1,'logout must persist before body release');
 }finally{await f.h.control('releaseBodyBarrier');}
 const rejected=await pending;assert.equal(rejected.status,401,JSON.stringify(rejected.value));assert.equal(rejected.value.error.code,'AUTH_UNAUTHENTICATED');
 assert.equal(await f.businessState(),before,'stale admitted command must not change Issue, operation, activity, outbox or draft rows');
 assert.equal((await f.sql('SELECT count(*) n FROM operation WHERE operation_id=?',[update.operationId]))[0].n,0);
});

test('normal verifier accepts another registered human session without changing fixed enrollment target',async t=>{
 const h=await startAppAuthHarness();t.after(()=>h.close());
 const actor=randomUUID(),credential=randomUUID(),session=randomUUID(),raw=randomBytes(32),at=Date.now();
 const sql=(s,...args)=>h.control('sql',s,args);
 await sql("INSERT INTO membership VALUES(?,'human',0,1)",actor);
 await sql('INSERT INTO credential VALUES(?,?,?,0,1,0)',credential,actor,Number.MAX_SAFE_INTEGER);
 await sql("INSERT INTO app_auth_principal(principal_id,credential_id,role,auth_version,grant_generation,disabled) VALUES(?,?,'member',1,1,0)",actor,credential);
 await sql('INSERT INTO app_auth_session(id,principal_id,credential_id,auth_version,grant_generation,auth_epoch,current_hash,created_at,idle_expires_at,absolute_expires_at,rotated_at,revoked) VALUES(?,?,?,1,1,?,?,?,?,?,?,0)',session,actor,credential,h.ids.authEpoch,createHash('sha256').update(raw).digest('hex'),at,at+3600000,at+7200000,at);
 const cookie='__Host-projektor_session='+session+'.'+raw.toString('base64url');
 let r=await h.fetch(h.base+'/v1/auth/session',{headers:{cookie}});assert.equal(r.status,200);assert.equal((await r.json()).session.principalId,actor);
 r=await h.fetch(h.base+`/v1/workspaces/${h.ids.workspace}/session`,{headers:{cookie}});assert.equal(r.status,200,await r.clone().text());assert.equal((await r.json()).principalId,actor);
 const grant=randomUUID(),proof=randomBytes(32);
 await sql('INSERT INTO app_auth_grant(id,principal_id,purpose,role,auth_version,generation,auth_epoch,secret_digest,expires_at,revoked) VALUES(?,?,?, ?,1,1,?,?,?,0)',grant,actor,'enroll','member',h.ids.authEpoch,createHash('sha256').update(proof).digest('hex'),at+600000);
 const csrf=await h.fetch(h.base+'/v1/auth/csrf'),challenge=await csrf.json();
 const rejectedGrant=await h.fetch(h.base+'/v1/auth/grants/complete',{method:'POST',headers:{origin:h.base,'content-type':'application/json',cookie:csrf.headers.get('set-cookie').split(';')[0],'x-projektor-auth-csrf':challenge.csrfToken},body:JSON.stringify({grantId:grant,secret:proof.toString('base64url'),operationId:randomUUID(),password:'Synthetic secondary account password'})});
 assert.equal(rejectedGrant.status,403);assert.equal((await rejectedGrant.json()).error.code,'GRANT_UNAVAILABLE');assert.equal((await sql('SELECT password_hash FROM app_auth_principal WHERE principal_id=?',actor))[0].password_hash,null);
 await sql('UPDATE app_auth_session SET credential_id=? WHERE id=?',h.ids.credential,session);
 r=await h.fetch(h.base+'/v1/auth/session',{headers:{cookie}});assert.equal(r.status,409);assert.equal((await r.json()).error.code,'SESSION_AUTHORITY_CHANGED');
 await sql('UPDATE app_auth_session SET credential_id=? WHERE id=?',credential,session);await sql('UPDATE membership SET revoked=1 WHERE principal_id=?',actor);
 assert.equal((await h.fetch(h.base+'/v1/auth/session',{headers:{cookie}})).status,401);
 assert.equal((await sql('SELECT count(*) n FROM app_auth_grant WHERE consumed_operation_id IS NOT NULL'))[0].n,0);
});
