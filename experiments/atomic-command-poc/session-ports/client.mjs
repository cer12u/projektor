import {contentJSON,validateContentSession,validateContentIssue} from '../client/issue-content.mjs';
import {DraftVault,canonical} from '../browser/draft-vault.mjs';
const id=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x);
export function createSessionAPI({baseUrl=globalThis.location?.origin,fetchImpl=globalThis.fetch,deadlineMs=5000}={}){
 const base=new URL(baseUrl);
 if(!['http:','https:'].includes(base.protocol)||base.username||base.password||globalThis.location&&globalThis.location.origin!==base.origin)throw Error('CROSS_ORIGIN_ENDPOINT');
 const ajax=(url,options)=>fetchImpl(url,{...options,headers:{...options.headers,'X-Requested-With':'XMLHttpRequest'}});
 const read=(path,options)=>contentJSON(ajax,new URL(path,base.origin),{deadlineMs,...options});
 return {
  async bootstrap(options){const b=await read('/v1/bootstrap',options);if(b.actorKind!=='human'||b.principalId!==null&&!id(b.principalId)||!Array.isArray(b.workspaces)||b.workspaces.length>10||b.workspaces.some(w=>!id(w.workspaceId)||!id(w.workspaceEpoch)||!id(w.principalId)||typeof w.name!=='string')||new Set(b.workspaces.map(w=>w.workspaceId)).size!==b.workspaces.length||!Number.isSafeInteger(b.expiresAt)||b.expiresAt<=Date.now())throw Error('PROTOCOL_ERROR');return b;},
  async session({workspaceId,signal}={}){if(!id(workspaceId))throw Error('WORKSPACE_SELECTION_REQUIRED');const s=validateContentSession(await read(`/v1/session?workspaceId=${encodeURIComponent(workspaceId)}`,{signal}));if(s.workspaceId!==workspaceId)throw Error('WORKSPACE_MISMATCH');return s;},
  keyProvider:(binding,keyId)=>read('/v1/draft-keys',{method:'POST',body:{binding,...(keyId?{keyId}:{})}})
 };
}
export function createContentProtection({api,issueId,projectId,draftId,projectAtProtection,dbName,fault=()=>null,onBinding=()=>{},dirty=()=>false,keyProvider,resourceType,editorId}){
 if(!id(draftId))throw Error('DRAFT_ID_REQUIRED');
 if(!keyProvider)keyProvider=createSessionAPI().keyProvider;
 let binding=null,branchConflict=false;
 const vault=new DraftVault({dbName,fault,keyProvider});
 async function ensure(session,guard){
  if(binding){if(binding.principalId!==session.principalId||binding.workspaceId!==session.workspaceId||binding.workspaceEpoch!==session.workspaceEpoch){vault.clearKeys();throw Error('DRAFT_BINDING_MISMATCH');}return;}
  let project=projectId??projectAtProtection;
  if(project===undefined){const body=await api.issue({session,issueId});if(!guard())throw Error('STALE_CONTEXT');project=validateContentIssue(body,session,issueId).project_id;}
  if(!guard())throw Error('STALE_CONTEXT');
  binding={principalId:session.principalId,workspaceId:session.workspaceId,workspaceEpoch:session.workspaceEpoch,resourceType:resourceType??(projectId?'project':'issue'),resourceId:projectId??issueId,editorId:editorId??(projectId?'issue-create':'content'),projectAtProtection:project,draftId};onBinding(structuredClone(binding));
 }
 return {vault,get binding(){return binding&&structuredClone(binding);},lock(){vault.clearKeys();},
  async restore(session,guard){if(branchConflict)throw Error('DRAFT_WRITE_CONFLICT');await ensure(session,guard);if(await vault.tombstoned(session.sessionId))throw Error('SESSION_TOMBSTONED');const oldHead=vault.heads.get(canonical(binding));const stored=await vault.restore(binding,session,guard);if(oldHead!==undefined&&oldHead!==vault.heads.get(canonical(binding))&&dirty()){branchConflict=true;throw Error('DRAFT_WRITE_CONFLICT');}return stored;},
  async unlock(session,guard){await ensure(session,guard);await vault.key(binding,null,session,{fresh:true});if(!guard())throw Error('STALE_CONTEXT');},
  persist(record,session,guard){if(branchConflict||!binding)throw Error('DRAFT_WRITE_CONFLICT');return vault.persist(binding,record,session,guard);},
  expiresAt(){return binding?vault.keys.get(canonical(binding))?.leaseExpiresAt:0;}
 };
}
