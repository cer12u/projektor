import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {APP_AUTH_SCHEMA,createAppAuth} from '../service/app-auth.mjs';
import {NATIVE_MACHINE_SCHEMA,NATIVE_MACHINE_GRANT_SCHEMA,NATIVE_MACHINE_SCOPES,createNativeMachineAuth,isNativeMachineRequest} from '../service/native-machine-auth.mjs';

async function fixture(){
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON; CREATE TABLE workspace(id TEXT PRIMARY KEY,active INTEGER); CREATE TABLE membership(principal_id TEXT PRIMARY KEY,kind TEXT,revoked INTEGER,read_own INTEGER); CREATE TABLE credential(id TEXT PRIMARY KEY,principal_id TEXT REFERENCES membership(principal_id),expires_at INTEGER,revoked INTEGER,can_read INTEGER,can_write INTEGER); CREATE TABLE principal_scope(principal_id TEXT,scope TEXT,PRIMARY KEY(principal_id,scope)); CREATE TABLE credential_scope(credential_id TEXT,scope TEXT,PRIMARY KEY(credential_id,scope));');db.exec(APP_AUTH_SCHEMA);db.exec(NATIVE_MACHINE_SCHEMA);db.exec(NATIVE_MACHINE_GRANT_SCHEMA);
 const ids=Object.fromEntries(['workspace','human','machine','humanCredential','epoch','session'].map(k=>[k,randomUUID()])),origin='https://native-machine.invalid';let clock=1800000000000,sequence=0;
 db.prepare('INSERT INTO workspace VALUES(?,1)').run(ids.workspace);
 const port={prepare:sql=>db.prepare(sql),transactionSync(fn){const name='t'+sequence++;db.exec('SAVEPOINT '+name);try{const result=fn();db.exec('RELEASE '+name);return result;}catch(e){db.exec('ROLLBACK TO '+name);db.exec('RELEASE '+name);throw e;}}};
 db.prepare("INSERT INTO membership VALUES(?,'human',0,1)").run(ids.human);db.prepare("INSERT INTO membership VALUES(?,'machine',0,1)").run(ids.machine);db.prepare('INSERT INTO credential VALUES(?,?,?,0,1,1)').run(ids.humanCredential,ids.human,clock+86400000);db.prepare("INSERT INTO app_auth_principal VALUES(?,?,'owner',1,1,NULL,NULL,NULL,0)").run(ids.human,ids.humanCredential);
 for(const scope of NATIVE_MACHINE_SCOPES)db.prepare('INSERT INTO principal_scope VALUES(?,?)').run(ids.machine,scope);
 const raw=randomBytes(32),cookie=`__Host-projektor_session=${ids.session}.${raw.toString('base64url')}`;
 db.prepare('INSERT INTO app_auth_session(id,principal_id,credential_id,auth_version,grant_generation,auth_epoch,current_hash,created_at,idle_expires_at,absolute_expires_at,rotated_at,revoked) VALUES(?,?,?,1,1,?,?,?,?,?,?,0)').run(ids.session,ids.human,ids.humanCredential,ids.epoch,createHash('sha256').update(raw).digest('hex'),clock,clock+3600000,clock+7200000,clock);
 const app=createAppAuth({db:port,workspaceId:ids.workspace,humanPrincipalId:ids.human,origin,authEpoch:ids.epoch,sealKey:randomBytes(32).toString('hex'),policy:{idleMs:3600000,absoluteMs:7200000},now:()=>clock});
 const response=await app.handleAuth(new Request(origin+'/v1/auth/session',{headers:{cookie}})),session=await response.json();assert.equal(response.status,200);
 const request=(change={})=>new Request(origin+'/v1/auth/machine-credentials/issue',{method:'POST',headers:{cookie,origin,'sec-fetch-site':'same-origin','x-projektor-auth-csrf':session.csrfToken,...change}});
 const config={db:port,workspaceId:ids.workspace,machinePrincipalId:ids.machine,humanPrincipalId:ids.human,authEpoch:ids.epoch,origin,maxRedeemLifetimeMs:600000,maxLifetimeMs:86400000,authorizeOwnerMutation:r=>app.authorizeOwnerMutation(r),now:()=>clock};
 const native=createNativeMachineAuth(config),input=(scopes=['issue:read','operations:read_own','issue:write'])=>({operationId:randomUUID(),scopes,expiresAt:clock+3600000}),bearer=token=>new Request(origin+'/machine/v1/workspaces/'+ids.workspace+'/capabilities',{headers:{authorization:'Bearer '+token}});
 return{db,ids,config,native,request,input,bearer,advance:ms=>clock+=ms,close:()=>db.close()};
}

