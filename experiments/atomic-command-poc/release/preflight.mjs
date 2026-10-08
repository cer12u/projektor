import {readMCPRatePolicy} from '../service/mcp-rate.mjs';
// Read-only release preflight. It never deploys, creates resources, or mutates data.
import { strictJson } from './strict-json.mjs';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';
import { SourceTextModule } from 'node:vm';
import { isDeepStrictEqual } from 'node:util';
const fail = message => { throw new Error(`RELEASE_REJECTED: ${message}`); };
const exact = (value, names, label) => {
 if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
     !isDeepStrictEqual(Object.keys(value).sort(), [...names].sort())) fail(`${label}: unknown or missing fields`);
};
const same = (a,b,label) => { if (!isDeepStrictEqual(a,b)) fail(label); };
const text = value => typeof value === 'string' && value.length > 0 && value===value.trim() && value.trim().length>0 && !/[\p{Cc}\p{Surrogate}]/u.test(value) && !/PLACEHOLDER|REQUIRES_|UNVERIFIED/i.test(value);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const removed = /auto.?join|auto.?provision|trash.?purge|purge.?trash|cron|scheduled/i;
const varNames = ['APP_ORIGIN','WORKSPACE_IDS','REQUEST_TIMEOUT_MS','BODY_TIMEOUT_MS','PROVIDER_CONFIG','MCP_RATE_LIMIT_CONFIG'];
const legacyApiTokenVar = 'LEGACY_API_TOKEN_AUTH';

