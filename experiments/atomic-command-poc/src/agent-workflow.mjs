import {isCompatibilityStatusId,planCompatibilityTransition,applyCompatibilityTransition} from './issue-compat.mjs';
import {wikiCommandTools} from './wiki-surface.mjs';
import {currentLinkView,carryLinkView} from './content-links.mjs';
// Runtime-neutral workflow on the existing WorkspaceStore transaction boundary.
import {randomUUID} from 'node:crypto';
import {Buffer} from 'node:buffer';
import {authorized,failure,transaction} from './shared-core.mjs';
import {executeResourceCommand,commitResourceMutation} from './command-pipeline.mjs';
import {currentRead,currentWrite,hasScope,scopeAllowed,historicRead} from './resource-access.mjs';
import {captureAccess,appendContentRevision,nativeAuthor,CONTENT_COMMANDS} from './issue-content.mjs';
import {contentPage} from './content-page.mjs';
const get=(db,s,...a)=>db.prepare(s).get(...a),all=(db,s,...a)=>db.prepare(s).all(...a);
function one(db,s,...a){const r=db.prepare(s).run(...a);if(r.changes!==1)throw Error('Workflow write invariant');return r;}
const id=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x);
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
const text=x=>typeof x==='string'&&x.isWellFormed();
const nonempty=x=>text(x)&&x.trim().length>0;
const positive=x=>Number.isSafeInteger(x)&&x>0;
const shape=(x,required,optional=[])=>plain(x)&&required.every(k=>Object.hasOwn(x,k))&&Object.keys(x).every(k=>required.includes(k)||optional.includes(k));
const statuses=['backlog','ready','in_progress','blocked','done','canceled'];
const resolved=s=>s==='done'||s==='canceled';
export const WORKFLOW_REGISTRY=Object.freeze({
 'Issue.Claim':{payloadVersion:1,cas:'issue',scope:'claim:write'},
 'Issue.RenewClaim':{payloadVersion:1,cas:'claim',scope:'claim:write'},
 'Issue.ReleaseClaim':{payloadVersion:1,cas:'claim',scope:'claim:write'},
 'Issue.AppendProgress':{payloadVersion:2,cas:'issue',scope:'progress:write'},
 'Issue.Transition':{payloadVersion:2,cas:'issue',scope:'issue:transition'},
 'Issue.Reparent':{payloadVersion:1,cas:'issue',scope:'issue:write'},
 'Issue.MoveTree':{payloadVersion:1,cas:'allIssues',scope:'issue:write'}
});
export const WORKFLOW_COMMANDS=Object.keys(WORKFLOW_REGISTRY);
export function validClaimRef(x){return shape(x,['claimId','fencingToken','runtimeInstanceId','attemptId'])&&['claimId','runtimeInstanceId','attemptId'].every(k=>id(x[k]))&&typeof x.fencingToken==='string'&&/^[1-9][0-9]{0,77}$/.test(x.fencingToken);}
export function validateWorkflow(c){
 const p=c.payload,r=WORKFLOW_REGISTRY[c.commandType];
 if(!positive(c.expectedVersion)||!plain(p))return 'VALIDATION';
 if(p.payloadVersion!==r.payloadVersion)return 'CAPABILITY_MISMATCH';
 const required={
 'Issue.Claim':['attemptId','runtimeInstanceId','agentDefinition','expectedClaimVersion'],
 'Issue.RenewClaim':['claim'],'Issue.ReleaseClaim':['claim','reason'],
 'Issue.AppendProgress':['entryId','bodyMarkdown'],'Issue.Transition':['entryId','toStatus'],
 'Issue.Reparent':['parentId'],'Issue.MoveTree':['targetProjectId','targets']
 }[c.commandType];
 const optional=c.commandType==='Issue.AppendProgress'?['reason','result','claim','effectCheckpoint']:c.commandType==='Issue.Transition'?['reason','waitingFor','nextStep','result','claim','statusId']:c.commandType==='Issue.Reparent'?['expectedParentVersion']:[];
 if(!shape(p,['payloadVersion',...required],optional))return 'VALIDATION';
 if(p.effectCheckpoint!==undefined&&(!shape(p.effectCheckpoint,['effectId','state','reference'])||!id(p.effectCheckpoint.effectId)||!['external_outcome_unknown','reconciled'].includes(p.effectCheckpoint.state)||!nonempty(p.effectCheckpoint.reference)||Buffer.byteLength(p.effectCheckpoint.reference)>4096))return 'VALIDATION';
 if(p.claim!==undefined&&!validClaimRef(p.claim))return 'VALIDATION';
 if(c.commandType==='Issue.Claim'&&(!id(p.attemptId)||!id(p.runtimeInstanceId)||!shape(p.agentDefinition,['id','revision'])||!nonempty(p.agentDefinition.id)||!nonempty(p.agentDefinition.revision)||p.agentDefinition.id.length>200||p.agentDefinition.revision.length>200||!Number.isSafeInteger(p.expectedClaimVersion)||p.expectedClaimVersion<0))return 'VALIDATION';
 if(p.entryId!==undefined&&!id(p.entryId))return 'VALIDATION';
 if(p.toStatus!==undefined&&!statuses.includes(p.toStatus))return 'VALIDATION';
 if(p.statusId!==undefined&&!isCompatibilityStatusId(p.statusId))return 'VALIDATION';
 if(c.commandType==='Issue.ReleaseClaim'&&(!nonempty(p.reason)||Buffer.byteLength(p.reason)>4096))return 'VALIDATION';
 if(c.commandType!=='Issue.ReleaseClaim'&&p.reason!==undefined&&(!shape(p.reason,['text'],['code'])||!nonempty(p.reason.text)||p.reason.code!==undefined&&(!nonempty(p.reason.code)||Buffer.byteLength(p.reason.code)>200)))return 'VALIDATION';
 if(p.result!==undefined&&(!shape(p.result,['artifactIds'],['summary'])||!Array.isArray(p.result.artifactIds)||p.result.artifactIds.length>100||new Set(p.result.artifactIds).size!==p.result.artifactIds.length||p.result.artifactIds.some(x=>!id(x))||p.result.summary!==undefined&&!text(p.result.summary)))return 'VALIDATION';
 for(const k of ['bodyMarkdown','waitingFor','nextStep'])if(p[k]!==undefined&&!text(p[k]))return 'VALIDATION';
 if(Buffer.byteLength(JSON.stringify(p))>1900000)return 'BODY_TOO_LARGE';
 if([p.bodyMarkdown,p.reason?.text,p.result?.summary,p.waitingFor,p.nextStep].reduce((n,v)=>n+(v===undefined?0:Buffer.byteLength(v)),0)>256*1024)return 'BODY_TOO_LARGE';
 for(const v of [p.bodyMarkdown,p.reason?.text,p.result?.summary,p.waitingFor,p.nextStep])if(v!==undefined&&Buffer.byteLength(v)>256*1024)return 'BODY_TOO_LARGE';
 if(c.commandType==='Issue.Reparent'&&(!(p.parentId===null||id(p.parentId))||p.parentId!==null&&!positive(p.expectedParentVersion)||p.parentId===null&&p.expectedParentVersion!==undefined))return 'VALIDATION';
 if(c.commandType==='Issue.MoveTree'&&(!id(p.targetProjectId)||!Array.isArray(p.targets)||p.targets.length<1||p.targets.length>100||new Set(p.targets.map(t=>t.id)).size!==p.targets.length||p.targets.some(t=>!shape(t,['id','expectedVersion'])||!id(t.id)||!positive(t.expectedVersion))))return 'VALIDATION';
 return null;
}
function claimProjection(row,now,epoch=row?.workspace_epoch){return row?{claimId:row.claim_id,principalId:row.principal_id,runtimeInstanceId:row.runtime_instance_id,attemptId:row.attempt_id,fencingToken:row.fencing_token,version:row.version,leaseExpiresAt:row.lease_expires_at,renewNotBefore:row.renew_not_before,releasedAt:row.released_at,workspaceEpoch:row.workspace_epoch,live:row.workspace_epoch===epoch&&row.released_at===null&&now<row.lease_expires_at}:null;}
function liveClaim(row,actor,ref,epoch,now){return row&&ref&&row.principal_id===actor.principalId&&row.claim_id===ref.claimId&&row.runtime_instance_id===ref.runtimeInstanceId&&row.attempt_id===ref.attemptId&&row.fencing_token===ref.fencingToken&&row.workspace_epoch===epoch&&row.released_at===null&&now<row.lease_expires_at;}
function tree(db,root){const found=[],pending=[{id:root,depth:1}],seen=new Set();while(pending.length){const r=pending.shift();if(seen.has(r.id)||r.depth>32)return null;seen.add(r.id);found.push(r);if(found.length>100)return null;for(const child of all(db,'SELECT issue_id FROM issue_content WHERE parent_id=?',r.id))pending.push({id:child.issue_id,depth:r.depth+1});}return found;}
function ancestorDepth(db,parent,forbidden,projectId){let depth=0;const seen=new Set(forbidden);while(parent){if(seen.has(parent)||++depth>32)return null;seen.add(parent);const issue=get(db,'SELECT * FROM issue WHERE id=?',parent);if(!issue||issue.deleted||issue.project_id!==projectId)return null;parent=get(db,'SELECT parent_id FROM issue_content WHERE issue_id=?',parent)?.parent_id;}return depth;}
export function executeWorkflowCommand(db,actor,c,options={}){
 return executeResourceCommand(db,actor,c,options,({now,fault,save,reject})=>{
  const p=c.payload,resource={type:'issue',id:c.entityId},issue=get(db,'SELECT * FROM issue WHERE id=?',c.entityId);
  if(!issue||!currentRead(db,actor,resource))return reject('NOT_FOUND',[{redacted:true}]);
  let targets;const evidence=()=>targets??=( [{resource,...captureAccess(db,resource)}] );
  const deny=code=>reject(code,evidence());
  if(!hasScope(db,actor,'issue:read')||!hasScope(db,actor,'issue:write')||!currentWrite(db,actor,resource)||!hasScope(db,actor,WORKFLOW_REGISTRY[c.commandType].scope))return deny('FORBIDDEN');
  const claim=get(db,'SELECT * FROM execution_claim WHERE issue_id=?',issue.id),claimOnly=['Issue.Claim','Issue.RenewClaim','Issue.ReleaseClaim'].includes(c.commandType);
  if(claimOnly&&actor.actorKind!=='machine'||actor.actorKind==='human'&&p.claim!==undefined)return deny('ACTOR_KIND_MISMATCH');
  if((WORKFLOW_REGISTRY[c.commandType].cas==='claim'?(claim?.version??0):issue.version)!==c.expectedVersion)return deny('VERSION_CONFLICT');
  const q=get(db,'SELECT * FROM issue_queue WHERE issue_id=?',issue.id);
  if(!q)return deny('WORKFLOW_STATE_UNAVAILABLE');
  let claimResult=null,entryId=null,revisionId=null,resolutionRecordId=null,metadata={},version=issue.version,compatPlan={changed:false};
  if(c.commandType==='Issue.Claim'){
   if((claim?.version??0)!==p.expectedClaimVersion)return deny('VERSION_CONFLICT');
   if(claim&&claim.released_at===null&&claim.workspace_epoch===c.workspaceEpoch&&now<claim.lease_expires_at)return deny('CLAIM_HELD');
   if(get(db,'SELECT id FROM execution_attempt WHERE id=?',p.attemptId))return deny('ATTEMPT_REUSED');
   // Acquiring a resolved Issue permits an authorized explicit reopen; it grants no external execution permission.
   const fence=(BigInt(claim?.fencing_token??'0')+1n).toString();if(fence.length>78)return deny('FENCE_EXHAUSTED');
   const claimId=randomUUID(),slotVersion=(claim?.version??0)+1;
   evidence();fault('before_domain');
   one(db,'INSERT INTO execution_attempt VALUES(?,?,?,?,?,?,?,?,?,?)',p.attemptId,issue.id,claimId,actor.principalId,p.runtimeInstanceId,p.agentDefinition.id,p.agentDefinition.revision,fence,c.workspaceEpoch,now);
   if(claim)one(db,'UPDATE execution_claim SET claim_id=?,principal_id=?,runtime_instance_id=?,attempt_id=?,fencing_token=?,version=?,lease_expires_at=?,renew_not_before=?,released_at=NULL,workspace_epoch=? WHERE issue_id=? AND version=?',claimId,actor.principalId,p.runtimeInstanceId,p.attemptId,fence,slotVersion,now+300000,now+100000,c.workspaceEpoch,issue.id,claim.version);
   else one(db,'INSERT INTO execution_claim VALUES(?,?,?,?,?,?,?,?,?,?,?)',issue.id,claimId,actor.principalId,p.runtimeInstanceId,p.attemptId,fence,slotVersion,now+300000,now+100000,null,c.workspaceEpoch);
   claimResult=claimProjection(get(db,'SELECT * FROM execution_claim WHERE issue_id=?',issue.id),now);
  }else if(claimOnly){
   if(!liveClaim(claim,actor,p.claim,c.workspaceEpoch,now))return deny('CLAIM_STALE');
   if(c.commandType==='Issue.RenewClaim'&&now<claim.renew_not_before)return deny('RENEW_TOO_EARLY');
   evidence();fault('before_domain');
   if(c.commandType==='Issue.RenewClaim')one(db,'UPDATE execution_claim SET version=version+1,lease_expires_at=?,renew_not_before=? WHERE issue_id=? AND version=?',now+300000,now+100000,issue.id,claim.version);
   else one(db,'UPDATE execution_claim SET version=version+1,released_at=? WHERE issue_id=? AND version=?',now,issue.id,claim.version);
   claimResult=claimProjection(get(db,'SELECT * FROM execution_claim WHERE issue_id=?',issue.id),now);metadata={reason:p.reason??null};
  }else if(['Issue.AppendProgress','Issue.Transition'].includes(c.commandType)){
   if(actor.actorKind==='machine'&&(!hasScope(db,actor,'claim:write')||!liveClaim(claim,actor,p.claim,c.workspaceEpoch,now)))return deny('CLAIM_STALE');
   // I4 capture is deliberately unavailable. A mutable URL is not a captured result.
   if(p.result?.artifactIds.length)return deny('ARTIFACT_CAPTURE_UNAVAILABLE');
   const from=q.status_category,to=p.toStatus,reason=nonempty(p.reason?.text),result=nonempty(p.result?.summary);
   if(c.commandType==='Issue.AppendProgress'&&!nonempty(p.bodyMarkdown)&&!result)return deny('PROGRESS_EMPTY');
   if(c.commandType==='Issue.Transition'){
    compatPlan=planCompatibilityTransition(db,issue.id,to,p.statusId);if(compatPlan.error)return deny(compatPlan.error);
    if(to===from&&!compatPlan.changed)return commitResourceMutation(db,actor,c,{resource,version,now,save,targets:evidence(),effectApplied:false});
    if(resolved(from)&&resolved(to))return deny('REOPEN_REQUIRED');
    if((resolved(from)||from==='blocked'||to==='canceled'||to==='ready'&&['in_progress','blocked'].includes(from))&&!reason)return deny('REASON_REQUIRED');
    if(to==='blocked'&&(!reason||!nonempty(p.waitingFor)&&!nonempty(p.nextStep)))return deny('BLOCKED_EVIDENCE_REQUIRED');
    if(to==='done'&&effectStates(db,issue.id).some(e=>e.state==='external_outcome_unknown'))return deny('EXTERNAL_OUTCOME_UNKNOWN');
    if(to==='done'&&!result)return deny('RESULT_REQUIRED');
    if(to==='done'&&get(db,"SELECT 1 FROM issue_content c LEFT JOIN issue_queue q ON q.issue_id=c.issue_id WHERE c.parent_id=? AND (q.status_category IS NULL OR q.status_category NOT IN ('done','canceled'))",issue.id))return deny('UNRESOLVED_CHILDREN');
   }
   if(p.effectCheckpoint){const old=effectStates(db,issue.id).find(e=>e.effect_id===p.effectCheckpoint.effectId);if(p.effectCheckpoint.state==='reconciled'&&(!old||old.state!=='external_outcome_unknown'))return deny('EFFECT_CHECKPOINT_INVALID');if(p.effectCheckpoint.state==='reconciled'&&!effectReadable(db,actor,old))return deny('CHECKPOINT_ACCESS_REQUIRED');if(p.effectCheckpoint.state==='external_outcome_unknown'&&old)return deny('EFFECT_ID_REUSED');if(p.effectCheckpoint.state==='external_outcome_unknown'&&effectStates(db,issue.id).length>=64)return deny('EFFECT_CHECKPOINT_LIMIT');}
   if(get(db,'SELECT id FROM issue_entry WHERE id=?',p.entryId))return deny('ENTRY_EXISTS');
   const a=evidence()[0],kind=c.commandType==='Issue.AppendProgress'?'progress':'transition';version++;entryId=p.entryId;
   metadata={...(p.effectCheckpoint?{effectCheckpoint:p.effectCheckpoint}:{}),...(kind==='transition'?{fromStatus:from,toStatus:to,...(compatPlan.statusId!==undefined?{compatibility:{beforeStatusId:compatPlan.beforeStatusId,statusId:compatPlan.statusId,beforeReviewStep:compatPlan.beforeReviewStep,isReviewStep:compatPlan.isReviewStep}}:{})}:{}),...(p.reason?{reason:p.reason}:{}),...(p.result?{result:p.result}:{}),...(p.waitingFor!==undefined?{waitingFor:p.waitingFor}:{}),...(p.nextStep!==undefined?{nextStep:p.nextStep}:{}),...(actor.actorKind==='machine'?{claim:p.claim}:{})};
   if(kind==='transition'&&(resolved(to)||resolved(from)))resolutionRecordId=randomUUID();
   if(resolutionRecordId)metadata.resolutionRecordId=resolutionRecordId;
   fault('before_domain');one(db,'UPDATE issue SET version=version+1 WHERE id=? AND version=?',issue.id,issue.version);
   revisionId=appendContentRevision(db,{resource,subresourceId:entryId,contentKind:kind,contentMarkdown:p.bodyMarkdown??'',resourceVersion:version,originalAuthorRef:nativeAuthor(actor),actor,now,access:a});
   one(db,'INSERT INTO issue_entry VALUES(?,?,?,?,?,?,?,?,?)',entryId,issue.id,kind,1,revisionId,JSON.stringify(nativeAuthor(actor)),now,null,null);
   one(db,'INSERT INTO workflow_entry VALUES(?,?,?,?,?)',entryId,JSON.stringify(metadata),actor.actorKind==='machine'?p.claim.attemptId:null,JSON.stringify(a.originalScope),a.accessSnapshotId);
   if(p.effectCheckpoint){const old=effectStates(db,issue.id).find(e=>e.effect_id===p.effectCheckpoint.effectId);one(db,'INSERT INTO effect_checkpoint VALUES(?,?,?,?,?,?)',entryId,issue.id,p.effectCheckpoint.effectId,p.effectCheckpoint.state,p.effectCheckpoint.reference,old?.original_attempt_id??(actor.actorKind==='machine'?p.claim.attemptId:null));}
   if(kind==='transition'){
    one(db,'UPDATE issue_queue SET status_category=? WHERE issue_id=?',to,issue.id);
    applyCompatibilityTransition(db,issue.id,compatPlan);fault('after_compatibility');
    if(resolutionRecordId){
     one(db,'INSERT INTO resolution_record VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',resolutionRecordId,issue.id,resolved(to)?to:'reopened',JSON.stringify({quality:'exact',value:now,rawSourceValue:new Date(now).toISOString(),basis:'native_transition',sourceEvidenceIds:[]}),'transition',JSON.stringify(nativeAuthor(actor)),null,null,null,now,actor.principalId,entryId,JSON.stringify(a.originalScope),a.accessSnapshotId);
     const kind=resolved(to)?to:null,at=resolved(to)?now:null,rid=resolved(to)?resolutionRecordId:null;
     if(get(db,'SELECT 1 FROM issue_resolution WHERE issue_id=?',issue.id))one(db,'UPDATE issue_resolution SET resolution_kind=?,resolved_at=?,current_record_id=? WHERE issue_id=?',kind,at,rid,issue.id);
     else one(db,'INSERT INTO issue_resolution VALUES(?,?,?,?)',issue.id,kind,at,rid);
    }
   }
   one(db,'INSERT INTO content_fts VALUES(?,?,?,?)','issue',issue.id,entryId,[p.bodyMarkdown,p.reason?.text,p.result?.summary,p.waitingFor,p.nextStep].filter(x=>x!==undefined).join('\n').normalize('NFKC').toLowerCase());
  }else{
   const nodes=tree(db,issue.id);if(!nodes)return deny('TREE_LIMIT');
   const currentParent=get(db,'SELECT parent_id FROM issue_content WHERE issue_id=?',issue.id)?.parent_id??null;
   if(c.commandType==='Issue.Reparent'){
    if(p.parentId!==null){const parent=get(db,'SELECT * FROM issue WHERE id=?',p.parentId);if(!parent||!currentWrite(db,actor,{type:'issue',id:p.parentId})||parent.project_id!==issue.project_id)return deny('PARENT_INVALID');if(parent.version!==p.expectedParentVersion)return deny('VERSION_CONFLICT');}
    const depth=ancestorDepth(db,p.parentId,nodes.map(n=>n.id),issue.project_id);if(depth===null||depth+Math.max(...nodes.map(n=>n.depth))>32)return deny('PARENT_INVALID');
    if(p.parentId===currentParent)return commitResourceMutation(db,actor,c,{resource,version,now,save,targets:evidence(),effectApplied:false});
    evidence();if(p.parentId)targets.push({resource:{type:'issue',id:p.parentId},...captureAccess(db,{type:'issue',id:p.parentId})});
    fault('before_domain');one(db,'UPDATE issue_content SET parent_id=? WHERE issue_id=?',p.parentId,issue.id);one(db,'UPDATE issue SET version=version+1 WHERE id=? AND version=?',issue.id,issue.version);version++;metadata={previousParentId:currentParent,parentId:p.parentId};
   }else{
    if(currentParent!==null)return deny('MOVE_ROOT_REQUIRED');
    if(nodes.length!==p.targets.length||nodes.some(n=>!p.targets.some(t=>t.id===n.id)))return deny('TREE_TARGETS_MISMATCH');
    const targetScope={kind:'project',projectId:p.targetProjectId};if(!get(db,'SELECT 1 FROM project WHERE id=? AND deleted=0',p.targetProjectId)||!scopeAllowed(db,actor,targetScope)||!scopeAllowed(db,actor,targetScope,'write'))return deny('FORBIDDEN');
    const rows=nodes.map(n=>get(db,'SELECT * FROM issue WHERE id=?',n.id));
    if(rows.some(r=>r.project_id!==issue.project_id||!currentWrite(db,actor,{type:'issue',id:r.id})))return deny('FORBIDDEN');
    if(rows.some(r=>r.version!==p.targets.find(t=>t.id===r.id).expectedVersion))return deny('VERSION_CONFLICT');
    if(p.targetProjectId===issue.project_id)return commitResourceMutation(db,actor,c,{resource,version,now,save,targets:evidence(),effectApplied:false});
    targets=rows.map(r=>({resource:{type:'issue',id:r.id},...captureAccess(db,{type:'issue',id:r.id})}));
    fault('before_domain');const moved=[];
    for(const r of rows){const number=get(db,'SELECT * FROM issue_number WHERE issue_id=?',r.id);if(!number)throw Error('Missing Issue number provenance');const alias=get(db,'SELECT issue_id FROM issue_alias WHERE project_id=? AND number=?',number.project_id,number.number);if(alias&&alias.issue_id!==r.id)throw Error('Alias identity collision');if(!alias)one(db,'INSERT INTO issue_alias VALUES(?,?,?)',number.project_id,number.number,r.id);let counter=get(db,'SELECT next_number FROM project_issue_counter WHERE project_id=?',p.targetProjectId)?.next_number??1;
     if(get(db,'SELECT 1 FROM project_issue_counter WHERE project_id=?',p.targetProjectId))one(db,'UPDATE project_issue_counter SET next_number=next_number+1 WHERE project_id=?',p.targetProjectId);else one(db,'INSERT INTO project_issue_counter VALUES(?,?)',p.targetProjectId,2);
     one(db,'UPDATE issue_number SET project_id=?,number=? WHERE issue_id=?',p.targetProjectId,counter,r.id);one(db,'UPDATE issue SET project_id=?,version=version+1 WHERE id=? AND version=?',p.targetProjectId,r.id,r.version);moved.push({id:r.id,version:r.version+1,number:counter});}
    version++;metadata={targetProjectId:p.targetProjectId,targets:moved};
   }
  }
  fault('after_domain');
  // Every versioned Issue projection keeps its exact prior immutable bindings.
  for(const changed of metadata.targets??(version!==issue.version?[{id:issue.id,version}]:[])){
   const changedResource={type:'issue',id:changed.id},fromVersion=changed.version-1;
   if(currentLinkView(db,changedResource,fromVersion))carryLinkView(db,{resource:changedResource,fromVersion,resourceVersion:changed.version,access:captureAccess(db,changedResource)});
  }
  fault('after_links');
  const wrappedSave=(result,t)=>save({...result,data:{...result.data,...(claimResult?{claim:claimResult}:{}),...(entryId?{entryId}:{}),...(resolutionRecordId?{resolutionRecordId}:{}),...(metadata.targets?{targets:metadata.targets}:{})}},t);
  return commitResourceMutation(db,actor,c,{resource,version,revisionId,subresourceId:entryId,originalAuthorRef:nativeAuthor(actor),beforeTitle:issue.title,afterTitle:issue.title,metadata,now,fault,save:wrappedSave,targets:evidence()});
 });
}
function query(db,actor,args,now,fn,paged=false){
 if(!shape(args,['workspaceId','workspaceEpoch','entityId'],paged?['cursor','limit']:[])||![args.workspaceId,args.workspaceEpoch,args.entityId].every(id)||args.limit!==undefined&&(!positive(args.limit)||args.limit>100)||args.cursor!==undefined&&(!nonempty(args.cursor)||args.cursor.length>2048))return failure('VALIDATION');
 return transaction(db,()=>{now??=Date.now();const d=authorized(db,actor,args.workspaceId,args.workspaceEpoch,now);if(d)return failure(d);if(!currentRead(db,actor,{type:'issue',id:args.entityId}))return failure('NOT_FOUND');return fn(now);});
}
export function queryClaim(db,actor,args,now){return query(db,actor,args,now,n=>({data:{claim:claimProjection(get(db,'SELECT * FROM execution_claim WHERE issue_id=?',args.entityId),n,args.workspaceEpoch),serverTime:n,currentWriteAllowed:currentWrite(db,actor,{type:'issue',id:args.entityId})&&hasScope(db,actor,'claim:write')&&hasScope(db,actor,'progress:write')&&hasScope(db,actor,'issue:transition'),externalExecutionAuthorized:false}}));}
export function queryResolutionRecords(db,actor,args,now){return query(db,actor,args,now,n=>{if(!hasScope(db,actor,'history:read'))return failure('FORBIDDEN');const rows=all(db,'SELECT r.*,a.change_seq FROM resolution_record r JOIN content_activity a ON a.subresource_id=r.entry_id WHERE r.issue_id=? ORDER BY a.change_seq,r.id',args.entityId).filter(r=>historicRead(db,actor,{...r,resource_type:'issue',resource_id:r.issue_id}));return contentPage(db,actor,rows,args,'resolutions',r=>({id:r.id,issueId:r.issue_id,kind:r.kind,time:JSON.parse(r.time_json),recordNature:r.record_nature,originalAuthorRef:JSON.parse(r.original_author_ref),recordedAt:r.recorded_at,recordedBy:r.recorded_by,entryId:r.entry_id,changeSeq:r.change_seq}),n,{tuple:r=>[r.change_seq,r.id]});},true);}
export function queryCapabilities(db,actor,args,now){
 if(!shape(args,['workspaceId','workspaceEpoch'])||![args.workspaceId,args.workspaceEpoch].every(id))return failure('VALIDATION');
 return transaction(db,()=>{now??=Date.now();const d=authorized(db,actor,args.workspaceId,args.workspaceEpoch,now);if(d)return failure(d);if(actor.actorKind!=='machine')return failure('ACTOR_KIND_MISMATCH');return {data:{profile:'projektor-machine-v1',schemaVersions:[1],hashVersion:'command-json-v1',workspaceId:args.workspaceId,workspaceEpoch:args.workspaceEpoch,principalId:actor.principalId,credentialId:actor.credentialId,actorKind:'machine',scopes:all(db,'SELECT scope FROM principal_scope WHERE principal_id=? ORDER BY scope',actor.principalId).map(row=>row.scope).filter(scope=>hasScope(db,actor,scope)),credentialExpiresAt:Math.min(actor.credentialExpiresAt,get(db,'SELECT expires_at FROM credential WHERE id=?',actor.credentialId).expires_at),authzVersion:get(db,'SELECT revision FROM query_state WHERE id=1').revision,serverTime:now,commands:{...Object.fromEntries(['Issue.UpdateTitle',...CONTENT_COMMANDS].map(name=>[name,{payloadVersion:1,payloadVersionField:'implicit-frozen-I1',cas:name==='Issue.Create'?'newIssue':name==='Issue.EditComment'?'comment':'issue'}])),...WORKFLOW_REGISTRY,...Object.fromEntries(Object.values(wikiCommandTools).map(name=>[name,{payloadVersion:1,payloadVersionField:'implicit-capability-v1',cas:name==='Wiki.Create'?'newWiki':name==='Wiki.MoveTree'?'allWiki':name==='SetResourceAccess'?'resource-and-policy':'resource'}]))},features:{'claim-runtime-binding-v1':true,'fenced-progress-v1':true,'receipt-replay-v1':true,'artifact-revision-capture-v1':false,'external-effect-checkpoint-v1':true},limits:{bodyBytes:262144,maxWorkflowTextBytes:262144,envelopeBytes:2097152,pageSize:100,leaseMs:300000,earliestRenewalMs:100000,retryBudget:3,maxEffectIdsPerIssue:64,maxEffectReferenceBytes:4096,checkpointComplete:true},executionAuthority:'none',integrationStatus:'synthetic-provider-tested; real harness and perimeter pending'}};});
}