test('native SQLite issuance is owner-session/CSRF bound, hash-only, idempotent and currently revocable',async()=>{
 const f=await fixture();try{
  const input=f.input(),first=f.native.issue(f.request(),input);assert.match(first.token,/^pn1_/);assert.equal(first.credential.principalId,f.ids.machine);assert.equal(isNativeMachineRequest(f.bearer(first.token)),true);
  assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM native_machine_credential').all()).includes(first.token),false);assert.equal(f.db.prepare('SELECT token_hash FROM native_machine_credential').get().token_hash,createHash('sha256').update(first.token).digest('hex'));
  const replay=f.native.issue(f.request(),input);assert.equal(replay.token,undefined);assert.equal(replay.tokenUnavailable,true);assert.equal(replay.credential.credentialId,first.credential.credentialId);assert.equal(f.db.prepare('SELECT count(*) AS n FROM native_machine_credential').get().n,1);
  assert.throws(()=>f.native.issue(f.request(),{...input,scopes:['issue:read']}),{code:'NATIVE_MACHINE_OPERATION_REUSED'});
  const listed=f.native.list(f.request(),{});assert.equal(listed.credentials.length,1);assert.equal(listed.credentials[0].credentialId,first.credential.credentialId);assert.equal(listed.maxLifetimeMs,86400000);assert.ok(listed.allowedScopes.includes('claim:write'));assert.ok(!JSON.stringify(listed).includes(first.token));assert.ok(!JSON.stringify(listed).includes('token_hash'));assert.ok(!JSON.stringify(listed).includes('request_hash'));
  const actor=f.native.authenticate(f.bearer(first.token));assert.equal(actor.source,'app_machine');assert.equal(actor.principalId,f.ids.machine);assert.equal(actor.credentialId,first.credential.credentialId);
  assert.throws(()=>f.native.authenticate(f.bearer(first.token.slice(0,-1)+(first.token.endsWith('A')?'B':'A'))),{code:'UNAUTHENTICATED'});
  assert.throws(()=>f.native.issue(f.request({'x-projektor-auth-csrf':'wrong'}),f.input()),{code:'AUTH_CSRF_REJECTED'});
  f.db.prepare("UPDATE app_auth_principal SET role='member'").run();assert.throws(()=>f.native.revoke(f.request(),{credentialId:first.credential.credentialId}),{code:'AUTH_OWNER_REQUIRED'});f.db.prepare("UPDATE app_auth_principal SET role='owner'").run();
  assert.equal(f.native.revoke(f.request(),{credentialId:first.credential.credentialId}).credential.revoked,true);assert.throws(()=>f.native.authenticate(f.bearer(first.token)),{code:'FORBIDDEN'});assert.equal(f.native.revoke(f.request(),{credentialId:first.credential.credentialId}).credential.revoked,true);assert.equal(f.native.list(f.request(),{}).credentials[0].revoked,true);
 }finally{f.close();}
});

test('native issuance preserves claim-only/wiki-only scope, explicit policy, current grants and fixed machine identity',async()=>{
 const f=await fixture();try{
  f.db.prepare("UPDATE membership SET kind='human' WHERE principal_id=?").run(f.ids.machine);
  for(const scopes of [['issue:read','claim:write'],['wiki:read','wiki:write']]){const issued=f.native.issue(f.request(),f.input(scopes));assert.deepEqual(issued.credential.scopes,[...scopes].sort());assert.equal(issued.credential.scopes.includes('issue:write'),false);assert.equal(f.native.authenticate(f.bearer(issued.token)).principalKind,'human');}
  assert.throws(()=>f.native.issue(f.request(),f.input(['claim:write'])),{code:'NATIVE_MACHINE_SCOPES_INVALID'});
  assert.throws(()=>f.native.issue(f.request(),f.input(['resource:manage'])),{code:'NATIVE_MACHINE_SCOPES_INVALID'});
  assert.throws(()=>f.native.issue(f.request(),{...f.input(),expiresAt:1800000000000+86400001}),{code:'NATIVE_MACHINE_EXPIRY_INVALID'});
  const issued=f.native.issue(f.request(),f.input());f.db.prepare("DELETE FROM principal_scope WHERE principal_id=? AND scope='issue:write'").run(f.ids.machine);assert.throws(()=>f.native.authenticate(f.bearer(issued.token)),{code:'NATIVE_MACHINE_SCOPE_DENIED'});f.db.prepare("INSERT INTO principal_scope VALUES(?,'issue:write')").run(f.ids.machine);
  f.db.prepare("INSERT INTO credential_scope VALUES(?,'wiki:read')").run(issued.credential.credentialId);assert.throws(()=>f.native.authenticate(f.bearer(issued.token)),{code:'FORBIDDEN'});
  f.db.prepare("UPDATE membership SET kind='legacy_unbound' WHERE principal_id=?").run(f.ids.machine);assert.throws(()=>f.native.issue(f.request(),f.input()),{code:'NATIVE_MACHINE_PRINCIPAL_UNAVAILABLE'});assert.throws(()=>createNativeMachineAuth({...f.config,machinePrincipalId:f.ids.human}),{code:'NATIVE_MACHINE_CONFIG_INVALID'});
  const absent=createNativeMachineAuth({...f.config,machinePrincipalId:undefined});assert.throws(()=>absent.issue(f.request(),f.input()),{code:'NATIVE_MACHINE_PRINCIPAL_UNAVAILABLE'});
 }finally{f.close();}
});