export function validateProfile(profile, observed) {
 exact(profile, ['schemaVersion','sourceCommit','worker','hostname','compatibilityDate','compatibilityFlags','entrypoint','vars','bindings','schedules','observability','expectedDeploymentVersion','workspaceBinding','lifecycleReview'], 'profile');
 exact(observed, ['worker','hostname','compatibilityDate','compatibilityFlags','bindings','schedules','observability','deploymentVersion'], 'observed live state');
 if (profile.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(profile.sourceCommit)) fail('source revision');
 if (profile.worker !== 'projektor' || profile.hostname !== 'projektor.cerutech.net') fail('production target');
 for (const key of ['worker','hostname','compatibilityDate','compatibilityFlags','observability']) same(profile[key],observed[key],`live ${key} changed`);
 if (!text(observed.deploymentVersion)) fail('missing current deployment');
 same(profile.expectedDeploymentVersion,observed.deploymentVersion,'deployment changed since review');
 same(profile.schedules,[],'this release has no scheduled maintenance');
 same(observed.schedules,[],'live schedules require renewed review');
 if (profile.entrypoint !== 'service/entry.mjs') fail('unreviewed entrypoint');
 const legacyApiTokenConfigured=Object.hasOwn(profile.vars??{},legacyApiTokenVar);
 exact(profile.vars,legacyApiTokenConfigured?[...varNames,legacyApiTokenVar]:varNames,'service vars');
 if (Object.keys(profile.vars).some(key=>removed.test(key))) fail('removed capability');
 const v=profile.vars;
 if(legacyApiTokenConfigured&&v[legacyApiTokenVar]!=='d39852-api-tokens-v1')fail('legacy API token auth mode');
 if(v.APP_ORIGIN!=='https://projektor.cerutech.net')fail('origin');
 let ids; try { ids=strictJson(v.WORKSPACE_IDS); } catch { fail('workspace registry'); }
 if(!Array.isArray(ids)||ids.length<1||ids.length>10||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id))) fail('workspace registry');
 if(!Number.isSafeInteger(Number(v.REQUEST_TIMEOUT_MS))||Number(v.REQUEST_TIMEOUT_MS)<1000||Number(v.REQUEST_TIMEOUT_MS)>30000||!Number.isSafeInteger(Number(v.BODY_TIMEOUT_MS))||Number(v.BODY_TIMEOUT_MS)<100||Number(v.BODY_TIMEOUT_MS)>Number(v.REQUEST_TIMEOUT_MS))fail('timeouts');
 let provider;try{provider=strictJson(v.PROVIDER_CONFIG);}catch{fail('provider config');}
 exact(provider,['issuer','jwksUrl','humanAudience','machineAudience','jwksCacheMs','jwksTimeoutMs'],'provider config');
 for(const key of ['issuer','jwksUrl']) {let url;if(!text(provider[key])||provider[key].length>2048)fail('provider URL');try{url=new URL(provider[key]);}catch{fail('provider URL');}if(url.protocol!=='https:'||url.username||url.password||url.hash||(key==='issuer'&&url.search))fail('provider URL');}
 if(!text(provider.humanAudience)||provider.humanAudience.length>256||(provider.machineAudience!==null&&(!text(provider.machineAudience)||provider.machineAudience.length>256||provider.humanAudience===provider.machineAudience)))fail('reviewed human audience and distinct machine audience or explicit null required');
 // A serialized null is permitted only when both machine authentication paths
 // are disabled. Existing legacy tokens still require a bounded MCP policy.
 if(!(provider.machineAudience===null&&!legacyApiTokenConfigured&&v.MCP_RATE_LIMIT_CONFIG==='null')&&!readMCPRatePolicy(v.MCP_RATE_LIMIT_CONFIG))fail('explicit bounded MCP invocation rate policy required');
 if(!Number.isSafeInteger(provider.jwksCacheMs)||provider.jwksCacheMs<5000||provider.jwksCacheMs>3600000||!Number.isSafeInteger(provider.jwksTimeoutMs)||provider.jwksTimeoutMs<50||provider.jwksTimeoutMs>10000)fail('JWKS bounds');
 if(!Array.isArray(observed.bindings)||!observed.bindings.length)fail('live binding inventory missing');
 const names=new Set();
 for(const binding of observed.bindings){
  exact(binding,['name','type','identity'],'binding attestation');
  if(!text(binding.name)||!text(binding.type)||!text(binding.identity)||names.has(binding.name)||binding.name==='WORKSPACE'||removed.test(binding.name)||varNames.includes(binding.name)||binding.name===legacyApiTokenVar)fail('live binding attestation');
  names.add(binding.name);
 }
 // Legacy API-token continuity reuses this attested existing DB. The exact
 // profile/live identity comparison below forbids substituting another source.
 for (const [name,type] of [['DB','d1'],['KV','kv_namespace'],['OAUTH_KV','kv_namespace'],['RATE_LIMITER','durable_object_namespace'],['JWT_SECRET','secret_text']]) if(!observed.bindings.some(binding=>binding.name===name&&binding.type===type))fail(`required live binding missing: ${name}`);
 if(observed.bindings.filter(binding=>binding.type==='r2_bucket').length!==1)fail('required live R2 binding');
 if(observed.bindings.find(binding=>binding.name==='KV').identity===observed.bindings.find(binding=>binding.name==='OAUTH_KV').identity)fail('distinct live KV namespaces required');
 exact(profile.workspaceBinding,['name','type','identity','className'],'workspace binding');
 if(profile.workspaceBinding.name!=='WORKSPACE'||profile.workspaceBinding.type!=='durable_object_namespace'||profile.workspaceBinding.className!=='WorkspaceService'||!text(profile.workspaceBinding.identity))fail('unprovisioned workspace binding');
 if(observed.bindings.some(binding=>binding.type==='durable_object_namespace'&&binding.identity===profile.workspaceBinding.identity))fail('WorkspaceService must not alias an existing namespace');
 same(profile.bindings,observed.bindings,'live binding identities changed');
 exact(profile.lifecycleReview,['rateLimiter','workspace','rollback'],'DO lifecycle review');
 const lifecycle=profile.lifecycleReview;
 exact(lifecycle.rateLimiter,['namespaceIdentity','className','exportResolution','evidence'],'RateLimiter lifecycle');
 exact(lifecycle.workspace,['namespaceIdentity','className','sqlite','migrationTag','evidence'],'WorkspaceService lifecycle');
 exact(lifecycle.rollback,['version','codeCompatibilityEvidence','dataRecoveryEvidence'],'rollback lifecycle');
 if(lifecycle.rateLimiter.namespaceIdentity!==observed.bindings.find(binding=>binding.name==='RATE_LIMITER').identity||lifecycle.rateLimiter.className!=='RateLimiter'||!text(lifecycle.rateLimiter.exportResolution)||!text(lifecycle.rateLimiter.evidence))fail('RateLimiter identity/export lifecycle unresolved');
 if(lifecycle.workspace.namespaceIdentity!==profile.workspaceBinding.identity||lifecycle.workspace.className!=='WorkspaceService'||lifecycle.workspace.sqlite!==true||!text(lifecycle.workspace.migrationTag)||!text(lifecycle.workspace.evidence))fail('WorkspaceService lifecycle unresolved');
 if(lifecycle.rollback.version!==observed.deploymentVersion||!text(lifecycle.rollback.codeCompatibilityEvidence)||!text(lifecycle.rollback.dataRecoveryEvidence))fail('rollback compatibility/recovery unresolved');
 return {profileValidated:true,deploymentAuthorized:false};
}

