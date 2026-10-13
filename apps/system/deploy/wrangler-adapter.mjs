// @module deployment
// @role wrangler
import {createHash} from 'node:crypto';
import {verifyRelease} from './guard.mjs';
import {assertPrivateConfigurationUnchanged} from './deployment-config.mjs';
import {officialCli,safeFailure,safeUploadSummary} from './official-cli.mjs';
import {createPrerequisiteReader} from './prerequisite-reader.mjs';
import {UUID,requiredOperations,assertTarget,assertReleaseIdentity,fail} from './cloudflare-port.mjs';
const digest=value=>createHash('sha256').update(value).digest('hex');
const sorted=values=>[...values].sort();
function classify(result) {
  const safe=safeFailure(result), raw=result.stdout+'\n'+result.stderr;
  const kind=/\b(?:401|403)\b|Authentication error|Unauthorized|Forbidden/i.test(raw)||safe.apiErrorCodes.some(c=>[10000,10001,10004,9109].includes(c))?'auth-denied':
    result.stopReason==='TIMEOUT'?'transient':result.stopReason?'safety-stop':'protocol';
  return {kind,code:result.stopReason||'OFFICIAL_COMMAND_FAILED'};
}
function successful(result) { return result.effectiveExitCode===0&&!result.stopReason&&!result.overflow&&!result.credentialFileCreated; }
export function normalizeVersion(raw,observedAt,target) {
  assertTarget(target);
  if(!UUID.test(raw?.id||'')||!Array.isArray(raw.resources?.bindings))fail('INVALID_VERSION_OBSERVATION');
  const runtime=raw.resources.script_runtime;
  if(!runtime||!Array.isArray(runtime.compatibility_flags))fail('INVALID_RUNTIME_OBSERVATION');
  const bindings=raw.resources.bindings.map(b=>{
    if(typeof b.name!=='string'||typeof b.type!=='string')fail('INVALID_BINDING_OBSERVATION');
    const out={name:b.name,type:b.type};
    if(b.type==='plain_text'){if(typeof b.text!=='string')fail('MISSING_PLAIN_BINDING_METADATA');out.textSha256=digest(b.text);}
    else if(b.type==='d1'){out.id=b.id||b.database_id;if(typeof out.id!=='string')fail('MISSING_D1_BINDING_ID');}
    else if(!['secret_text','assets'].includes(b.type))fail('UNREVIEWED_BINDING_TYPE');
    return out;
  }).sort((a,b)=>a.name.localeCompare(b.name));
  if(new Set(bindings.map(b=>b.name)).size!==bindings.length)fail('DUPLICATE_BINDING');
  return {target,observedAt,versionId:raw.id,compatibilityDate:runtime.compatibility_date,
    compatibilityFlags:sorted(runtime.compatibility_flags),migrationTag:runtime.migration_tag,
    origin:raw.resources.script?.last_deployed_from||raw.metadata?.source,
    preview:raw.metadata?.has_preview,scriptEtag:raw.resources.script?.etag,
    assets:runtime.assets?{notFoundHandling:runtime.assets.not_found_handling,runWorkerFirst:runtime.assets.raw_run_worker_first}:null,
    bindings,byteProof:'NOT_READ: remote Worker content is excluded'};
}
export function createWranglerAdapter({candidate,credentials,configuration,release:boundRelease}) {
  if(!configuration)fail('PRIVATE_DEPLOYMENT_NOT_CONFIGURED');
  const target=configuration.target;assertTarget(target);
  const config=['--config',configuration.configPath];
  const prerequisites=createPrerequisiteReader({candidate,credentials,configuration});
  async function run(args) { await assertPrivateConfigurationUnchanged(configuration);return credentials.run(env=>officialCli(candidate,[...args,...config],env,target)); }
  async function read(args) {
    const result=await run(args);
    if(!successful(result)){const e=Error('PROVIDER_READ_FAILED');e.kind=classify(result).kind;e.evidence=safeFailure(result);throw e;}
    try{return {raw:JSON.parse(result.stdout),observedAt:result.end};}catch{fail('UNEXPECTED_PROVIDER_JSON');}
  }
  return Object.freeze({
    describe:()=>({id:'official-wrangler-4.149.0',runtimeAvailable:true,operations:Object.fromEntries(requiredOperations.map(op=>[op,'supported'])),supportEvidence:'Pinned official CLI upload plus bounded fixed-target read-only prerequisite APIs; actual credentials/permissions and host remain unverified'}),
    async ready(){await prerequisites.ready();},
    async inspectPrerequisites(t,id){return prerequisites.inspect(t,id);},
    async inspectDeployment(t){
      assertTarget(t,target);const {raw,observedAt}=await read(['deployments','list','--json']);
      if(!Array.isArray(raw)||!raw.length)fail('INVALID_DEPLOYMENT_OBSERVATION');
      const d=raw.sort((a,b)=>String(b.created_on).localeCompare(String(a.created_on)))[0];
      if(!UUID.test(d.id||'')||!Array.isArray(d.versions))fail('INVALID_DEPLOYMENT_OBSERVATION');
      return {target,observedAt,deploymentId:d.id,versions:d.versions.map(v=>({versionId:v.version_id,percentage:v.percentage}))};
    },
    async inspectVersion(t,id){assertTarget(t,target);if(!UUID.test(id||''))fail('INVALID_VERSION_ID');const {raw,observedAt}=await read(['versions','view',id,'--json']);const v=normalizeVersion(raw,observedAt,target);if(v.versionId!==id)fail('VERSION_ID_MISMATCH');return v;},
    async uploadStaticVersion(t,release){
      assertTarget(t,target);assertTarget(release,target);
      // The official uploader exclusively owns asset sessions/JWTs/modules. No custom transport.
      assertReleaseIdentity(release);
      await verifyReleaseForDispatch(candidate,configuration,release);
      const result=await run(['versions','upload','--keep-vars','--strict','--tag',release.uploadTag]);
      const evidence=safeFailure(result);
      if(!successful(result))return {kind:'outcome-unknown',error:classify(result),evidence};
      const ids=[...result.stdout.matchAll(/(?:Worker |Current )?Version ID:\s*([0-9a-f-]{36})/g)].map(m=>m[1]);
      if(ids.length!==1||!UUID.test(ids[0]))return {kind:'outcome-unknown',error:{kind:'protocol',code:'UPLOAD_VERSION_ID_UNPROVEN'},evidence};
      return {kind:'command-reported',versionId:ids[0],evidence:{...evidence,assetSummary:safeUploadSummary(result.stdout)}};
    },
    async promoteVersion(t,id){
      assertTarget(t,target);if(!UUID.test(id||''))fail('INVALID_VERSION_ID');
      if(!boundRelease)fail('RELEASE_BINDING_REQUIRED');
      await verifyReleaseForDispatch(candidate,configuration,boundRelease);
      const result=await run(['versions','deploy',id+'@100%','--yes']);
      return successful(result)?{kind:'command-reported',versionId:id,evidence:safeFailure(result)}:{kind:'outcome-unknown',error:classify(result),evidence:safeFailure(result)};
    },
  });
}

/** Re-read the actual frozen bytes after provider preflight and immediately before mutation dispatch. */
export async function verifyReleaseForDispatch(candidate,configuration,expected){
 const actual=await verifyRelease(candidate,configuration);
 for(const key of ['releaseId','uploadTag','sourceTreeSha256','artifactTreeSha256','workerSha256','account','worker'])if(actual[key]!==expected[key])fail('RELEASE_DRIFT_BEFORE_DISPATCH');
 if(JSON.stringify(actual.policy)!==JSON.stringify(expected.policy))fail('RELEASE_DRIFT_BEFORE_DISPATCH');
 return actual;
}