test('public pairing approval for existing human dot redeems hash-only, replays after lost response and revokes',async()=>{
 const f=await fixture();try{
  f.db.prepare("UPDATE membership SET kind='human' WHERE principal_id=?").run(f.ids.machine);
  const raw=randomBytes(32),secret=raw.toString('base64url'),grantId=randomUUID(),credentialId=randomUUID(),input={grantId,credentialId,secretDigest:createHash('sha256').update(raw).digest('hex'),scopes:['issue:read','issue:write','operations:read_own'],expiresAt:1800003600000,redeemExpiresAt:1800000300000,expectedGeneration:0},proof={grantId,secret},request=new Request(f.config.origin+'/v1/auth/machine-credentials/pairing/redeem',{method:'POST'});
  assert.equal(f.native.approvePairing(f.request(),input).grant.principalId,f.ids.machine);assert.equal(f.native.approvePairing(f.request(),input).replayed,true);
  assert.throws(()=>f.native.redeemPairing(request,{...proof,secret:randomBytes(32).toString('base64url')}),{code:'NATIVE_PAIRING_PROOF_REQUIRED'});
  const first=f.native.redeemPairing(request,proof),again=f.native.redeemPairing(request,proof),token='pn1_'+credentialId+'_'+secret;
  assert.equal(first.token,undefined);assert.equal(again.replayed,true);assert.equal(again.credential.credentialId,credentialId);assert.equal(f.native.authenticate(f.bearer(token)).principalKind,'human');
  for(const table of ['native_machine_grant','native_machine_credential'])assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM '+table).all()).includes(secret),false);
  assert.equal(JSON.stringify([first,again,f.native.list(f.request(),{})]).includes(secret),false);
  assert.equal(f.native.revoke(f.request(),{credentialId}).credential.revoked,true);assert.throws(()=>f.native.redeemPairing(request,proof),{code:'NATIVE_PAIRING_AUTHORITY_CHANGED'});
  const nextRaw=randomBytes(32),next={...input,grantId:randomUUID(),credentialId:randomUUID(),secretDigest:createHash('sha256').update(nextRaw).digest('hex'),expectedGeneration:1};
  assert.throws(()=>f.native.approvePairing(f.request(),{...next,expectedGeneration:0}),{code:'NATIVE_PAIRING_GENERATION_CHANGED'});f.native.approvePairing(f.request(),next);
  f.db.prepare('UPDATE native_machine_grant SET expires_at=expires_at+1 WHERE grant_id=?').run(next.grantId);assert.throws(()=>f.native.redeemPairing(request,{grantId:next.grantId,secret:nextRaw.toString('base64url')}),{code:'NATIVE_PAIRING_AUTHORITY_CHANGED'});f.db.prepare('UPDATE native_machine_grant SET expires_at=expires_at-1 WHERE grant_id=?').run(next.grantId);
  f.db.prepare('UPDATE app_auth_principal SET auth_version=auth_version+1').run();assert.throws(()=>f.native.redeemPairing(request,{grantId:next.grantId,secret:nextRaw.toString('base64url')}),{code:'NATIVE_PAIRING_AUTHORITY_CHANGED'});f.db.prepare('UPDATE app_auth_principal SET auth_version=auth_version-1').run();
  assert.equal(f.native.revoke(f.request(),{credentialId:next.credentialId}).grant.revoked,true);

 }finally{f.close();}
});