function effectStates(db,issueId){const rows=all(db,'SELECT e.*,a.change_seq FROM effect_checkpoint e JOIN content_activity a ON a.subresource_id=e.entry_id WHERE e.issue_id=? ORDER BY a.change_seq',issueId);const latest=new Map();for(const r of rows)latest.set(r.effect_id,{...r,original_entry_id:latest.get(r.effect_id)?.original_entry_id??r.entry_id});return [...latest.values()];}
export function queryAttemptCheckpoint(db,actor,args,now){return query(db,actor,args,now,n=>{if(!hasScope(db,actor,'history:read'))return failure('FORBIDDEN');const rows=effectStates(db,args.entityId);const visible=rows.filter(e=>effectReadable(db,actor,e));if(visible.length!==rows.length)return failure('CHECKPOINT_ACCESS_REQUIRED');return {data:{serverTime:n,issueId:args.entityId,externalExecutionAuthorized:false,blocked:rows.some(e=>e.state==='external_outcome_unknown'),effects:visible.map(e=>({effectId:e.effect_id,state:e.state,reference:e.reference,originalAttemptId:e.original_attempt_id,entryId:e.entry_id,changeSeq:e.change_seq}))}};});}

function effectReadable(db,actor,e){return [e.entry_id,e.original_entry_id].every(entryId=>{const w=get(db,'SELECT * FROM workflow_entry WHERE entry_id=?',entryId);return w&&historicRead(db,actor,{...w,resource_type:'issue',resource_id:e.issue_id});});}
export function queryIssueAlias(db,actor,args,now){
 if(!shape(args,['workspaceId','workspaceEpoch','projectId','number'])||![args.workspaceId,args.workspaceEpoch,args.projectId].every(id)||!positive(args.number))return failure('VALIDATION');
 return transaction(db,()=>{const d=authorized(db,actor,args.workspaceId,args.workspaceEpoch,now??Date.now());if(d)return failure(d);if(!scopeAllowed(db,actor,{kind:'project',projectId:args.projectId}))return failure('NOT_FOUND');const r=get(db,'SELECT issue_id FROM issue_number WHERE project_id=? AND number=?',args.projectId,args.number)??get(db,'SELECT issue_id FROM issue_alias WHERE project_id=? AND number=?',args.projectId,args.number);return r&&currentRead(db,actor,{type:'issue',id:r.issue_id})?{data:{issueId:r.issue_id}}:failure('NOT_FOUND');});
}
