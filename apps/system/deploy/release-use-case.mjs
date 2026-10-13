// @module deployment
// @role usecase
import {createHash} from 'node:crypto';
import {UUID,assertTarget,requireCompletePort,fail} from './cloudflare-port.mjs';
const json=value=>JSON.stringify(value);
const hash=value=>createHash('sha256').update(json(value)).digest('hex');
const ordered=bindings=>[...bindings].sort((a,b)=>a.name.localeCompare(b.name));
const publicError=error=>({kind:error.kind||'protocol',code:/^[A-Z_]+$/.test(error.code||error.message)?error.code||error.message:'ADAPTER_FAILURE'});
const externalChecks=['Product A1–A12 acceptance is separate','Remote byte-SHA excluded; upload receipt/local artifact and remote metadata are separate evidence'];
export function createReleaseUseCase({port,journal,release}){
  const target={account:release.account,worker:release.worker};
  assertTarget(target);
  if(!/^[a-f0-9]{64}$/.test(release.artifactTreeSha256||''))fail('INVALID_RELEASE_IDENTITY');
  async function ready(forMutation=false){if(forMutation)requireCompletePort(port);await port.ready();}
  function identity(state){
    assertTarget(state?.target,target);
    if(state.artifactTreeSha256!==release.artifactTreeSha256)fail('RELEASE_DRIFT');
    if(state.blocked)fail('EXPLICIT_STOP_REQUIRES_OPERATOR_RESOLUTION');
  }
  function observation(value,requestedAt){assertTarget(value?.target,target);const at=Date.parse(value.observedAt);if(!Number.isFinite(at))fail('OBSERVATION_TIME_MISSING');if(at<requestedAt||at>Date.now())fail('STALE_OR_FUTURE_OBSERVATION');return value;}
  async function current(expected){
    const requestedAt=Date.now();const d=observation(await port.inspectDeployment(target),requestedAt);
    if(!UUID.test(d.deploymentId||'')||d.versions?.length!==1||!UUID.test(d.versions[0].versionId||'')||d.versions[0].percentage!==100)fail('UNEXPECTED_DEPLOYMENT_STATE');
    if(expected&&d.versions[0].versionId!==expected)fail('CURRENT_DEPLOYMENT_DRIFT');return d;
  }
  async function version(id){
    if(!UUID.test(id||''))fail('INVALID_VERSION_ID');
    const requestedAt=Date.now();const v=observation(await port.inspectVersion(target,id),requestedAt);
    if(v.versionId!==id)fail('VERSION_ID_MISMATCH');
    if(!Array.isArray(v.bindings)||!Array.isArray(v.compatibilityFlags))fail('INVALID_VERSION_OBSERVATION');return v;
  }
  async function prerequisites(expectedCurrent){
    const requestedAt=Date.now();const p=observation(await port.inspectPrerequisites(target,expectedCurrent),requestedAt);
    if(p.currentVersion!==expectedCurrent)fail('PREREQUISITE_VERSION_DRIFT');
    const expected=release.policy.prerequisites;
    if(!expected||p.database?.id!==expected.databaseId||json(p.database?.migrationNames)!==json(expected.migrationNames)||json(p.gate)!==json(expected.gate))fail('DATABASE_OR_GATE_PREREQUISITE_MISMATCH');
    if(!p.security||Object.keys(expected.security).some(key=>p.security[key]!==expected.security[key]))fail('SECURITY_PREREQUISITE_DRIFT');
    if(p.service?.projection!=='default_environment.script'||p.service.origin!=='wrangler'||json(p.service.tags)!=='[]'||p.service.migrationTag!==release.policy.migrationTag)fail('EXACT_SERVICE_PREREQUISITE_MISSING');
    return p;
  }
  function runtimeMatches(v){
    if(v.compatibilityDate!==release.policy.compatibilityDate||json([...v.compatibilityFlags].sort())!==json([...release.policy.compatibilityFlags].sort())||v.migrationTag!==release.policy.migrationTag)fail('RUNTIME_DRIFT');
    if(v.origin!=='wrangler'||v.preview!==false)fail('UNREVIEWED_PROVIDER_BRANCH');
  }
  function baselineMatches(v){
    runtimeMatches(v);
    if(v.bindings.find(b=>b.name==='JWT_SECRET')?.type!=='secret_text')fail('PRESERVED_SECRET_BINDING_MISSING');
    for(const b of release.policy.bindings.filter(b=>['DB','ASSETS','AUTH_ORIGIN'].includes(b.name)))if(json(v.bindings.find(x=>x.name===b.name))!==json(b))fail('BASELINE_BINDING_DRIFT');
  }
  function uploadedMatches(v,baseline){
    runtimeMatches(v);
    const expected=new Map(baseline.bindings.map(b=>[b.name,b]));
    for(const b of release.policy.bindings)expected.set(b.name,b);
    if(json(ordered(v.bindings))!==json(ordered([...expected.values()])))fail('UPLOADED_BINDINGS_MISMATCH');
    if(json(v.assets)!==json(release.policy.assets))fail('UPLOADED_ASSET_CONFIGURATION_MISMATCH');
  }
  async function save(state){await journal.append(state);return state;}
  async function stopAfterReadFailure(state,error){
    const e=publicError(error);
    await save({...state,phase:'RECONCILIATION_REQUIRED',error:e,blocked:['auth-denied','cancelled','safety-stop'].includes(e.kind)});
    throw error;
  }
  async function verifyUploaded(state){
    assertTarget(state.uploadReceipt?.target,target);
    if(state.uploadReceipt?.artifactTreeSha256!==release.artifactTreeSha256||state.uploadReceipt?.versionId!==state.versionId)fail('UPLOAD_RECEIPT_IDENTITY_MISMATCH');
    await current(state.expectedCurrent);
    const observed=await version(state.versionId);uploadedMatches(observed,state.baseline);
    return save({...state,phase:'UPLOAD_VERIFIED',error:undefined,
      uploadedWitness:{target,versionId:state.versionId,artifactTreeSha256:release.artifactTreeSha256,observedAt:observed.observedAt,metadata:observed,metadataSha256:hash(observed),
        artifactAssociation:'Pinned official upload command receipt plus verified local artifact; no remote byte-SHA proof'}});
  }
  async function mutate(state,operation){
    await save(state); // Durable local intent precedes dispatch; a throw after this is uncertain.
    let result;try{result=await operation();}catch(error){result={kind:'outcome-unknown',error:publicError(error)};}
    const blocked=['auth-denied','cancelled','safety-stop'].includes(result.error?.kind);
    if(result.kind!=='command-reported')return save({...state,phase:'RECONCILIATION_REQUIRED',outcome:result,blocked});
    if(state.operation==='upload'&&!UUID.test(result.versionId||''))return save({...state,phase:'RECONCILIATION_REQUIRED',outcome:{kind:'outcome-unknown',error:{kind:'protocol',code:'UPLOAD_ID_MISSING'}}});
    return save({...state,phase:state.operation==='upload'?'UPLOAD_COMMAND_REPORTED':'PROMOTION_COMMAND_REPORTED',versionId:result.versionId||state.versionId,outcome:result,
      ...(state.operation==='upload'?{uploadReceipt:{target,artifactTreeSha256:release.artifactTreeSha256,versionId:result.versionId,commandEvidence:result.evidence}}:{})});
  }
  async function verifiedPromotion(state){
    const active=await current(state.versionId),observed=await version(state.versionId);
    const prerequisiteWitness=await prerequisites(state.versionId);
    uploadedMatches(observed,state.baseline);
    return save({...state,phase:'TRAFFIC_VERIFIED_EXTERNAL_CHECKS_REQUIRED',promotionWitness:{active,version:observed,prerequisites:prerequisiteWitness},externalChecksRequired:externalChecks});
  }
  return Object.freeze({
    async probe(id){await ready();return version(id);},
    async deployments(){await ready();return current();},
    async status(){return await journal.read()||{phase:'NOT_STARTED',target,artifactTreeSha256:release.artifactTreeSha256};},
    async upload(expectedCurrent){return journal.exclusive(async()=>{
      if(await journal.read())fail('EXISTING_RELEASE_JOURNAL_BLOCKS_REPLAY');
      if(!UUID.test(expectedCurrent||''))fail('EXPECTED_CURRENT_UUID_REQUIRED');
      await ready(true); // Includes whole static-release capability, not just metadata support.
      const before=await current(expectedCurrent),prerequisiteWitness=await prerequisites(expectedCurrent),baseline=await version(expectedCurrent);baselineMatches(baseline);
      await current(expectedCurrent); // Detect intervening active-version drift before any mutation intent.
      let state={target,artifactTreeSha256:release.artifactTreeSha256,workerSha256:release.workerSha256,expectedCurrent,before,baseline,prerequisiteWitness,
        operation:'upload',phase:'UPLOAD_INTENT',startedAt:new Date().toISOString(),externalChecksRequired:externalChecks};
      state=await mutate(state,()=>port.uploadStaticVersion(target,release));
      if(state.phase!=='UPLOAD_COMMAND_REPORTED')return state;
      try{return await verifyUploaded(state);}catch(error){return stopAfterReadFailure(state,error);}
    });},
    async promote(expectedCurrent){return journal.exclusive(async()=>{
      const state=await journal.read();identity(state);
      if(state.phase!=='UPLOAD_VERIFIED')fail('UPLOAD_NOT_VERIFIED');
      assertTarget(state.uploadedWitness?.target,target);
      if(state.uploadedWitness.artifactTreeSha256!==release.artifactTreeSha256||state.uploadedWitness.versionId!==state.versionId||state.uploadedWitness.metadata?.versionId!==state.versionId||state.uploadedWitness.metadataSha256!==hash(state.uploadedWitness.metadata))fail('UPLOAD_WITNESS_IDENTITY_MISMATCH');
      if(expectedCurrent!==state.expectedCurrent)fail('EXPECTED_CURRENT_DRIFT');
      await ready(true);
      // Never trust a passed:true file or an old witness: real adapter readback is mandatory again.
      let checked;try{await prerequisites(expectedCurrent);checked=await verifyUploaded(state);}catch(error){return stopAfterReadFailure(state,error);}
      const started={...checked,operation:'promote',phase:'PROMOTION_INTENT',startedAt:new Date().toISOString()};
      const outcome=await mutate(started,()=>port.promoteVersion(target,state.versionId));
      if(outcome.phase!=='PROMOTION_COMMAND_REPORTED')return outcome;
      try{return await verifiedPromotion(outcome);}catch(error){return stopAfterReadFailure(outcome,error);}
    });},
    async reconcile(){return journal.exclusive(async()=>{
      const state=await journal.read();identity(state);
      if(!UUID.test(state.versionId||''))return {...state,recovery:'No trustworthy uploaded version ID; no search, inferred match, or mutation replay'};
      await ready(true);
      try{
        if(state.operation==='promote')return await verifiedPromotion(state);
        if(state.operation==='upload')return await verifyUploaded(state);
        fail('INVALID_JOURNAL_OPERATION');
      }catch(error){return stopAfterReadFailure(state,error);}
    });},
  });
}
