// Resource policy management uses the same authenticated Store transaction and receipt port.
import {failure} from './shared-core.mjs';
import {currentRead,currentManage,resourceScope,resourcePolicy,policyIdentity} from './resource-access.mjs';
import {captureAccess,nativeAuthor} from './issue-content.mjs';
import {executeResourceCommand,commitResourceMutation} from './command-pipeline.mjs';
import {carryLinkView,currentLinkView} from './content-links.mjs';
const get=(db,s,...a)=>db.prepare(s).get(...a);
const one=(db,s,...a)=>{const r=db.prepare(s).run(...a);if(r.changes!==1)throw Error('Required policy write suppressed');};
const plain=x=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
const id=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x);
const shape=(x,keys)=>plain(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
export function validateResourceAccess(c){
 const p=c.payload;if(!shape(p,['resource','expectedPolicyVersion','policy'])||!shape(p.resource,['type','id'])||!['issue','wiki'].includes(p.resource.type)||!id(p.resource.id)||p.resource.id!==c.entityId||!Number.isSafeInteger(c.expectedVersion)||c.expectedVersion<1||!Number.isSafeInteger(p.expectedPolicyVersion)||p.expectedPolicyVersion<1)return 'VALIDATION';
 const policy=p.policy;if(!shape(policy,['mode','readerPrincipalIds','writerPrincipalIds'])||!['inherit','restricted'].includes(policy.mode))return 'VALIDATION';
 for(const k of ['readerPrincipalIds','writerPrincipalIds'])if(!Array.isArray(policy[k])||policy[k].length>4096||policy[k].some(x=>!id(x))||new Set(policy[k]).size!==policy[k].length)return 'VALIDATION';
 if(policy.writerPrincipalIds.some(x=>!policy.readerPrincipalIds.includes(x))||policy.mode==='inherit'&&(policy.readerPrincipalIds.length||policy.writerPrincipalIds.length))return 'VALIDATION';
 return null;
}
export function executeResourceAccess(db,actor,c,options={}){
 const invalid=validateResourceAccess(c);if(invalid)return failure(invalid);
 return executeResourceCommand(db,actor,c,options,({now,fault,save,reject})=>{
  const {resource,policy,expectedPolicyVersion}=c.payload,r=resourceScope(db,resource);
  if(!r||!currentRead(db,actor,resource))return reject('NOT_FOUND',[{redacted:true}]);
  const initial=captureAccess(db,resource),targets=[{resource,...initial}],bad=code=>reject(code,targets);
  if(!currentManage(db,actor,resource))return bad('FORBIDDEN');
  const old=resourcePolicy(db,resource),accessPolicyId=policyIdentity(db,resource);
  if(!old||!accessPolicyId)return bad('POLICY_MIGRATION_REQUIRED');
  if(r.row.version!==c.expectedVersion)return bad('VERSION_CONFLICT');
  if(old.policy_version!==expectedPolicyVersion)return bad('POLICY_VERSION_CONFLICT');
  if(policy.readerPrincipalIds.some(principalId=>!get(db,'SELECT 1 FROM membership WHERE principal_id=? AND revoked=0',principalId)))return bad('PRINCIPAL_INVALID');
  const readers=JSON.stringify([...policy.readerPrincipalIds].sort()),writers=JSON.stringify([...policy.writerPrincipalIds].sort());
  const same=old.mode===policy.mode&&JSON.stringify(JSON.parse(old.reader_principal_ids).sort())===readers&&JSON.stringify(JSON.parse(old.writer_principal_ids).sort())===writers;
  const version=r.row.version+(same?0:1),policyVersion=old.policy_version+(same?0:1);
  if(!Number.isSafeInteger(version)||!Number.isSafeInteger(policyVersion))return bad('VERSION_LIMIT_REACHED');
  const previousView=currentLinkView(db,resource,r.row.version);if(!previousView)return bad('POLICY_STATE_INCOMPLETE');
  let linkViewId=previousView.id;
  if(!same){
   fault('before_policy');
   one(db,'UPDATE resource_access SET policy_version=?,mode=?,reader_principal_ids=?,writer_principal_ids=? WHERE resource_type=? AND resource_id=? AND policy_version=?',policyVersion,policy.mode,readers,writers,resource.type,resource.id,expectedPolicyVersion);fault('after_policy');
   if(resource.type==='wiki')one(db,'UPDATE wiki_page SET version=?,updated_at=? WHERE id=? AND version=?',version,now,resource.id,c.expectedVersion);
   else one(db,'UPDATE issue SET version=? WHERE id=? AND version=?',version,resource.id,c.expectedVersion);
   fault('after_resource');
   const access=captureAccess(db,resource);linkViewId=carryLinkView(db,{resource,fromVersion:r.row.version,resourceVersion:version,access});if(!linkViewId)throw Error('Required policy LinkView carry missing');fault('after_policy_link_view');
  }
  // Search and count visibility consult currentRead, with query_state invalidated by
  // the policy UPDATE trigger in this very transaction. No text revision is fabricated.
  const resultMetadata={accessPolicyId,policyVersion,linkViewId};
  return commitResourceMutation(db,actor,c,{resource,version,revisionId:null,originalAuthorRef:nativeAuthor(actor),metadata:{...resultMetadata,previousPolicyVersion:old.policy_version},resultMetadata,now,fault,save,targets,effectApplied:!same});
 });
}
