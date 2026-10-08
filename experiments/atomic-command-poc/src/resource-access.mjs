// Synchronous transaction ports. The caller must authenticate in the same transaction.
const get=(db,s,...a)=>db.prepare(s).get(...a);
export function hasScope(db,actor,scope){return Boolean(get(db,'SELECT 1 FROM principal_scope WHERE principal_id=? AND scope=?',actor.principalId,scope)&&get(db,'SELECT 1 FROM credential_scope WHERE credential_id=? AND scope=?',actor.credentialId,scope));}
export function scopeAllowed(db,actor,scope,mode='read'){
 const cred=get(db,'SELECT * FROM credential WHERE id=?',actor.credentialId);
 if(!cred?.['can_'+mode])return false;
 if(scope?.kind==='project')return typeof scope.projectId==='string'&&Boolean(get(db,'SELECT * FROM project_grant WHERE principal_id=? AND project_id=?',actor.principalId,scope.projectId)?.['can_'+mode]);
 if(scope?.kind==='workspace_shared')return Boolean(get(db,'SELECT * FROM shared_grant WHERE principal_id=?',actor.principalId)?.['can_'+mode]);
 return false;
}
export function audienceAllowed(db,actor,policy,mode='read'){
 if(!policy)return true;
 if(policy.mode==='inherit')return true;
 if(policy.mode!=='restricted')return false;
 const read=JSON.parse(policy.reader_principal_ids).includes(actor.principalId);
 return read&&(mode==='read'||JSON.parse(policy.writer_principal_ids).includes(actor.principalId));
}
export function resourcePolicy(db,resource){return get(db,'SELECT * FROM resource_access WHERE resource_type=? AND resource_id=?',resource.type,resource.id);}
export function resourceScope(db,resource){
 if(typeof resource?.id!=='string')return null;
 if(resource.type==='issue'){const row=get(db,'SELECT * FROM issue WHERE id=?',resource.id);return row?{scope:{kind:'project',projectId:row.project_id},deleted:Boolean(row.deleted),row}:null;}
 if(resource.type==='wiki'){const row=get(db,'SELECT * FROM wiki_page WHERE id=?',resource.id);return row?{scope:JSON.parse(row.scope),deleted:row.deleted_at!==null,row}:null;}
 return null;
}
export function currentRead(db,actor,resource,{allowDeleted=false}={}){
 const r=resourceScope(db,resource);if(!r)return false;
 const member=get(db,'SELECT * FROM membership WHERE principal_id=?',actor.principalId),cred=get(db,'SELECT * FROM credential WHERE id=?',actor.credentialId);
 if(!member||member.revoked||!cred||cred.revoked||cred.principal_id!==actor.principalId)return false;
 if(r.deleted&&(!allowDeleted||!hasScope(db,actor,'deleted:read')))return false;
 if(resourcePolicy(db,resource)&&!hasScope(db,actor,resource.type+':read'))return false;
 if(!scopeAllowed(db,actor,r.scope)||!audienceAllowed(db,actor,resourcePolicy(db,resource)))return false;
 if(resource.type==='issue'){
  const q=get(db,'SELECT restricted_read FROM issue_queue WHERE issue_id=?',resource.id);
  if(q?.restricted_read&&!get(db,'SELECT can_read FROM issue_read_grant WHERE issue_id=? AND principal_id=?',resource.id,actor.principalId)?.can_read)return false;
 }
 return true;
}
export function currentWrite(db,actor,resource,options={}){const r=resourceScope(db,resource);return Boolean(r&&currentRead(db,actor,resource,options)&&(!resourcePolicy(db,resource)||hasScope(db,actor,resource.type+':write'))&&scopeAllowed(db,actor,r.scope,'write')&&audienceAllowed(db,actor,resourcePolicy(db,resource),'write'));}
export function originalRead(db,actor,originalScope,accessSnapshotId,resource){
 const evidence=typeof originalScope==='string'?JSON.parse(originalScope):originalScope;
 if(evidence?.state!=='known'||!scopeAllowed(db,actor,evidence.scope))return false;
 const snapshot=accessSnapshotId&&get(db,'SELECT * FROM access_snapshot WHERE id=?',accessSnapshotId);
 return Boolean(snapshot&&evidence.resourcePolicyAtRevisionId===snapshot.id&&(!resource||(snapshot.resource_type===resource.type&&snapshot.resource_id===resource.id))&&audienceAllowed(db,actor,snapshot));
}
export function historicRead(db,actor,revision){return currentRead(db,actor,{type:revision.resource_type,id:revision.resource_id},{allowDeleted:true})&&hasScope(db,actor,'history:read')&&originalRead(db,actor,revision.original_scope,revision.access_snapshot_id,{type:revision.resource_type,id:revision.resource_id});}
function receiptRead(db,actor,resource){const r=resourceScope(db,resource);return currentRead(db,actor,resource,{allowDeleted:true})&&(!r.deleted||hasScope(db,actor,'history:read'));}
export function receiptScope(db,actor,row){
 const targets=get(db,'SELECT targets_json FROM operation_targets WHERE workspace_id=? AND principal_id=? AND operation_id=?',row.workspace_id,row.principal_id,row.operation_id);
 if(targets){if(!hasScope(db,actor,'operations:read_own'))return false;if(!get(db,'SELECT read_own FROM membership WHERE principal_id=?',actor.principalId)?.read_own)return false;return JSON.parse(targets.targets_json).every(t=>t.redacted===true?Boolean(get(db,'SELECT can_read FROM credential WHERE id=?',actor.credentialId)?.can_read):t.creationRejection?t.originalScope?.state==='known'&&scopeAllowed(db,actor,t.originalScope.scope):receiptRead(db,actor,t.resource)&&originalRead(db,actor,t.originalScope,t.accessSnapshotId,t.resource));}
 const scope=get(db,'SELECT * FROM operation_scope WHERE workspace_id=? AND principal_id=? AND operation_id=?',row.workspace_id,row.principal_id,row.operation_id);
 if(!scope)return null; // Frozen title receipt policy remains owned by shared-core.
 if(!hasScope(db,actor,'operations:read_own'))return false;
 if(!get(db,'SELECT read_own FROM membership WHERE principal_id=?',actor.principalId)?.read_own)return false;
 const original=JSON.parse(scope.original_scope);
 if(scope.creation_rejection)return original.state==='known'&&scopeAllowed(db,actor,original.scope);
 return receiptRead(db,actor,{type:scope.resource_type,id:scope.resource_id})&&originalRead(db,actor,original,scope.access_snapshot_id,{type:scope.resource_type,id:scope.resource_id});
}