// Parse and link, but NEVER evaluate untrusted candidate code. Exact byte inventory
// is the security boundary; an export-name check alone cannot detect hidden writers.
export async function validateArtifact(root, review) {
 exact(review,['sourceCommit','entrypoint','exports','files'],'reviewed source manifest');
 if(!/^[a-f0-9]{40}$/.test(review.sourceCommit)||review.entrypoint!=='service/entry.mjs')fail('reviewed source identity');
 same(review.exports,['WorkspaceService','default'],'exact declared exports');
 if(!review.files||Object.getPrototypeOf(review.files)!==Object.prototype||!Object.keys(review.files).length)fail('reviewed files');
 const base=await realpath(root), modules=new Map(), visited=new Set();
 async function load(path){
  const full=await realpath(resolve(base,path)), rel=relative(base,full).replaceAll('\\','/');
  if(rel.startsWith('../')||rel.startsWith('/')||!Object.hasOwn(review.files,rel))fail('unreviewed import');
  if(modules.has(rel))return modules.get(rel);
  const source=await readFile(full);
  if(!/^[a-f0-9]{64}$/.test(review.files[rel])||hash(source)!==review.files[rel])fail(`source hash changed: ${rel}`);
  visited.add(rel);
  const moduleSource=rel.endsWith('.sql') ? 'export default '+JSON.stringify(source.toString('utf8'))+';' : source.toString('utf8');
  const mod=new SourceTextModule(moduleSource,{identifier:rel,importModuleDynamically(){fail('dynamic import');}});
  // Dynamic imports are rejected by the reviewed byte inventory, not evaluated.
  modules.set(rel,mod);return mod;
 }
 const entry=await load(review.entrypoint);
 await entry.link(async (specifier,ref)=>{
  if(['cloudflare:workers','node:crypto','node:buffer'].includes(specifier)){
   // Parsing-only stand-in: no runtime code runs during this check.
   const stubs={'cloudflare:workers':'export class DurableObject {}','node:crypto':'export const randomBytes=0,randomUUID=0,createHash=0,createHmac=0,timingSafeEqual=0;','node:buffer':'export const Buffer=0;'};
   return new SourceTextModule(stubs[specifier]);
  }
  if(!specifier.startsWith('./')&&!specifier.startsWith('../'))fail('external import');
  return load(resolve(base,dirname(ref.identifier),specifier));
 });
 same([...visited].sort(),Object.keys(review.files).sort(),'artifact contains undeclared or unreachable source');
 same(Object.getOwnPropertyNames(entry.namespace).sort(),review.exports,'artifact exports changed');
 return {artifactValidated:true,files:visited.size,deploymentAuthorized:false};
}

export async function preflight(root, profile, observed, review) {
 validateProfile(profile,observed);
 same(profile.sourceCommit,review.sourceCommit,'profile and reviewed source revision disagree');
 await validateArtifact(root,review);
 return {profileValidated:true,artifactValidated:true,deploymentAuthorized:false};
}
