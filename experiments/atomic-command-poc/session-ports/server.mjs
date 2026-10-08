// Internal Store ports only. Caller invokes inside the same Store transaction as
// current identity/credential authorization. These are not public actor RPCs.
import {randomBytes, randomUUID} from 'node:crypto';
import {authorized, canonical} from '../src/shared-core.mjs';
import {currentRead,currentWrite,historicRead,scopeAllowed,resourceScope,hasScope,scopeManageAllowed} from '../src/resource-access.mjs';
export class SessionPortError extends Error {constructor(code,status=403){super(code);this.code=code;this.status=status;}}
const stop=(code,status)=>{throw new SessionPortError(code,status);};
export const isId=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x);
const get=(db,s,...a)=>db.prepare(s).get(...a);
const all=(db,s,...a)=>db.prepare(s).all(...a);
export function currentSession(db,verified,workspaceId,{now=Date.now()}={}) {
 if(!isId(workspaceId)||verified?.actorKind!=='human'||!Number.isSafeInteger(verified.credentialExpiresAt))stop('UNAUTHENTICATED',401);
 const w=get(db,'SELECT * FROM workspace');
 if(!w)stop('STORE_UNINITIALIZED',503);
 if(w.id!==workspaceId)stop('WORKSPACE_MISMATCH');
 const rows=all(db,'SELECT principal_id,credential_id FROM identity_binding WHERE issuer=? AND subject=? AND kind=? LIMIT 2',verified.issuer,verified.subject,'human');
 if(rows.length!==1)stop(rows.length?'IDENTITY_BINDING_AMBIGUOUS':'UNAUTHENTICATED',401);
 const actor={...verified,workspaceId,principalId:rows[0].principal_id,credentialId:rows[0].credential_id};
 const denied=authorized(db,actor,workspaceId,w.epoch,now);
 if(denied)stop(denied==='EXPIRED'?'SESSION_EXPIRED':denied,['UNAUTHENTICATED','EXPIRED'].includes(denied)?401:denied==='STORE_FENCED'?503:403);
 const credential=get(db,'SELECT * FROM credential WHERE id=?',actor.credentialId);
 const scopes=all(db,'SELECT p.scope FROM principal_scope p JOIN credential_scope c ON c.scope=p.scope WHERE p.principal_id=? AND c.credential_id=? ORDER BY p.scope',actor.principalId,actor.credentialId).map(r=>r.scope);
 const revision=get(db,'SELECT revision FROM query_state WHERE id=1')?.revision;
 if(!Number.isSafeInteger(revision)||revision<0)stop('STORE_STATE_UNAVAILABLE',503);
 return {actor,session:{principalId:actor.principalId,workspaceId,workspaceEpoch:w.epoch,actorKind:'human',sessionId:actor.credentialId,authzVersion:revision,scopes,expiresAt:Math.min(verified.credentialExpiresAt,credential.expires_at),serverTime:now,renewalMode:'unknown',globalSessionExpiresAt:null}};
}
export function bootstrapMembership(db,verified,workspaceId,options) {return currentSession(db,verified,workspaceId,options).session;}
export function validateBinding(binding){
 const keys=['principalId','workspaceId','workspaceEpoch','resourceType','resourceId','editorId','projectAtProtection','draftId'];
 if(!binding||typeof binding!=='object'||Array.isArray(binding)||Object.keys(binding).length!==keys.length||keys.some(k=>!Object.hasOwn(binding,k))||!['principalId','workspaceId','workspaceEpoch','resourceId','draftId'].every(k=>isId(binding[k]))||!['issue','project','wiki','workspace'].includes(binding.resourceType)||typeof binding.editorId!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(binding.editorId)||binding.projectAtProtection!==null&&!isId(binding.projectAtProtection))stop('VALIDATION',400);
 if(binding.editorId==='wiki-create'){
  if(binding.resourceType==='project'){if(binding.resourceId!==binding.projectAtProtection)stop('VALIDATION',400);}
  else if(binding.resourceType==='workspace'){if(binding.resourceId!==binding.workspaceId||binding.projectAtProtection!==null)stop('VALIDATION',400);}
  else stop('VALIDATION',400);
 }else if(binding.resourceType==='workspace')stop('VALIDATION',400);
 if(!['wiki','workspace'].includes(binding.resourceType)&&binding.projectAtProtection===null)stop('VALIDATION',400);
}
function authorizeDraft(db,actor,binding,{creating=false}={}){
 const original=binding.projectAtProtection===null?{kind:'workspace_shared'}:{kind:'project',projectId:binding.projectAtProtection};
 if(!scopeAllowed(db,actor,original))stop('DRAFT_FORBIDDEN');
 if(binding.projectAtProtection!==null){const p=get(db,'SELECT deleted FROM project WHERE id=?',binding.projectAtProtection);if(!p||p.deleted)stop('DRAFT_FORBIDDEN');}
 // wiki-create/v1: draftId is the preallocated Wiki page ID, never a title alias.
 if(binding.editorId==='wiki-create'){
  if(!hasScope(db,actor,'wiki:read')||!hasScope(db,actor,'wiki:write')||!scopeAllowed(db,actor,original,'write'))stop('DRAFT_FORBIDDEN');
  const page=get(db,'SELECT id FROM wiki_page WHERE id=?',binding.draftId);
  const history=get(db,"SELECT 1 AS present FROM content_revision WHERE resource_type='wiki' AND resource_id=? LIMIT 1",binding.draftId);
  // Never retrofit a new broad creation key, or treat a disappeared page as new.
  if(creating&&(page||history)||!page&&history)stop('DRAFT_FORBIDDEN');
  if(page&&!currentRead(db,actor,{type:'wiki',id:binding.draftId}))stop('DRAFT_FORBIDDEN');
  return;
 }
 if(binding.resourceType==='project'){
  const p=get(db,'SELECT deleted FROM project WHERE id=?',binding.resourceId);
  if(!p||p.deleted||binding.resourceId!==binding.projectAtProtection||!scopeAllowed(db,actor,{kind:'project',projectId:binding.resourceId})||!hasScope(db,actor,'issue:read'))stop('DRAFT_FORBIDDEN');
 }else{
  const resource={type:binding.resourceType,id:binding.resourceId};
  const state=resourceScope(db,resource);
  if(resource.type==='wiki'&&state?.deleted&&binding.editorId==='wiki-content'){
   const revision=get(db,"SELECT * FROM content_revision WHERE id=? AND resource_type='wiki' AND resource_id=?",state.row.current_revision_id,resource.id);
   if(!hasScope(db,actor,'wiki:read')||!hasScope(db,actor,'wiki:write')||!hasScope(db,actor,'wiki:restore')||!scopeManageAllowed(db,actor,state.scope)||!currentRead(db,actor,resource,{allowDeleted:true})||!currentWrite(db,actor,resource,{allowDeleted:true})||!revision||!historicRead(db,actor,revision))stop('DRAFT_FORBIDDEN');
  }else if(!currentRead(db,actor,resource)||!hasScope(db,actor,`${binding.resourceType}:read`))stop('DRAFT_FORBIDDEN');
  if(creating&&canonical(resourceScope(db,resource)?.scope)!==canonical(original))stop('DRAFT_ORIGINAL_SCOPE_MISMATCH');
 }
}
export function draftKey(db,verified,{binding,keyId},{now=Date.now()}={}){
 validateBinding(binding);if(keyId!==undefined&&!isId(keyId))stop('VALIDATION',400);
 const {actor,session}=currentSession(db,verified,binding.workspaceId,{now});
 if(binding.principalId!==session.principalId||binding.workspaceEpoch!==session.workspaceEpoch)stop('DRAFT_BINDING_MISMATCH');
 const json=canonical(binding);
 let row=keyId?get(db,'SELECT * FROM draft_key WHERE key_id=?',keyId):get(db,'SELECT * FROM draft_key WHERE binding_json=?',json);
 if(keyId&&!row)stop('DRAFT_KEY_UNAVAILABLE',404);
 if(row&&(row.binding_json!==json||row.revoked||row.expires_at<=now))stop('DRAFT_KEY_UNAVAILABLE');
 authorizeDraft(db,actor,binding,{creating:!row});
 if(!row){
  row={key_id:randomUUID(),binding_json:json,key_material:randomBytes(32).toString('base64'),created_at:now,expires_at:now+7*86400000};
  db.prepare('INSERT INTO draft_key VALUES(?,?,?,?,?,0)').run(row.key_id,json,row.key_material,row.created_at,row.expires_at);
 }
 return {keyId:row.key_id,key:row.key_material,leaseExpiresAt:Math.min(now+300000,session.expiresAt,row.expires_at),session};
}
