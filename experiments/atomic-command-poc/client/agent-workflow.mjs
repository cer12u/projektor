const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x);
// Runtime-neutral coordinator. Inject an authorized transport and durable private
// journal. No external tools, credentials, privilege grants or automatic resends.
export class MachineWorkflowClient {
 constructor({transport,journal,runtimeInstanceId,monotonicNow=()=>performance.now()}){this.transport=transport;this.journal=journal;this.runtimeInstanceId=runtimeInstanceId;this.clock=monotonicNow;this.paused=true;this.deadline=0;this.claim=null;this.context=null;this.lastClock=this.clock();this.generation=0;this.inflight=new Map();this.unknown=new Set();}
 pause(){this.generation++;this.paused=true;this.deadline=0;}
 async profile(context,required){
  const result=await this.transport.query('capabilities_get',{workspaceId:context.workspaceId,workspaceEpoch:context.workspaceEpoch});if(result?.error)throw Error(result.error.code);const d=result?.data;
  if(d?.profile!=='projektor-machine-v1'||d.hashVersion!=='command-json-v1'||!d.schemaVersions?.includes(1)||d.workspaceId!==context.workspaceId||d.workspaceEpoch!==context.workspaceEpoch||d.principalId!==context.principalId)throw Error('CAPABILITY_MISMATCH');
  for(const [name,version]of Object.entries(required))if(d.commands?.[name]?.payloadVersion!==version)throw Error('CAPABILITY_MISMATCH');return d;
 }
 async discover(context,required={}){context=structuredClone(context);this.pause();const generation=this.generation;const d=await this.profile(context,required);if(this.generation!==generation)throw Error('REVALIDATION_SUPERSEDED');this.context=context;return d;}
 async revalidate(context,required={}){
  context=structuredClone(context);required=structuredClone(required);this.pause();const generation=this.generation,started=this.clock();
  try{
   if(typeof this.journal.listUnresolved!=='function')throw Error('RECOVERY_INSPECTION_REQUIRED');
   const unresolved=await this.journal.listUnresolved();if(!Array.isArray(unresolved)||unresolved.length||this.unknown.size)throw Error('JOURNAL_RECOVERY_REQUIRED');
   await this.profile(context,required);
   const args={workspaceId:context.workspaceId,workspaceEpoch:context.workspaceEpoch,entityId:context.issueId};
   const [current,checkpoint,issue]=await Promise.all([this.transport.query('claim_get',args),this.transport.query('attempt_checkpoint_get',args),this.transport.query('issue_get',args)]);
   for(const r of [current,checkpoint,issue])if(!r?.data||r.error)throw Error(r?.error?.code??'INVALID_RESPONSE');
   const claim=current.data.claim;
   if(!claim?.live||claim.workspaceEpoch!==context.workspaceEpoch||claim.principalId!==context.principalId||claim.runtimeInstanceId!==this.runtimeInstanceId||current.data.currentWriteAllowed!==true)throw Error('CLAIM_STALE');
   if(checkpoint.data.blocked!==false)throw Error('EXTERNAL_OUTCOME_UNKNOWN');
   if(!['ready','in_progress'].includes(issue.data.status))throw Error('TASK_NOT_EXECUTABLE');
   const elapsed=this.clock()-started;if(!Number.isFinite(elapsed)||elapsed<0)throw Error('CLOCK_UNCERTAIN');
   const remaining=claim.leaseExpiresAt-current.data.serverTime-elapsed-5000;if(!Number.isFinite(remaining)||remaining<=0)throw Error('LEASE_UNSAFE');
   if(this.generation!==generation)throw Error('REVALIDATION_SUPERSEDED');
   this.deadline=this.clock()+remaining;this.lastClock=this.clock();this.claim=structuredClone(claim);this.context=context;this.paused=false;return {ready:true,externalExecutionAuthorized:false};
  }catch(e){if(this.generation===generation)this.pause();throw e;}
 }
 mayStartAuthorizedWork(externalApproval=false){const now=this.clock();if(!Number.isFinite(now)||now<this.lastClock)this.pause();this.lastClock=now;return externalApproval===true&&!this.paused&&now<this.deadline;}
 checkDispatch(c){
  if(c.payload?.runtimeInstanceId!==undefined&&c.payload.runtimeInstanceId!==this.runtimeInstanceId||c.payload?.claim?.runtimeInstanceId!==undefined&&c.payload.claim.runtimeInstanceId!==this.runtimeInstanceId)throw Error('RUNTIME_CHANGED');
  if(!this.context||c.workspaceId!==this.context.workspaceId||c.workspaceEpoch!==this.context.workspaceEpoch||c.entityId!==this.context.issueId)throw Error('CONTEXT_MISMATCH');
  if(c.payload?.claim&&(!this.mayStartAuthorizedWork(true)||['claimId','fencingToken','runtimeInstanceId','attemptId'].some(k=>c.payload.claim[k]!==this.claim?.[k])))throw Error('PAUSED_OR_STALE');
 }
 classify(r,record){
  const c=record.envelope,d=r?.data,m=r?.meta;
  if(d?.outcome==='committed'&&!r.error&&typeof d.effectApplied==='boolean'&&d.entityId===c.entityId&&Number.isSafeInteger(d.committedVersion)&&d.committedVersion>0&&Number.isSafeInteger(d.commitSeq)&&d.commitSeq>=0&&Number.isSafeInteger(d.serverTime)&&d.serverTime>=0&&m?.workspaceId===c.workspaceId&&m.operationId===c.operationId&&m.actorId===record.principalId){
   if(['Issue.Claim','Issue.RenewClaim','Issue.ReleaseClaim'].includes(c.commandType)){
    const q=d.claim,release=c.commandType==='Issue.ReleaseClaim',acquire=c.commandType==='Issue.Claim';
    if(!q||!uuid(q.claimId)||!uuid(q.runtimeInstanceId)||!uuid(q.attemptId)||q.runtimeInstanceId!==(c.payload.runtimeInstanceId??c.payload.claim.runtimeInstanceId)||q.attemptId!==(c.payload.attemptId??c.payload.claim.attemptId)||q.principalId!==record.principalId||q.workspaceEpoch!==c.workspaceEpoch||typeof q.fencingToken!=='string'||! /^[1-9][0-9]{0,77}$/.test(q.fencingToken)||!Number.isSafeInteger(q.version)||q.version!==(acquire?c.payload.expectedClaimVersion:c.expectedVersion)+1||!Number.isSafeInteger(q.leaseExpiresAt)||!Number.isSafeInteger(q.renewNotBefore)||q.live!==!release||q.releasedAt!==(release?d.serverTime:null)||(!release&&(q.leaseExpiresAt!==d.serverTime+300000||q.renewNotBefore!==d.serverTime+100000))||(!acquire&&(q.claimId!==c.payload.claim.claimId||q.fencingToken!==c.payload.claim.fencingToken)))return 'unknown';
   }
   if(['Issue.AppendProgress','Issue.Transition'].includes(c.commandType)&&d.effectApplied&&(d.entryId!==c.payload.entryId||!uuid(d.revisionId)))return 'unknown';
   if(d.resolutionRecordId!==undefined&&!uuid(d.resolutionRecordId))return 'unknown';
   if(c.commandType==='Issue.Transition'&&d.effectApplied&&['done','canceled'].includes(c.payload.toStatus)&&!uuid(d.resolutionRecordId))return 'unknown';
   return 'committed';
  }
  // Rejected receipts intentionally contain no resource/actor metadata. The
  // injected trusted transport must correlate its own request and response.
  if(!d&&r?.error?.outcome==='rejected'&&r.error.effectApplied===false&&typeof r.error.code==='string'&&r.error.code.length)return 'rejected';
  return 'unknown';
 }
 submit(envelope){
  const c=structuredClone(envelope); // Freeze intent before the very first await.
  if(this.inflight.has(c.operationId)){const existing=this.inflight.get(c.operationId);if(existing.intent!==JSON.stringify(c))return Promise.reject(Error('KEY_REUSE'));return existing.promise;}
  const intent=JSON.stringify(c),promise=this.sendSnapshot(c).finally(()=>this.inflight.delete(c.operationId));this.inflight.set(c.operationId,{intent,promise});return promise;
 }
 async sendSnapshot(c){
  const generation=this.generation;
  if(c.payload?.runtimeInstanceId!==undefined&&c.payload.runtimeInstanceId!==this.runtimeInstanceId||c.payload?.claim?.runtimeInstanceId!==undefined&&c.payload.claim.runtimeInstanceId!==this.runtimeInstanceId)throw Error('RUNTIME_CHANGED');
  const existing=await this.journal.load(c.operationId);
  if(existing&&JSON.stringify(existing.envelope)!==JSON.stringify(c))throw Error('KEY_REUSE');
  if(existing)return this.reconcile(c.operationId);
  this.checkDispatch(c);
  const record={envelope:c,principalId:this.context.principalId,runtimeInstanceId:this.runtimeInstanceId,resends:0,state:'prepared'};
  await this.journal.save(structuredClone(record)); // Failure means zero dispatch.
  if(this.generation!==generation)throw Error('PAUSED_OR_STALE');
  this.checkDispatch(c); // Async journal storage may outlive pause/lease/identity.
  try{const r=await this.transport.command(structuredClone(c));record.state=this.classify(r,record);record.result=r;if(record.state==='unknown'){this.unknown.add(c.operationId);this.pause();}await this.journal.save(structuredClone(record));if(record.state==='unknown'){this.pause();return {error:{code:'OUTCOME_UNKNOWN',outcome:'unknown'}};}if(c.commandType==='Issue.ReleaseClaim'||c.commandType==='Issue.Transition'&&!['ready','in_progress'].includes(c.payload.toStatus))this.pause();return r;}
  catch(e){this.unknown.add(c.operationId);this.pause();record.state='unknown';await this.journal.save(structuredClone(record));throw e;}
 }
 async reconcile(operationId){
  const record=await this.journal.load(operationId);if(!record)throw Error('JOURNAL_MISSING');
  const c=record.envelope,r=await this.transport.query('operation_get',{workspaceId:c.workspaceId,workspaceEpoch:c.workspaceEpoch,operationId});const state=this.classify(r,record);
  if(state!=='unknown'){record.state=state;record.result=r;await this.journal.save(structuredClone(record));this.unknown.delete(operationId);return r;}
  this.unknown.add(operationId);this.pause();return {error:{code:'OUTCOME_UNKNOWN',outcome:'unknown'},receipt:r,resendAllowed:false};
 }
}
