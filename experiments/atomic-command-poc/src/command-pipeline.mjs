// Shared transaction/receipt port for additional capability modules. No second store.
import {authorized,failure,fingerprint,HASH_VERSION,transaction} from './shared-core.mjs';
import {receiptScope} from './resource-access.mjs';
const get=(db,s,...a)=>db.prepare(s).get(...a);
function one(db,s,...a){const r=db.prepare(s).run(...a);if(r.changes!==1)throw Error('Required capability write invariant');return r;}
export function executeResourceCommand(db,actor,c,{now,fault=()=>{}}={},handler){
 const hash=fingerprint(actor,c);
 return transaction(db,()=>{
  fault('before_authorization');now??=Date.now();const denied=authorized(db,actor,c.workspaceId,c.workspaceEpoch,now);if(denied)return failure(denied);
  const old=get(db,'SELECT * FROM operation WHERE workspace_id=? AND principal_id=? AND operation_id=?',c.workspaceId,actor.principalId,c.operationId);
  if(old){if(!receiptScope(db,actor,old))return failure('FORBIDDEN');if(old.hash_version!==HASH_VERSION||old.payload_hash!==hash)return failure('KEY_REUSE');return JSON.parse(old.result_json);}
  const save=(result,targets)=>{
   if(!Array.isArray(targets)||!targets.length)throw Error('Receipt target evidence required');
   one(db,'INSERT INTO operation VALUES(?,?,?,?,?,?,?,?)',c.workspaceId,actor.principalId,c.operationId,HASH_VERSION,hash,c.entityId,null,JSON.stringify(result));
   one(db,'INSERT INTO operation_targets VALUES(?,?,?,?)',c.workspaceId,actor.principalId,c.operationId,JSON.stringify(targets));
   return result;
  };
  return handler({now,fault,save,reject:(code,targets)=>save(failure(code,'rejected'),targets)});
 });
}
export function commitResourceMutation(db,actor,c,{resource,version,revisionId=null,subresourceId=null,originalAuthorRef,beforeTitle='',afterTitle='',metadata={},resultMetadata={},now,fault=()=>{},save,targets,effectApplied=true}){
 if(!effectApplied)return save({data:{outcome:'committed',effectApplied:false,entityId:c.entityId,committedVersion:version,revisionId,commitSeq:get(db,'SELECT change_seq FROM workspace WHERE id=?',c.workspaceId).change_seq,serverTime:now,...resultMetadata},meta:{workspaceId:c.workspaceId,actorId:actor.principalId,operationId:c.operationId}},targets);
 one(db,'UPDATE workspace SET change_seq=change_seq+1 WHERE id=?',c.workspaceId);const seq=get(db,'SELECT change_seq FROM workspace WHERE id=?',c.workspaceId).change_seq;fault('after_sequence');
 one(db,'INSERT INTO activity VALUES(?,?,?,?,?,?,?)',seq,resource.type==='issue'?resource.id:null,c.operationId,actor.principalId,beforeTitle,afterTitle,version);
 one(db,'INSERT INTO content_activity VALUES(?,?,?,?,?,?,?,?,?)',seq,resource.type,resource.id,c.commandType,subresourceId,revisionId,JSON.stringify(originalAuthorRef),actor.principalId,JSON.stringify(metadata));fault('after_activity');
 one(db,'INSERT INTO outbox VALUES(?,?,?,?)',`${actor.principalId}:${c.operationId}`,seq,JSON.stringify({resource,version,revisionId}),'pending');fault('after_outbox');
 const result=save({data:{outcome:'committed',effectApplied:true,entityId:c.entityId,committedVersion:version,revisionId,commitSeq:seq,serverTime:now,...resultMetadata},meta:{workspaceId:c.workspaceId,actorId:actor.principalId,operationId:c.operationId}},targets);fault('after_receipt');return result;
}
