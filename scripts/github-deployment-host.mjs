// @module repository.integration
// @role deployment-host
// The protected environment authorizes one exact run. No credential or private provider state is published.
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {verifyMeasuredInputs} from './system-release-inputs.mjs';
import {verifyRelease,treeDigest} from '../apps/system/deploy/guard.mjs';
import {loadDeploymentConfig} from '../apps/system/deploy/deployment-config.mjs';
import {createCredentialContext} from '../apps/system/deploy/credential-context.mjs';
import {createWranglerAdapter} from '../apps/system/deploy/wrangler-adapter.mjs';
import {createReleaseUseCase} from '../apps/system/deploy/release-use-case.mjs';
import {createJournal} from '../apps/system/deploy/release-journal.mjs';
import {createGitHubJournal} from './github-deployment-journal.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),app=resolve(root,'apps/system');
const hash=value=>createHash('sha256').update(value).digest('hex');
const json=value=>JSON.stringify(value,null,2)+'\n';
const fail=code=>{throw Error(code);};
const exact=(object,keys)=>object&&typeof object==='object'&&!Array.isArray(object)&&Object.keys(object).length===keys.length&&keys.every(key=>Object.hasOwn(object,key));
export function validateRequest(env){
 if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_REPOSITORY!=='cer12u/projektor'||!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA||'')||env.DEPLOYMENT_REQUEST!=='deploy:'+env.GITHUB_SHA||env.GITHUB_RUN_ATTEMPT!=='1'||!/^\d+$/.test(env.GITHUB_RUN_ID||''))fail('EXACT_MANUAL_RUN_REQUIRED');
 if(env.GITHUB_EVENT_NAME!=='workflow_dispatch'||env.GITHUB_REF!=='refs/heads/fix/modular-system-integration-20261012')fail('UNAPPROVED_TRIGGER_OR_BRANCH');
}
export async function assertProtectedEnvironment(env,fetchImpl=fetch){
 validateRequest(env);if(!env.GH_TOKEN)fail('GITHUB_TOKEN_REQUIRED');
 const base='https://api.github.com/repos/cer12u/projektor/environments/projektor-production';
 async function get(suffix=''){const response=await fetchImpl(base+suffix,{method:'GET',redirect:'error',headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+env.GH_TOKEN,'X-GitHub-Api-Version':'2022-11-28'}});if(!response.ok)fail('PROTECTED_ENVIRONMENT_UNVERIFIED');return response.json();}
 const policy=await get(),review=policy.protection_rules?.find(rule=>rule.type==='required_reviewers');
 if(policy.name!=='projektor-production'||policy.can_admins_bypass!==false||review?.prevent_self_review!==false||!Array.isArray(review.reviewers)||review.reviewers.length!==1||review.reviewers[0]?.type!=='User'||review.reviewers[0]?.reviewer?.login!=='cer12u'||policy.deployment_branch_policy?.custom_branch_policies!==true||policy.deployment_branch_policy?.protected_branches!==false)fail('PROTECTED_ENVIRONMENT_REQUIRED');
 const rules=await get('/deployment-branch-policies?per_page=100'),rule=rules.branch_policies?.[0];
 // Older API responses omit type. The exact running ref is independently constrained to this branch.
 if(rules.total_count!==1||rules.branch_policies?.length!==1||rule.name!=='fix/modular-system-integration-20261012'||(rule.type!==undefined&&rule.type!=='branch'))fail('EXACT_DEPLOYMENT_BRANCH_POLICY_REQUIRED');
 return {verified:true,environment:'projektor-production'};
}
export function validateApproval(value,env){
 validateRequest(env);
 if(!exact(value,['format','commit','runId','operationId','releaseId','sourceTreeSha256','artifactTreeSha256','expectedCurrent','action'])||value.format!==1||value.commit!==env.GITHUB_SHA||String(value.runId)!==env.GITHUB_RUN_ID||!/^projektor-modular-\d{8}$/.test(value.releaseId||''))fail('PROTECTED_APPROVAL_REQUIRED');
 for(const name of ['sourceTreeSha256','artifactTreeSha256'])if(!/^[a-f0-9]{64}$/.test(value[name]||''))fail('APPROVED_DIGEST_REQUIRED');
 for(const name of ['operationId','expectedCurrent'])if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value[name]||''))fail('APPROVED_OPERATION_REQUIRED');
 if(!['upload','upload-and-promote'].includes(value.action))fail('APPROVED_ACTION_REQUIRED');
 return value;
}
export function bindMeasuredIdentity(source,artifact,approval){
 if(source.sourceTreeSha256!==approval.sourceTreeSha256||artifact.artifactTreeSha256!==approval.artifactTreeSha256||artifact.sourceTreeSha256!==approval.sourceTreeSha256)fail('REVIEWED_BUILD_IDENTITY_MISMATCH');
 const reboundSource={...source,releaseId:approval.releaseId},sourceBytes=json(reboundSource);
 const reboundArtifact={...artifact,releaseId:approval.releaseId,sourceManifestSha256:hash(sourceBytes),scope:'Measured build bound to protected reviewed source/artifact digests'};
 return {sourceBytes,artifactBytes:json(reboundArtifact)};
}
async function approval(env){try{return validateApproval(JSON.parse(env.PROJEKTOR_APPROVED_RELEASE_JSON),env);}catch(error){if(/^[A-Z_]+$/.test(error.message))throw error;fail('PROTECTED_APPROVAL_REQUIRED');}}
async function prepare(env){
 const approved=await approval(env);await verifyMeasuredInputs(app);
 let bundle;try{bundle=JSON.parse(env.PROJEKTOR_DEPLOYMENT_CONFIG_JSON);}catch{fail('PRIVATE_CONFIGURATION_REQUIRED');}
 if(!exact(bundle,['target','approvedState','wrangler']))fail('PRIVATE_CONFIGURATION_SHAPE');
 const privateRoot=resolve(app,'.local/deployment');
 try{await readFile(resolve(privateRoot,'release-pins.json'));fail('PRIVATE_RUN_ALREADY_PREPARED');}catch(e){if(e.code!=='ENOENT')throw e;}
 await mkdir(privateRoot,{recursive:true});
 for(const [name,value]of [['target.json',bundle.target],['approved-state.json',bundle.approvedState],['wrangler.jsonc',bundle.wrangler]])await writeFile(resolve(privateRoot,name),json(value),{flag:'wx'});
 const config=await loadDeploymentConfig(app),source=JSON.parse(await readFile(resolve(app,'.local/verification/release/source-manifest.json'))),artifact=JSON.parse(await readFile(resolve(app,'.local/verification/release/artifact-manifest.json')));
 const {sourceBytes,artifactBytes}=bindMeasuredIdentity(source,artifact,approved);
 const migrations=Object.fromEntries(Object.entries(source.files).filter(([p])=>p.startsWith('migrations/')).map(([p,v])=>[p.slice(11),v]));
 const baseline=Object.fromEntries(Object.entries(migrations).filter(([p])=>Number(p.slice(0,4))<=17));
 const pins={format:1,state:'bound',releaseId:approved.releaseId,uploadTag:approved.releaseId+'-'+approved.artifactTreeSha256.slice(0,12),sourceTreeSha256:approved.sourceTreeSha256,artifactTreeSha256:approved.artifactTreeSha256,sourceManifestSha256:hash(sourceBytes),artifactManifestSha256:hash(artifactBytes),targetConfigSha256:config.targetConfigSha256,approvedStateSha256:config.approvedStateSha256,productionConfigSha256:config.productionConfigSha256,canonicalMigrationTreeSha256:treeDigest(migrations),canonicalBaselineMigrationTreeSha256:treeDigest(baseline)};
 for(const [name,bytes]of [['source-manifest.json',sourceBytes],['artifact-manifest.json',artifactBytes],['release-pins.json',json(pins)]])await writeFile(resolve(privateRoot,name),bytes,{flag:'wx'});
 await verifyRelease(app,config);
 console.log(JSON.stringify({prepared:true,commit:approved.commit,sourceTreeSha256:approved.sourceTreeSha256,artifactTreeSha256:approved.artifactTreeSha256}));
}
async function run(env){
 await assertProtectedEnvironment(env);
 const approved=await approval(env);if(env.PROJEKTOR_EXPECTED_COMMIT!==approved.commit)fail('APPROVED_CHECKOUT_MISMATCH');
 const config=await loadDeploymentConfig(app),release=await verifyRelease(app,config);
 if(release.sourceTreeSha256!==approved.sourceTreeSha256||release.artifactTreeSha256!==approved.artifactTreeSha256)fail('REVIEWED_BUILD_IDENTITY_MISMATCH');
 const credentials=createCredentialContext(env,config.target,app),port=createWranglerAdapter({candidate:app,credentials,configuration:config,release});
 const fingerprint=hash(JSON.stringify([config.target.account,config.target.worker,config.databaseId,config.hostname]));
 const local=createJournal(config.journalRoot,release);
 const journal=createGitHubJournal({env,approval:approved,targetFingerprint:fingerprint,target:config.target,local,port});
 const usecase=createReleaseUseCase({port,journal,release});
 let result=await usecase.upload(approved.expectedCurrent);
 if(result.phase==='UPLOAD_VERIFIED'&&approved.action==='upload-and-promote')result=await usecase.promote(approved.expectedCurrent);
 const summary={format:1,operationId:approved.operationId,commit:approved.commit,sourceTreeSha256:release.sourceTreeSha256,artifactTreeSha256:release.artifactTreeSha256,phase:result.phase,requiresOperatorReconciliation:result.phase==='RECONCILIATION_REQUIRED'};
 await writeFile(resolve(app,'.local/deployment-public-result.json'),json(summary));console.log(JSON.stringify(summary));
 if(summary.requiresOperatorReconciliation)process.exitCode=1;
}
async function main(){const [action,...extra]=process.argv.slice(2);if(extra.length)fail('UNEXPECTED_ARGUMENTS');if(action==='request'){validateRequest(process.env);return;}if(action==='environment'){console.log(JSON.stringify(await assertProtectedEnvironment(process.env)));return;}if(action==='prepare')return prepare(process.env);if(action==='run')return run(process.env);if(action==='clean')return rm(resolve(app,'.local/deployment'),{recursive:true,force:true});fail('HOST_ACTION_REQUIRED');}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(async error=>{const code=/^[A-Z_]+$/.test(error.message)?error.message:'LOCAL_OR_PROTOCOL_FAILURE';const result={format:1,status:'STOP',code,requiresOperatorReconciliation:true,privateDetailsWithheld:true};await mkdir(resolve(app,'.local'),{recursive:true});await writeFile(resolve(app,'.local/deployment-public-result.json'),json(result));console.error(JSON.stringify(result));process.exitCode=1;});
