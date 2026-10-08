import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,readFile,cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {validateProfile,validateArtifact} from './preflight.mjs';
import {strictJson} from './strict-json.mjs';
import {configuration} from '../service/config.mjs';
const root=new URL('../',import.meta.url).pathname;
const commit='caa65d78580812be8117a703c0743be82ee349cf';
const sha=s=>createHash('sha256').update(s).digest('hex');
function valid(){
 // Explicitly synthetic fixture, never a real deployable manifest or invented live ID.
 const observed={worker:'projektor',hostname:'projektor.cerutech.net',compatibilityDate:'2024-09-23',compatibilityFlags:['nodejs_compat','global_fetch_strictly_public','cache_option_enabled'],bindings:[{name:'DB',type:'d1',identity:'synthetic-test-database'},{name:'RATE_LIMITER',type:'durable_object_namespace',identity:'synthetic-test-rate-limiter'},{name:'KV',type:'kv_namespace',identity:'synthetic-kv'},{name:'OAUTH_KV',type:'kv_namespace',identity:'synthetic-oauth-kv'},{name:'JWT_SECRET',type:'secret_text',identity:'binding-name-and-type-presence-only'},{name:'SYNTHETIC_FILES',type:'r2_bucket',identity:'synthetic-r2'}],schedules:[],observability:{logs:{enabled:true,headSamplingRate:0.1},traces:{enabled:false}},deploymentVersion:'synthetic-test-deployment'};
 const profile={schemaVersion:1,sourceCommit:commit,worker:observed.worker,hostname:observed.hostname,compatibilityDate:observed.compatibilityDate,compatibilityFlags:observed.compatibilityFlags,entrypoint:'service/entry.mjs',vars:{APP_ORIGIN:'https://projektor.cerutech.net',WORKSPACE_IDS:'["10000000-0000-4000-8000-000000000001"]',REQUEST_TIMEOUT_MS:'5000',BODY_TIMEOUT_MS:'1000',PROVIDER_CONFIG:JSON.stringify({issuer:'https://team.example.invalid',jwksUrl:'https://team.example.invalid/certs',humanAudience:'synthetic-human',machineAudience:'synthetic-machine',jwksCacheMs:60000,jwksTimeoutMs:1000})},bindings:structuredClone(observed.bindings),schedules:[],observability:observed.observability,expectedDeploymentVersion:observed.deploymentVersion,workspaceBinding:{name:'WORKSPACE',type:'durable_object_namespace',identity:'synthetic-new-workspace',className:'WorkspaceService'},lifecycleReview:{rateLimiter:{namespaceIdentity:'synthetic-test-rate-limiter',className:'RateLimiter',exportResolution:'synthetic separately reviewed compatibility plan',evidence:'synthetic reviewer reference'},workspace:{namespaceIdentity:'synthetic-new-workspace',className:'WorkspaceService',sqlite:true,migrationTag:'synthetic-tag',evidence:'synthetic reviewer reference'},rollback:{version:observed.deploymentVersion,codeCompatibilityEvidence:'synthetic review',dataRecoveryEvidence:'synthetic restore drill'}}};
 return {profile,observed};
}
test('positive strict profile preserves attested identities and never authorizes deployment',()=>{
 const {profile,observed}=valid();assert.deepEqual(validateProfile(profile,observed),{profileValidated:true,deploymentAuthorized:false});
});
test('all removed switches fail even with none/false; unknown config rejected',()=>{
 for(const name of ['AUTO_JOIN_ROLE','AUTO_PROVISION_MEMBERSHIP','TRASH_PURGE','PURGE_TRASH','CRON','scheduled','unknown'])for(const value of ['none',false,true]){
  const {profile,observed}=valid();profile.vars[name]=value;assert.throws(()=>validateProfile(profile,observed),/RELEASE_REJECTED/);
 }
 for(const key of ['triggers','migrations','env','routes','unknown']){const{profile,observed}=valid();profile[key]={};assert.throws(()=>validateProfile(profile,observed));}
});
test('cron, changed bindings, stale deployment, unknown nested fields and unprovisioned namespace reject',()=>{
 const mutations=[p=>p.schedules=['0 0 * * *'],p=>p.bindings[0].identity='different',p=>p.bindings.push({name:'X',type:'kv',identity:'extra'}),p=>p.expectedDeploymentVersion='stale',p=>p.entrypoint='apps/api/src/index.ts',p=>p.workspaceBinding.identity='REQUIRES_APPROVED_ID',p=>p.workspaceBinding.autoProvision=true,p=>p.lifecycleReview.status='pending',p=>p.vars.ENVIRONMENT='development',p=>p.vars.PROVIDER_CONFIG=JSON.stringify({issuer:'https://example.invalid',unknown:true})];
 for(const mutate of mutations){const{profile,observed}=valid();mutate(profile);assert.throws(()=>validateProfile(profile,observed));}
});
test('runtime rejects removed feature configuration before authentication or storage',()=>{
 const env={APP_ORIGIN:'https://projektor.cerutech.net',REQUEST_TIMEOUT_MS:'5000',BODY_TIMEOUT_MS:'1000',WORKSPACE_IDS:'["10000000-0000-4000-8000-000000000001"]',PROVIDER_CONFIG:'{}',WORKSPACE:{get(){throw Error('never');},idFromName(){throw Error('never');}}};
 assert.equal(configuration(env).deadline,5000);
 for(const name of ['AUTO_JOIN_ROLE','AUTO_PROVISION_MEMBERSHIP','TRASH_PURGE_ENABLED','PURGE_TRASH','CRON','scheduled'])for(const value of ['none',false,true])assert.throws(()=>configuration({...env,[name]:value}),{code:'SERVICE_CONFIG_INVALID'});
});
async function fixture(source){const dir=await mkdtemp(join(tmpdir(),'projektor-release-'));await mkdir(join(dir,'service'));await writeFile(join(dir,'service/entry.mjs'),source);return{dir,review:{sourceCommit:commit,entrypoint:'service/entry.mjs',exports:['WorkspaceService','default'],files:{'service/entry.mjs':sha(source)}}};}
test('artifact permits only exact declared exports; parses without executing candidate',async()=>{
 const good=await fixture('throw Error("must not execute"); export class WorkspaceService{}; export default {fetch(){}};');
 assert.equal((await validateArtifact(good.dir,good.review)).artifactValidated,true);
 for(const extra of ['export const scheduled=1;','export function purgeTrash(){}','export function autoProvisionMembership(){}','export const unknown=1;']){
  const f=await fixture('export class WorkspaceService{};export default {fetch(){}};'+extra);await assert.rejects(validateArtifact(f.dir,f.review),/artifact exports changed/);
 }
 await writeFile(join(good.dir,'service/entry.mjs'),'export const scheduled=1;');await assert.rejects(validateArtifact(good.dir,good.review),/source hash changed/);
});
test('reviewed real product graph validates; hidden source mutation rejects',async()=>{
 const review=JSON.parse(await readFile(new URL('./reviewed-product.json',import.meta.url),'utf8'));
 assert.equal((await validateArtifact(root,review)).files,9);
 const dir=await mkdtemp(join(tmpdir(),'projektor-graph-'));
 for(const file of Object.keys(review.files)){await mkdir(join(dir,file,'..'),{recursive:true});await cp(join(root,file),join(dir,file));}
 await writeFile(join(dir,'service/entry.mjs'),(await readFile(join(dir,'service/entry.mjs'),'utf8')).replace('async fetch','async scheduled(){},async fetch'));
 await assert.rejects(validateArtifact(dir,review),/source hash changed/);
});