export function policyIdentity(db,resource){return get(db,'SELECT access_policy_id FROM resource_access_identity WHERE resource_type=? AND resource_id=?',resource.type,resource.id)?.access_policy_id??null;}
export function currentManage(db,actor,resource){
 const r=resourceScope(db,resource);if(!r||!currentWrite(db,actor,resource)||!hasScope(db,actor,'resource:manage'))return false;
 return scopeManageAllowed(db,actor,r.scope);
}
export function accessProjection(db,actor,resource){
 const p=resourcePolicy(db,resource),accessPolicyId=policyIdentity(db,resource),canManage=Boolean(accessPolicyId&&actor&&currentManage(db,actor,resource));
 return {accessPolicyId,policyVersion:p?.policy_version??null,canManageAccess:canManage,...(actor&&currentManage(db,actor,resource)&&!accessPolicyId?{accessManagementError:'POLICY_MIGRATION_REQUIRED'}:{}),...(canManage?{accessPolicy:{mode:p.mode,readerPrincipalIds:JSON.parse(p.reader_principal_ids),writerPrincipalIds:JSON.parse(p.writer_principal_ids)}}:{})};
}

// Shared explicit scope-admin predicate; individual commands still require their own scopes.
export function scopeManageAllowed(db,actor,scope){
 if(!scope||!['project','workspace_shared'].includes(scope.kind))return false;
 const scopeId=scope.kind==='project'?scope.projectId:actor.workspaceId;
 return get(db,'SELECT can_manage FROM scope_manage_grant WHERE principal_id=? AND scope_kind=? AND scope_id=?',actor.principalId,scope.kind,scopeId)?.can_manage===1;
}
