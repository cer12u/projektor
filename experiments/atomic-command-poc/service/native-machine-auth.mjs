// Closed native machine credentials. No principal, role, grant, source-D1 or
// external-provider mutation. The Store owns routing, schema and final-tx calls.
import {randomBytes,randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import {Buffer} from 'node:buffer';
export const NATIVE_MACHINE_PREFIX='pn1_';
export const NATIVE_MACHINE_SCHEMA=`CREATE TABLE native_machine_credential(credential_id TEXT PRIMARY KEY REFERENCES credential(id),token_hash TEXT NOT NULL UNIQUE,auth_epoch TEXT NOT NULL,issued_by TEXT NOT NULL,operation_id TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,created_at INTEGER NOT NULL,revoked_at INTEGER);`;
export const NATIVE_MACHINE_GRANT_SCHEMA=`CREATE TABLE native_machine_grant(grant_id TEXT PRIMARY KEY,credential_id TEXT NOT NULL UNIQUE,principal_id TEXT NOT NULL,secret_digest TEXT NOT NULL UNIQUE,scopes_json TEXT NOT NULL,expires_at INTEGER NOT NULL,redeem_expires_at INTEGER NOT NULL,auth_epoch TEXT NOT NULL,issued_by TEXT NOT NULL,owner_auth_version INTEGER NOT NULL,owner_grant_generation INTEGER NOT NULL,generation INTEGER NOT NULL UNIQUE,request_hash TEXT NOT NULL,created_at INTEGER NOT NULL,consumed_at INTEGER,revoked_at INTEGER);`;
export const NATIVE_MACHINE_SCOPES=Object.freeze(['issue:read','issue:write','comment:write','history:read','operations:read_own','claim:write','progress:write','issue:transition','wiki:read','wiki:write']);
export class NativeMachineAuthError extends Error{constructor(code,status=401){super(code);this.name='NativeMachineAuthError';this.code=code;this.status=status;}}
const stop=(code,status)=>{throw new NativeMachineAuthError(code,status);};
const uuid='[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',id=value=>typeof value==='string'&&new RegExp('^'+uuid+'$').test(value);
const tokenPattern=new RegExp('^pn1_('+uuid+')_([A-Za-z0-9_-]{43})$');
const hash=value=>createHash('sha256').update(value).digest('hex');
const equal=(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&timingSafeEqual(x,y);};
const only=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
const millis=value=>Number.isSafeInteger(value)&&value>=0;
const get=(db,sql,...args)=>db.prepare(sql).get(...args),all=(db,sql,...args)=>db.prepare(sql).all(...args),run=(db,sql,...args)=>db.prepare(sql).run(...args);
export const isNativeMachineRequest=request=>/^Bearer\s+pn1_/i.test((request.headers.get('authorization')??'').trim());

export function createNativeMachineAuth({db,workspaceId,machinePrincipalId,humanPrincipalId,authEpoch,authorizeOwnerMutation,maxLifetimeMs,origin,maxRedeemLifetimeMs,now=Date.now}){
 if(typeof db?.prepare!=='function'||typeof db?.transactionSync!=='function'||![workspaceId,humanPrincipalId,authEpoch].every(id)||machinePrincipalId!==undefined&&(!id(machinePrincipalId)||machinePrincipalId===humanPrincipalId)||!Number.isSafeInteger(maxLifetimeMs)||maxLifetimeMs<1||maxLifetimeMs>366*86400000||typeof authorizeOwnerMutation!=='function'||typeof now!=='function')stop('NATIVE_MACHINE_CONFIG_INVALID',503);
 const time=()=>{const value=now();if(!millis(value))stop('NATIVE_MACHINE_CLOCK_INVALID',503);return value;};
 function tx(fn){let cause;try{return db.transactionSync(()=>{try{return fn();}catch(error){cause=error;throw error;}});}catch(error){if(cause instanceof NativeMachineAuthError||cause?.name==='AppAuthError')throw cause;stop('NATIVE_MACHINE_STORAGE_UNAVAILABLE',503);}}
 function machine(principalId=machinePrincipalId){if(get(db,'SELECT active FROM workspace WHERE id=?',workspaceId)?.active!==1)stop('WORKSPACE_FROZEN',403);if(!id(principalId))stop('NATIVE_MACHINE_PRINCIPAL_UNAVAILABLE',403);const member=get(db,'SELECT kind,revoked FROM membership WHERE principal_id=?',principalId);if(!member||!['human','machine'].includes(member.kind)||member.revoked)stop('NATIVE_MACHINE_PRINCIPAL_UNAVAILABLE',403);return member;}
 function checkedScopes(input,principalId=machinePrincipalId){
  if(!Array.isArray(input)||input.length<1||input.length>NATIVE_MACHINE_SCOPES.length||new Set(input).size!==input.length||input.some(scope=>typeof scope!=='string'||!NATIVE_MACHINE_SCOPES.includes(scope)))stop('NATIVE_MACHINE_SCOPES_INVALID',400);
  if(input.includes('wiki:write')&&!input.includes('wiki:read')||input.some(scope=>['issue:write','comment:write','claim:write','progress:write','issue:transition'].includes(scope))&&!input.includes('issue:read'))stop('NATIVE_MACHINE_SCOPES_INVALID',400);
  for(const scope of input)if(!get(db,'SELECT 1 FROM principal_scope WHERE principal_id=? AND scope=?',principalId,scope))stop('NATIVE_MACHINE_SCOPE_DENIED',403);
  return [...input].sort();
 }
 const requestHash=(expiresAt,scopes,principalId=machinePrincipalId)=>hash(JSON.stringify([workspaceId,principalId,expiresAt,scopes]));
 function owner(request){
  if(request.headers.has('authorization')||request.method!=='POST'||new URL(request.url).search)stop('NATIVE_MACHINE_OWNER_REQUIRED',403);
  // The injected function is the app-auth module's live-session + session-CSRF
  // method, never a caller-provided actor. It executes inside this transaction.
  const actor=authorizeOwnerMutation(request),a=get(db,'SELECT a.*,m.kind,m.revoked AS member_revoked,c.revoked AS credential_revoked,c.expires_at FROM app_auth_principal a JOIN membership m ON m.principal_id=a.principal_id JOIN credential c ON c.id=a.credential_id AND c.principal_id=a.principal_id WHERE a.principal_id=?',humanPrincipalId);
  if(actor?.source!=='app_session'||actor.actorKind!=='human'||actor.workspaceId!==workspaceId||actor.principalId!==humanPrincipalId||!a||a.role!=='owner'||a.disabled||a.kind!=='human'||a.member_revoked||a.credential_revoked||a.expires_at<=time()||actor.credentialId!==a.credential_id||actor.authVersion!==a.auth_version||actor.grantGeneration!==a.grant_generation||actor.credentialExpiresAt<=time())stop('NATIVE_MACHINE_OWNER_REQUIRED',403);
  return actor;
 }
 function metadata(row){const credential=get(db,'SELECT * FROM credential WHERE id=?',row.credential_id);return {credentialId:row.credential_id,principalId:machinePrincipalId,scopes:all(db,'SELECT scope FROM credential_scope WHERE credential_id=? ORDER BY scope',row.credential_id).map(x=>x.scope),expiresAt:credential.expires_at,createdAt:row.created_at,revoked:Boolean(row.revoked_at!==null||credential.revoked)};}
 function issue(request,input){
  if(!only(input,['operationId','scopes','expiresAt'])||!id(input.operationId)||!millis(input.expiresAt))stop('NATIVE_MACHINE_INPUT_INVALID',400);
  return tx(()=>{
   owner(request);machine();const at=time(),scopes=checkedScopes(input.scopes),fingerprint=requestHash(input.expiresAt,scopes),prior=get(db,'SELECT * FROM native_machine_credential WHERE operation_id=?',input.operationId);
   if(prior){if(prior.request_hash!==fingerprint||prior.issued_by!==humanPrincipalId||prior.auth_epoch!==authEpoch)stop('NATIVE_MACHINE_OPERATION_REUSED',409);return {credential:metadata(prior),tokenUnavailable:true,replayed:true};}
   if(input.expiresAt<=at||input.expiresAt-at>maxLifetimeMs)stop('NATIVE_MACHINE_EXPIRY_INVALID',400);
   if(get(db,'SELECT count(*) AS n FROM native_machine_credential').n>=128||get(db,'SELECT count(*) AS n FROM native_machine_credential n JOIN credential c ON c.id=n.credential_id WHERE n.revoked_at IS NULL AND c.revoked=0 AND c.expires_at>?',at).n>=8)stop('NATIVE_MACHINE_CAPACITY',409);
   const credentialId=randomUUID(),token=NATIVE_MACHINE_PREFIX+credentialId+'_'+randomBytes(32).toString('base64url');
   run(db,'INSERT INTO credential(id,principal_id,expires_at,revoked,can_read,can_write) VALUES(?,?,?,0,1,?)',credentialId,machinePrincipalId,input.expiresAt,scopes.some(scope=>scope.endsWith(':write')||scope==='issue:transition')?1:0);
   for(const scope of scopes)run(db,'INSERT INTO credential_scope(credential_id,scope) VALUES(?,?)',credentialId,scope);
   run(db,'INSERT INTO native_machine_credential VALUES(?,?,?,?,?,?,?,NULL)',credentialId,hash(token),authEpoch,humanPrincipalId,input.operationId,fingerprint,at);
   return {credential:metadata(get(db,'SELECT * FROM native_machine_credential WHERE credential_id=?',credentialId)),token,replayed:false};
  });
 }
 function revoke(request,input){
  if(!only(input,['credentialId'])||!id(input.credentialId))stop('NATIVE_MACHINE_INPUT_INVALID',400);
  return tx(()=>{owner(request);const row=get(db,'SELECT n.* FROM native_machine_credential n JOIN credential c ON c.id=n.credential_id WHERE n.credential_id=? AND c.principal_id=?',input.credentialId,machinePrincipalId);if(!row){const grant=get(db,'SELECT * FROM native_machine_grant WHERE credential_id=? AND principal_id=?',input.credentialId,machinePrincipalId);if(!grant||grant.issued_by!==humanPrincipalId)stop('NATIVE_MACHINE_NOT_FOUND',404);run(db,'UPDATE native_machine_grant SET revoked_at=COALESCE(revoked_at,?) WHERE grant_id=?',time(),grant.grant_id);return {grant:grantMetadata(get(db,'SELECT * FROM native_machine_grant WHERE grant_id=?',grant.grant_id))};}if(row.issued_by!==humanPrincipalId)stop('NATIVE_MACHINE_NOT_FOUND',404);run(db,'UPDATE native_machine_grant SET revoked_at=COALESCE(revoked_at,?) WHERE credential_id=?',time(),input.credentialId);run(db,'UPDATE credential SET revoked=1 WHERE id=?',input.credentialId);run(db,'UPDATE native_machine_credential SET revoked_at=COALESCE(revoked_at,?) WHERE credential_id=?',time(),input.credentialId);return {credential:metadata(get(db,'SELECT * FROM native_machine_credential WHERE credential_id=?',input.credentialId))};});
 }
 function list(request,input){
  if(!only(input,[]))stop('NATIVE_MACHINE_INPUT_INVALID',400);
  return tx(()=>{owner(request);if(!id(machinePrincipalId))stop('NATIVE_MACHINE_PRINCIPAL_UNAVAILABLE',403);const member=get(db,'SELECT kind,revoked FROM membership WHERE principal_id=?',machinePrincipalId);const allowedScopes=['human','machine'].includes(member?.kind)&&!member.revoked?NATIVE_MACHINE_SCOPES.filter(scope=>get(db,'SELECT 1 FROM principal_scope WHERE principal_id=? AND scope=?',machinePrincipalId,scope)):[];return {principalId:machinePrincipalId,allowedScopes,maxLifetimeMs,maxRedeemLifetimeMs,grantGeneration:grantGeneration(),pairingGrants:all(db,'SELECT * FROM native_machine_grant WHERE principal_id=? ORDER BY generation',machinePrincipalId).map(grantMetadata),credentials:all(db,'SELECT n.* FROM native_machine_credential n JOIN credential c ON c.id=n.credential_id WHERE c.principal_id=? ORDER BY n.created_at,n.credential_id',machinePrincipalId).map(metadata)};});
 }
 function pairingConfig(){let url;try{url=new URL(origin);}catch{}if(!url||url.protocol!=='https:'||url.origin!==origin||!Number.isSafeInteger(maxRedeemLifetimeMs)||maxRedeemLifetimeMs<1||maxRedeemLifetimeMs>3600000)stop('NATIVE_PAIRING_CONFIG_INVALID',503);}
 const grantGeneration=()=>get(db,'SELECT COALESCE(MAX(generation),0) AS generation FROM native_machine_grant').generation;
 function grantMetadata(g){return {grantId:g.grant_id,credentialId:g.credential_id,principalId:g.principal_id,fingerprint:g.secret_digest,scopes:JSON.parse(g.scopes_json),expiresAt:g.expires_at,redeemExpiresAt:g.redeem_expires_at,generation:g.generation,consumed:g.consumed_at!==null,revoked:g.revoked_at!==null};}
 function approvePairing(request,input){
  pairingConfig();
  if(!only(input,['grantId','credentialId','secretDigest','scopes','expiresAt','redeemExpiresAt','expectedGeneration'])||!id(input.grantId)||!id(input.credentialId)||! /^[0-9a-f]{64}$/.test(input.secretDigest)||!millis(input.expiresAt)||!millis(input.redeemExpiresAt)||!millis(input.expectedGeneration))stop('NATIVE_MACHINE_INPUT_INVALID',400);
  return tx(()=>{const actor=owner(request);machine();const at=time(),scopes=checkedScopes(input.scopes),fingerprint=hash(JSON.stringify([input.grantId,input.credentialId,input.secretDigest,scopes,input.expiresAt,input.redeemExpiresAt,input.expectedGeneration,workspaceId,machinePrincipalId])),prior=get(db,'SELECT * FROM native_machine_grant WHERE grant_id=?',input.grantId);
   if(prior){if(prior.principal_id!==machinePrincipalId||prior.request_hash!==fingerprint||prior.auth_epoch!==authEpoch||prior.issued_by!==humanPrincipalId||prior.owner_auth_version!==actor.authVersion||prior.owner_grant_generation!==actor.grantGeneration)stop('NATIVE_MACHINE_OPERATION_REUSED',409);return {grant:grantMetadata(prior),replayed:true};}
   if(input.expiresAt<=at||input.expiresAt>at+maxLifetimeMs||input.redeemExpiresAt<=at||input.redeemExpiresAt>Math.min(input.expiresAt,at+maxRedeemLifetimeMs))stop('NATIVE_MACHINE_EXPIRY_INVALID',400);
   if(input.expectedGeneration!==grantGeneration()||input.expectedGeneration>=Number.MAX_SAFE_INTEGER)stop('NATIVE_PAIRING_GENERATION_CHANGED',409);
   if(get(db,'SELECT count(*) AS n FROM native_machine_grant').n>=128)stop('NATIVE_MACHINE_CAPACITY',409);
   if(get(db,'SELECT 1 FROM credential WHERE id=?',input.credentialId)||get(db,'SELECT 1 FROM native_machine_grant WHERE credential_id=? OR secret_digest=?',input.credentialId,input.secretDigest))stop('NATIVE_MACHINE_OPERATION_REUSED',409);
   run(db,'UPDATE native_machine_grant SET revoked_at=? WHERE consumed_at IS NULL AND revoked_at IS NULL',at);
   run(db,'INSERT INTO native_machine_grant VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)',input.grantId,input.credentialId,machinePrincipalId,input.secretDigest,JSON.stringify(scopes),input.expiresAt,input.redeemExpiresAt,authEpoch,humanPrincipalId,actor.authVersion,actor.grantGeneration,input.expectedGeneration+1,fingerprint,at);
   return {grant:grantMetadata(get(db,'SELECT * FROM native_machine_grant WHERE grant_id=?',input.grantId)),replayed:false};
  });
 }
 function redeemPairing(request,input){
  pairingConfig();
  if(request.method!=='POST'||new URL(request.url).origin!==origin||new URL(request.url).search||request.headers.has('authorization')||request.headers.has('cookie')||request.headers.has('origin')&&request.headers.get('origin')!==origin)stop('NATIVE_PAIRING_PROOF_REQUIRED',401);
  if(!only(input,['grantId','secret'])||!id(input.grantId)||typeof input.secret!=='string'||! /^[A-Za-z0-9_-]{43}$/.test(input.secret)||Buffer.from(input.secret,'base64url').toString('base64url')!==input.secret)stop('NATIVE_PAIRING_PROOF_REQUIRED',401);
  return tx(()=>{const g=get(db,'SELECT * FROM native_machine_grant WHERE grant_id=?',input.grantId),at=time();if(!g||g.principal_id!==machinePrincipalId||!equal(g.secret_digest,hash(Buffer.from(input.secret,'base64url'))))stop('NATIVE_PAIRING_PROOF_REQUIRED',401);
   const a=get(db,'SELECT a.*,m.kind,m.revoked AS member_revoked,c.revoked AS credential_revoked,c.expires_at FROM app_auth_principal a JOIN membership m ON m.principal_id=a.principal_id JOIN credential c ON c.id=a.credential_id AND c.principal_id=a.principal_id WHERE a.principal_id=?',humanPrincipalId);
   if(!a||a.role!=='owner'||a.disabled||a.kind!=='human'||a.member_revoked||a.credential_revoked||a.expires_at<=at||a.auth_version!==g.owner_auth_version||a.grant_generation!==g.owner_grant_generation||g.auth_epoch!==authEpoch||g.issued_by!==humanPrincipalId||g.revoked_at!==null)stop('NATIVE_PAIRING_AUTHORITY_CHANGED',403);
   machine();const scopes=checkedScopes(JSON.parse(g.scopes_json));if(g.request_hash!==hash(JSON.stringify([g.grant_id,g.credential_id,g.secret_digest,scopes,g.expires_at,g.redeem_expires_at,g.generation-1,workspaceId,machinePrincipalId])))stop('NATIVE_PAIRING_AUTHORITY_CHANGED',403);const token=NATIVE_MACHINE_PREFIX+g.credential_id+'_'+input.secret,prior=get(db,'SELECT * FROM native_machine_credential WHERE credential_id=?',g.credential_id);
   if(g.consumed_at!==null){if(!prior||!equal(prior.token_hash,hash(token)))stop('NATIVE_PAIRING_UNAVAILABLE',409);authenticate(new Request(origin,{headers:{authorization:'Bearer '+token}}));return {credential:metadata(prior),replayed:true};}
   if(at>=g.redeem_expires_at||at>=g.expires_at)stop('NATIVE_PAIRING_EXPIRED',403);if(g.generation!==grantGeneration())stop('NATIVE_PAIRING_GENERATION_CHANGED',409);
   if(get(db,'SELECT count(*) AS n FROM native_machine_credential').n>=128||get(db,'SELECT count(*) AS n FROM native_machine_credential n JOIN credential c ON c.id=n.credential_id WHERE n.revoked_at IS NULL AND c.revoked=0 AND c.expires_at>?',at).n>=8)stop('NATIVE_MACHINE_CAPACITY',409);
   if(prior||get(db,'SELECT 1 FROM credential WHERE id=?',g.credential_id))stop('NATIVE_MACHINE_OPERATION_REUSED',409);
   run(db,'INSERT INTO credential(id,principal_id,expires_at,revoked,can_read,can_write) VALUES(?,?,?,0,1,?)',g.credential_id,machinePrincipalId,g.expires_at,scopes.some(scope=>scope.endsWith(':write')||scope==='issue:transition')?1:0);
   for(const scope of scopes)run(db,'INSERT INTO credential_scope VALUES(?,?)',g.credential_id,scope);
   run(db,'INSERT INTO native_machine_credential VALUES(?,?,?,?,?,?,?,NULL)',g.credential_id,hash(token),authEpoch,humanPrincipalId,g.grant_id,requestHash(g.expires_at,scopes),at);
   run(db,'UPDATE native_machine_grant SET consumed_at=? WHERE grant_id=?',at,g.grant_id);
   return {credential:metadata(get(db,'SELECT * FROM native_machine_credential WHERE credential_id=?',g.credential_id)),replayed:false};
  });
 }
 function authenticate(request){
  const header=request.headers.get('authorization')??'',cookie=request.headers.get('cookie')??'';
  if(cookie.length>16384||cookie.split(';').some(part=>part.trim().split('=',1)[0]==='__Host-projektor_session'))stop('AUTH_CREDENTIAL_AMBIGUOUS');
  if(!header.startsWith('Bearer '))stop('UNAUTHENTICATED');const token=header.slice(7),match=token.match(tokenPattern);
  if(!match||Buffer.from(match[2],'base64url').toString('base64url')!==match[2])stop('UNAUTHENTICATED');
  // Caller must invoke again within the final domain transaction. No cached
  // bearer verification authorizes a later command, receipt or protocol request.
  const row=get(db,'SELECT n.*,c.principal_id,c.expires_at,c.revoked,c.can_read,c.can_write FROM native_machine_credential n JOIN credential c ON c.id=n.credential_id WHERE n.credential_id=?',match[1]);
  if(!row||!equal(row.token_hash,hash(token))||row.auth_epoch!==authEpoch||!id(row.principal_id))stop('UNAUTHENTICATED');
  const at=time();if(row.expires_at<=at)stop('CREDENTIAL_EXPIRED');if(row.revoked||row.revoked_at!==null)stop('FORBIDDEN',403);machine(row.principal_id);
  const scopes=checkedScopes(all(db,'SELECT scope FROM credential_scope WHERE credential_id=? ORDER BY scope',row.credential_id).map(x=>x.scope),row.principal_id);
  if(row.request_hash!==requestHash(row.expires_at,scopes,row.principal_id)||row.can_read!==1||row.can_write!==(scopes.some(scope=>scope.endsWith(':write')||scope==='issue:transition')?1:0))stop('FORBIDDEN',403);
  return Object.freeze({source:'app_machine',workspaceId,principalId:row.principal_id,credentialId:row.credential_id,principalKind:machine(row.principal_id).kind,actorKind:'machine',credentialExpiresAt:row.expires_at,authenticatedAt:at,authMethod:'native_bearer',requestId:randomUUID()});
 }
 return Object.freeze({issue,revoke,list,approvePairing,redeemPairing,authenticate});
}
