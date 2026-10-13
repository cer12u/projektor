// @module repository.integration
// @role deployment-journal
// Append-only nonsecret checkpoints. Unknown upload acknowledgement never authorizes another dispatch.
import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=code=>{throw Error(code);};
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const environment='projektor-production';
export function publicCheckpoint({approval,targetFingerprint},state,previousId){
 const phase=state.phase;
 if(!['upload','promote'].includes(state.operation))fail('UNSUPPORTED_JOURNAL_OPERATION');
 if(!['UPLOAD_INTENT','UPLOAD_COMMAND_REPORTED','UPLOAD_VERIFIED','PROMOTION_INTENT','PROMOTION_COMMAND_REPORTED','TRAFFIC_VERIFIED_EXTERNAL_CHECKS_REQUIRED','RECONCILIATION_REQUIRED'].includes(phase))fail('UNSUPPORTED_JOURNAL_PHASE');
 if(state.versionId!==undefined&&!uuid.test(state.versionId))fail('UNTRUSTWORTHY_VERSION_ID');
 return {format:1,kind:'projektor-release-journal',operationId:approval.operationId,commit:approval.commit,sourceTreeSha256:approval.sourceTreeSha256,artifactTreeSha256:approval.artifactTreeSha256,targetFingerprint,action:approval.action,runId:String(approval.runId),previousId,phase,operation:state.operation,...(state.versionId?{versionId:state.versionId}:{})};
}
export function createGitHubJournal({env,approval,targetFingerprint,target,local,port,fetchImpl=fetch}){
 if(env.GITHUB_REPOSITORY!=='cer12u/projektor'||!env.GH_TOKEN||!/^\d+$/.test(env.GITHUB_RUN_ID||'')||String(approval.runId)!==env.GITHUB_RUN_ID||env.GITHUB_RUN_ATTEMPT!=='1'||!/^[a-f0-9]{64}$/.test(targetFingerprint))fail('DURABLE_JOURNAL_CONTEXT_REQUIRED');
 const base='https://api.github.com/repos/cer12u/projektor/deployments';let initialized=false,previousId=null;
 async function api(suffix='',body){
  const response=await fetchImpl(base+suffix,{method:body?'POST':'GET',redirect:'error',headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+env.GH_TOKEN,'X-GitHub-Api-Version':'2022-11-28',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  if(!response.ok)fail('DURABLE_JOURNAL_API_FAILURE');return response.json();
 }
 async function records(){
  const out=[];let complete=false;
  for(let page=1;page<=20;page++){
   const values=await api('?environment='+environment+'&per_page=100&page='+page);if(!Array.isArray(values))fail('DURABLE_JOURNAL_PROTOCOL_FAILURE');
   for(const row of values){const p=row.payload;if(p?.kind!=='projektor-release-journal')continue;if(p.targetFingerprint!==targetFingerprint||p.artifactTreeSha256!==approval.artifactTreeSha256)continue;
    if(!Number.isSafeInteger(row.id)||row.sha!==p.commit||p.format!==1||!uuid.test(p.operationId||'')||typeof p.runId!=='string')fail('DURABLE_JOURNAL_IDENTITY_FAILURE');out.push(row);
   }
   if(values.length<100){complete=true;break;}
  }
  if(!complete)fail('DURABLE_JOURNAL_SCAN_INCOMPLETE');
  out.sort((a,b)=>a.id-b.id);let prior=null;
  for(const row of out){if(row.payload.previousId!==prior)fail('DURABLE_JOURNAL_FORK_OR_GAP');prior=row.id;}
  return out;
 }
 async function initialize(){
  if(initialized)return;
  const existing=await records();
  if(existing.length){
   const latest=existing.at(-1).payload;
   // Read the real provider state, never synthesize a successful result from this public checkpoint.
   await port.ready();await port.inspectDeployment(target);
   if(latest.versionId)await port.inspectVersion(target,latest.versionId);
   fail(latest.versionId?'PRIOR_OPERATION_OBSERVED_OPERATOR_RECONCILIATION_REQUIRED':'PRIOR_UNKNOWN_UPLOAD_BLOCKS_REPLAY');
  }
  if(await local.read())fail('PRIVATE_JOURNAL_WITHOUT_REMOTE_PROVENANCE');initialized=true;
 }
 return Object.freeze({
  read:()=>local.read(),
  async exclusive(operation){return local.exclusive(async()=>{await initialize();return operation();});},
  async append(state){
   if(!initialized)fail('JOURNAL_NOT_INITIALIZED');
   const current=await records();if((current.at(-1)?.id??null)!==previousId)fail('DURABLE_JOURNAL_CHANGED');
   const checkpoint=publicCheckpoint({approval,targetFingerprint},state,previousId);
   await local.append(state);
   const created=await api('',{ref:approval.commit,task:'deploy',auto_merge:false,required_contexts:[],environment,description:'Projektor pinned release checkpoint',production_environment:true,payload:checkpoint});
   if(!Number.isSafeInteger(created.id)||created.sha!==approval.commit||hash(created.payload)!==hash(checkpoint))fail('DURABLE_JOURNAL_ACK_UNCONFIRMED');
   const observed=await api('/'+created.id);if(observed.id!==created.id||observed.sha!==approval.commit||hash(observed.payload)!==hash(checkpoint))fail('DURABLE_JOURNAL_READBACK_FAILED');
   previousId=created.id;
  },
 });
}
