// @module repository.integration
// @role integration-test
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {inventory,treeDigest,verifyMeasuredInputs,verifyStagedInputs} from './system-release-inputs.mjs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const text=p=>readFile(resolve(root,p),'utf8');
test('root runtime/check entrypoints select only apps/system',async()=>{const p=JSON.parse(await text('package.json'));for(const key of ['start','dev','build','type-check','lint','test','verify']){assert.match(p.scripts[key],/^npm --prefix apps\/system /);assert.doesNotMatch(p.scripts[key],/turbo|apps\/(api|web)/);}assert.equal(p.scripts.deploy,'node scripts/require-deployment-review.mjs');});
test('canonical PR and release checks do not depend on retired implementations',async()=>{
 const ci=await text('.github/workflows/ci.yml'),release=await text('.github/workflows/release.yml'),atomic=await text('.github/workflows/atomic-command-poc.yml');
 const jobs=ci.split(/^jobs:\s*$/m)[1];
 assert.deepEqual([...jobs.matchAll(/^  ([\w-]+):\s*$/gm)].map(match=>match[1]),['system']);
 assert.match(jobs,/working-directory: apps\/system/);
 assert.match(jobs,/run: npm run verify:ci/);
 assert.match(jobs,/run: npm run docs:generate && git diff --exit-code -- docs\/openapi\.json/);
 assert.match(ci,/^  workflow_call:\s*$/m);
 assert.match(release,/uses: \.\/\.github\/workflows\/ci\.yml/);
 assert.match(release,/needs: ci/);
 // A CI-only edit must run the active gate, not trigger historic PoC baselines.
 assert.doesNotMatch(ci.split(/^permissions:/m)[0],/['"]\.github\/workflows\/ci\.yml['"]/);
 assert.doesNotMatch(atomic.split(/^permissions:/m)[0],/['"]\.github\/workflows\/ci\.yml['"]/);
 const {scripts}=JSON.parse(await text('package.json'));
 for(const suffix of ['',':update']){
  assert.equal(scripts['bundle-budget'+suffix],undefined);
  assert.match(scripts['legacy:bundle-budget'+suffix],/^tsx scripts\/bundle-budget\.ts/);
 }
});
test('release builder selects new Worker/Web/canonical migration chain',async()=>{const entry=await text('scripts/build-release.sh'),stage=await text('scripts/stage-system-release.mjs');assert.match(entry,/apps\/system run build:verified/);assert.doesNotMatch(entry+stage,/apps\/api|apps\/web|packages\/db/);for(const path of ['dist/worker','dist/web','migrations'])assert(stage.includes("resolve(app,'"+path+"')"));});
test('version authority and locked toolchain agree',async()=>{const p=JSON.parse(await text('apps/system/package.json')),lock=JSON.parse(await text('apps/system/package-lock.json'));assert.equal(p.name,'@projektor/system');assert.equal(p.version,lock.version);assert.equal(p.engines.node,'24.19.0');assert.equal(p.engines.npm,'11.9.0');assert.match(await text('.github/workflows/release-prepare.yml'),/working-directory: apps\/system/);assert.match(await text('.github/workflows/release-tag.yml'),/apps\/system\/package.json/);assert.match(await text('pnpm-workspace.yaml'),/!apps\/system/);});
test('runtime source cannot import retained applications or experiments',async()=>{async function visit(dir){for(const e of await readdir(dir,{withFileTypes:true})){const p=resolve(dir,e.name);if(e.isDirectory())await visit(p);else if(/\.[cm]?[jt]sx?$/.test(e.name))assert.doesNotMatch(await readFile(p,'utf8'),/(?:from\s*|import\s*\(|require\s*\()\s*['"][^'"]*(?:apps\/(?:api|web)|experiments\/|@projektor\/(?:api|web|db|types))/,p);}}await visit(resolve(root,'apps/system/src'));});

test('release rejects unlisted artifacts and source/migration drift after measured build',async()=>{
 const dir=await mkdtemp(resolve(tmpdir(),'projektor-release-inputs-'));
 try{
  await mkdir(resolve(dir,'dist/worker'),{recursive:true});await mkdir(resolve(dir,'migrations'));await mkdir(resolve(dir,'.local/verification/release'),{recursive:true});
  await writeFile(resolve(dir,'migrations/0001.sql'),'CREATE TABLE sample(id TEXT);');await writeFile(resolve(dir,'dist/worker/index.js'),'export default {};');
  const files=await inventory(dir,'',true),artifacts=await inventory(resolve(dir,'dist')),sourceTreeSha256=treeDigest(files);
  const source=JSON.stringify({format:3,state:'frozen',files,sourceTreeSha256});
  await writeFile(resolve(dir,'.local/verification/release/source-manifest.json'),source);
  await writeFile(resolve(dir,'.local/verification/release/artifact-manifest.json'),JSON.stringify({format:3,state:'frozen',sourceManifestSha256:createHash('sha256').update(source).digest('hex'),sourceTreeSha256,artifacts,artifactTreeSha256:treeDigest(artifacts),build:{exitCode:0,inputSourceTreeSha256:sourceTreeSha256,outputSourceTreeSha256:sourceTreeSha256}}));
  await verifyMeasuredInputs(dir);
  await writeFile(resolve(dir,'dist/worker/stale.js'),'unexpected');await assert.rejects(verifyMeasuredInputs(dir),/Artifact set changed/);await rm(resolve(dir,'dist/worker/stale.js'));
  await writeFile(resolve(dir,'migrations/0001.sql'),'DROP TABLE sample;');await assert.rejects(verifyMeasuredInputs(dir),/Source changed/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('staged copy rejects changed bytes and extra files independently of intact source',async()=>{
 const dir=await mkdtemp(resolve(tmpdir(),'projektor-release-stage-'));
 try{
  for(const p of ['worker','web','migrations'])await mkdir(resolve(dir,p));
  await writeFile(resolve(dir,'worker/index.js'),'export default {};');await writeFile(resolve(dir,'web/index.html'),'<div/>');await writeFile(resolve(dir,'migrations/0001.sql'),'CREATE TABLE sample(id TEXT);');
  const records=await inventory(dir),artifacts=Object.fromEntries(Object.entries(records).filter(([p])=>!p.startsWith('migrations/'))),source={files:Object.fromEntries(Object.entries(records).filter(([p])=>p.startsWith('migrations/')))},manifest={artifacts,artifactTreeSha256:treeDigest(artifacts)};
  await verifyStagedInputs(dir,source,manifest);
  await writeFile(resolve(dir,'worker/index.js'),'changed while copying');await assert.rejects(verifyStagedInputs(dir,source,manifest),/Staged artifacts/);await writeFile(resolve(dir,'worker/index.js'),'export default {};');
  await writeFile(resolve(dir,'web/extra.js'),'extra');await assert.rejects(verifyStagedInputs(dir,source,manifest),/Staged artifacts/);await rm(resolve(dir,'web/extra.js'));
  await writeFile(resolve(dir,'migrations/0001.sql'),'DROP TABLE sample;');await assert.rejects(verifyStagedInputs(dir,source,manifest),/Staged migrations/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