test('missing known live bindings and duplicate configuration keys reject',()=>{
 for(const name of ['DB','KV','OAUTH_KV','JWT_SECRET','RATE_LIMITER','SYNTHETIC_FILES']){
  const {profile,observed}=valid();observed.bindings=observed.bindings.filter(b=>b.name!==name);profile.bindings=structuredClone(observed.bindings);assert.throws(()=>validateProfile(profile,observed));
 }
 assert.throws(()=>strictJson('{"AUTO_JOIN_ROLE":"none","AUTO_JOIN_ROLE":"viewer"}'));
 assert.throws(()=>strictJson('{"vars":{},"vars":{}}'));
});
test('hash integrity is not capability scanning: independently trusted review input is mandatory',async()=>{
 // A reviewer must NOT approve these hashes. This demonstrates the explicit trust boundary.
 for(const source of ['export class WorkspaceService{}; export default {fetch(){},scheduled(){}};', 'export class WorkspaceService{}; export default {fetch(){return import("./unreviewed.mjs")}};']){
  const f=await fixture(source);assert.equal((await validateArtifact(f.dir,f.review)).artifactValidated,true);
 }
});

test('strict JSON safely retains prototype names and rejects escaped duplicate keys',()=>{
 for(const value of ['false','null','{"x":1}']){
  const obj=strictJson('{"__proto__":'+value+'}');assert.equal(Object.getPrototypeOf(obj),Object.prototype);assert.equal(Object.hasOwn(obj,'__proto__'),true);
  assert.throws(()=>strictJson('{"__proto__":'+value+',"__proto__":true}'));
 }
 assert.throws(()=>strictJson('{"a":1,"\\u0061":2}'));
});

test('new namespace cannot alias live state; evidence and provider fields are bounded',()=>{
 const mutations=[p=>{p.workspaceBinding.identity='synthetic-test-rate-limiter';p.lifecycleReview.workspace.namespaceIdentity=p.workspaceBinding.identity;},p=>p.lifecycleReview.workspace.migrationTag=' ',p=>p.lifecycleReview.rateLimiter.exportResolution='\t',p=>p.lifecycleReview.rollback.dataRecoveryEvidence='\n'];
 for(const mutate of mutations){const{profile,observed}=valid();mutate(profile);assert.throws(()=>validateProfile(profile,observed));}
 for(const change of [{issuer:' https://team.example.invalid'},{issuer:'https://team.example.invalid?x=1'},{humanAudience:'a'.repeat(257)},{jwksUrl:'https://team.example.invalid/'+ 'a'.repeat(2048)}]){const{profile,observed}=valid();profile.vars.PROVIDER_CONFIG=JSON.stringify({...JSON.parse(profile.vars.PROVIDER_CONFIG),...change});assert.throws(()=>validateProfile(profile,observed));}
});
