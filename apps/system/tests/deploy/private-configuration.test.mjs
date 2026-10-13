// @module verification
// @role deployment-contract
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {loadDeploymentConfig,validateDeploymentTarget,assertPrivateConfigurationUnchanged} from '../../deploy/deployment-config.mjs';
import {officialCli,safeFailure} from '../../deploy/official-cli.mjs';
import {verifyToolchain} from '../../deploy/wrangler-toolchain.mjs';
import {guardEnvironment} from '../../deploy/credential-context.mjs';
import {verifyProductionConfig} from '../../deploy/guard.mjs';
import {ACCOUNT,WORKER,DATABASE,target,candidate,configuration} from './synthetic-target.mjs';
const value={format:1,...target,databaseId:DATABASE,hostname:configuration.hostname,gate:configuration.gate};
async function fixture(t){const root=await mkdtemp(resolve(tmpdir(),'deployment-private-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(resolve(root,'.local/deployment'),{recursive:true});return root;}
test('unconfigured entrypoint stops locally before any credential or network access',()=>{
 const r=spawnSync(process.execPath,[resolve(candidate,'deploy/deploy.mjs'),'deployments',candidate],{encoding:'utf8',env:{PATH:process.env.PATH,CLOUDFLARE_API_TOKEN:'SYNTHETIC_MUST_NOT_USE',CLOUDFLARE_API_BASE_URL:'https://never.invalid'}});
 assert.equal(r.status,1);assert.match(r.stderr,/PRIVATE_DEPLOYMENT_NOT_CONFIGURED/);assert(!r.stderr.includes('SYNTHETIC_MUST_NOT_USE'));assert.equal(r.stdout,'');
});
test('private target is explicit, closed, stopped and constrained to safe path segments',()=>{
 assert.equal(validateDeploymentTarget(value),value);
 for(const change of [{account:'../other'},{worker:'../other'},{databaseId:'../../other'},{hostname:'https://other.test/path'},{hostname:'example.invalid'},{gate:{mode:'open',epoch:4}},{gate:{mode:'stopped',epoch:-1}},{token:'synthetic'}])assert.throws(()=>validateDeploymentTarget({...value,...change}));
});
test('configuration has no account/profile/env fallback and rejects symlink targets',async t=>{
 const root=await fixture(t),dir=resolve(root,'.local/deployment');
 await assert.rejects(loadDeploymentConfig(root),/PRIVATE_DEPLOYMENT_NOT_CONFIGURED/);
 await writeFile(resolve(dir,'target.json'),JSON.stringify(value));await writeFile(resolve(dir,'approved-state.json'),JSON.stringify(configuration.approvedState));await writeFile(resolve(dir,'wrangler.jsonc'),'{}');
 const loaded=await loadDeploymentConfig(root);assert.deepEqual(loaded.target,target);assert.equal(loaded.configPath,resolve(dir,'wrangler.jsonc'));assert.equal(loaded.journalRoot,resolve(dir,'journals'));
 await assertPrivateConfigurationUnchanged(loaded);await writeFile(resolve(dir,'wrangler.jsonc'),'{"name":"changed"}');await assert.rejects(assertPrivateConfigurationUnchanged(loaded),/PRIVATE_CONFIGURATION_DRIFT/);
 await rm(resolve(dir,'target.json'));await symlink(resolve(dir,'approved-state.json'),resolve(dir,'target.json'));await assert.rejects(loadDeploymentConfig(root),/PRIVATE_CONFIG_NOT_REGULAR/);
});
test('credential execution still rejects account drift, auth alternatives, TLS weakening and proxy bypass',()=>{
 const base={CLOUDFLARE_API_TOKEN:'synthetic',HTTPS_PROXY:'http://127.0.0.1:9'};assert.doesNotThrow(()=>guardEnvironment(base,{target}));
 for(const change of [{CLOUDFLARE_ACCOUNT_ID:'b'.repeat(32)},{CF_API_TOKEN:'synthetic'},{CLOUDFLARE_API_BASE_URL:'https://other.test'},{NODE_TLS_REJECT_UNAUTHORIZED:'0'},{NO_PROXY:'*.com'},{no_proxy:'localhost api.cloudflare.com'},{NO_PROXY:'api.cloudflare.com:0443'},{HTTPS_PROXY:''}])assert.throws(()=>guardEnvironment({...base,...change},{target}));
});
test('private Wrangler paths cannot redirect upload away from verified built assets',()=>{
 const cfg={account_id:ACCOUNT,name:WORKER,no_bundle:true,vars:{MCP_ENABLED:'false',AUTH_ORIGIN:'https://'+configuration.hostname},workers_dev:false,preview_urls:false,main:'../../dist/worker/index.js',assets:{directory:'../../dist/web'},d1_databases:[{binding:'DB',database_id:DATABASE,migrations_dir:'../../migrations'}],migrations:[{tag:'v2'}],compatibility_flags:['nodejs_compat'],compatibility_date:'2026-10-09'};
 assert.doesNotThrow(()=>verifyProductionConfig(candidate,cfg,configuration));
 for(const change of [{main:'../../src/apps/worker.ts'},{assets:{directory:'/unreviewed'}},{vars:{...cfg.vars,MCP_ENABLED:'true'}},{account_id:'b'.repeat(32)},{d1_databases:[{...cfg.d1_databases[0],database_id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'}]}])assert.throws(()=>verifyProductionConfig(candidate,{...cfg,...change},configuration));
});

test('pinned official CLI still starts with an explicit synthetic target and no credential/profile',async()=>{
 await verifyToolchain(candidate);
 const result=await officialCli(candidate,['--version'],{PATH:process.env.PATH,HTTPS_PROXY:'http://127.0.0.1:9'},target);
 assert.equal(result.effectiveExitCode,0);assert.equal(result.credentialFileCreated,false);assert.match(result.stdout,/4\.149\.0/);assert.equal(safeFailure(result).rawOutputWithheld,true);
});
