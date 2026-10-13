// @module verification
// @role deployment-contract
// Defect: provider preflight can take time; a changed local Worker/Web must never upload under an old receipt hash.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {sha256,treeDigest,TREE_ALGORITHM,verifyRelease} from '../../deploy/guard.mjs';
import {loadDeploymentConfig} from '../../deploy/deployment-config.mjs';
import {createWranglerAdapter} from '../../deploy/wrangler-adapter.mjs';
import {candidate,target,configuration,DATABASE} from './synthetic-target.mjs';
const record=bytes=>({bytes:Buffer.byteLength(bytes),sha256:sha256(bytes)});
async function releaseFixture(t){
 const root=await mkdtemp(resolve(tmpdir(),'release-byte-recheck-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const files={'package.json':Buffer.from('{}'),'package-lock.json':Buffer.from('{}'),'wrangler.production.example.json':Buffer.from('{}'),'deploy/schema-contract.json':await readFile(resolve(candidate,'deploy/schema-contract.json'))};
 for(const name of (await readdir(resolve(candidate,'migrations'))).filter(n=>n.endsWith('.sql')).sort())files['migrations/'+name]=await readFile(resolve(candidate,'migrations',name));
 for(const [path,bytes]of Object.entries(files)){await mkdir(dirname(resolve(root,path)),{recursive:true});await writeFile(resolve(root,path),bytes);}
 const assets={'worker/index.js':Buffer.from('SYNTHETIC_WORKER_BYTES'),'web/index.html':Buffer.from('SYNTHETIC_WEB_BYTES')};
 for(const [path,bytes]of Object.entries(assets)){await mkdir(dirname(resolve(root,'dist',path)),{recursive:true});await writeFile(resolve(root,'dist',path),bytes);}
 const privateRoot=resolve(root,'.local/deployment');await mkdir(privateRoot,{recursive:true});
 await writeFile(resolve(privateRoot,'target.json'),JSON.stringify({format:1,...target,databaseId:DATABASE,hostname:configuration.hostname,gate:configuration.gate}));
 await writeFile(resolve(privateRoot,'approved-state.json'),JSON.stringify(configuration.approvedState));
 const config={account_id:target.account,name:target.worker,no_bundle:true,vars:{MCP_ENABLED:'false',AUTH_ORIGIN:'https://'+configuration.hostname},workers_dev:false,preview_urls:false,main:'../../dist/worker/index.js',assets:{directory:'../../dist/web',not_found_handling:'single-page-application',run_worker_first:['/api/*','/mcp']},d1_databases:[{binding:'DB',database_id:DATABASE,migrations_dir:'../../migrations'}],migrations:[{tag:'v2'}],compatibility_flags:['nodejs_compat'],compatibility_date:'2026-10-09'};
 const configBytes=Buffer.from(JSON.stringify(config));await writeFile(resolve(privateRoot,'wrangler.jsonc'),configBytes);
 const loaded=await loadDeploymentConfig(root),records=Object.fromEntries(Object.entries(files).map(([p,b])=>[p,record(b)])),artifactRecords=Object.fromEntries(Object.entries(assets).map(([p,b])=>[p,record(b)]));
 const sourceTreeSha256=treeDigest(records),artifactTreeSha256=treeDigest(artifactRecords),releaseId='projektor-modular-20261013';
 const sourceBytes=Buffer.from(JSON.stringify({format:3,state:'frozen',releaseId,treeAlgorithm:TREE_ALGORITHM,sourceTreeSha256,files:records}));
 const artifactBytes=Buffer.from(JSON.stringify({format:3,state:'frozen',releaseId,treeAlgorithm:TREE_ALGORITHM,sourceManifestSha256:sha256(sourceBytes),sourceTreeSha256,artifactTreeSha256,artifacts:artifactRecords,build:{command:'SYNTHETIC_STRUCTURAL_RECORD_NOT_A_REAL_BUILD',exitCode:0,startedAt:'2026-10-13T00:00:00Z',finishedAt:'2026-10-13T00:00:01Z',inputSourceTreeSha256:sourceTreeSha256,outputSourceTreeSha256:sourceTreeSha256}}));
 const migrations=Object.fromEntries(Object.entries(records).filter(([p])=>p.startsWith('migrations/')).map(([p,r])=>[p.slice(11),r]));
 const baseline=Object.fromEntries(Object.entries(migrations).filter(([p])=>Number(p.slice(0,4))<=17));
 const pins={format:1,state:'bound',releaseId,uploadTag:releaseId+'-'+artifactTreeSha256.slice(0,12),sourceManifestSha256:sha256(sourceBytes),artifactManifestSha256:sha256(artifactBytes),sourceTreeSha256,artifactTreeSha256,approvedStateSha256:loaded.approvedStateSha256,targetConfigSha256:loaded.targetConfigSha256,productionConfigSha256:sha256(configBytes),canonicalMigrationTreeSha256:treeDigest(migrations),canonicalBaselineMigrationTreeSha256:treeDigest(baseline)};
 for(const [name,bytes]of [['source-manifest.json',sourceBytes],['artifact-manifest.json',artifactBytes],['release-pins.json',JSON.stringify(pins)]])await writeFile(resolve(privateRoot,name),bytes);
 return {root,loaded,assets,release:await verifyRelease(root,loaded)};
}
test('changed Worker, Web or source after initial verification stops actual adapter before credential or CLI dispatch',async t=>{
 const f=await releaseFixture(t);let authCalls=0;
 const adapter=createWranglerAdapter({candidate:f.root,configuration:f.loaded,release:f.release,credentials:{check(){authCalls++;},run(){authCalls++;throw Error('MUST_NOT_DISPATCH');}}});
 for(const path of ['dist/worker/index.js','dist/web/index.html','package.json']){
  const location=resolve(f.root,path),before=await readFile(location);await writeFile(location,Buffer.concat([before,Buffer.from('changed')]));
  await assert.rejects(adapter.uploadStaticVersion(target,f.release),/RELEASE_FILE_BYTES_CHANGED/);await assert.rejects(adapter.promoteVersion(target,'11111111-1111-4111-8111-111111111111'),/RELEASE_FILE_BYTES_CHANGED/);assert.equal(authCalls,0);
  await writeFile(location,before);
 }
});
