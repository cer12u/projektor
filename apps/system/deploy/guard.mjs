// @module deployment
// @role artifacts
import {readFile,readdir,lstat} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {CLI_VERSION,RELEASE_ID_PATTERN,CANONICAL_BASELINE_MIGRATION_TREE_SHA256,assertReleaseIdentity} from './cloudflare-port.mjs';
export {CLI_VERSION,UUID} from './cloudflare-port.mjs';
const here=dirname(fileURLToPath(import.meta.url));
// Per-release identities stay outside candidate, preventing a source-manifest self-hash cycle.
import {loadDeploymentConfig} from './deployment-config.mjs';
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export const TREE_ALGORITHM='sha256-path-null-size-null-hash-lf-v1';
const HASH=/^[a-f0-9]{64}$/;
const fail=code=>{throw Error(code);};
const byteSort=paths=>paths.sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
export function validateRecords(records){
  if(!records||Array.isArray(records)||typeof records!=='object'||!Object.keys(records).length)fail('EMPTY_FILE_MANIFEST');
  for(const [path,entry]of Object.entries(records)){
    if(!path||path.startsWith('/')||path.includes('\\')||/[\x00-\x1f\x7f]/.test(path)||path.split('/').some(s=>!s||s==='.'||s==='..'))fail('UNSAFE_MANIFEST_PATH');
    if(!entry||!Number.isSafeInteger(entry.bytes)||entry.bytes<0||!HASH.test(entry.sha256||''))fail('INVALID_MANIFEST_ENTRY');
  }
}
export function treeDigest(records){
  validateRecords(records);
  return sha256(Buffer.concat(byteSort(Object.keys(records)).map(path=>Buffer.from(path+'\0'+records[path].bytes+'\0'+records[path].sha256+'\n','utf8'))));
}
async function files(dir,prefix='',skipRoot=new Set()){
  if(!(await lstat(dir)).isDirectory())fail('RELEASE_ROOT_NOT_DIRECTORY');
  const out=[];
  for(const entry of await readdir(dir,{withFileTypes:true})){
    if(!prefix&&skipRoot.has(entry.name)){if(!entry.isDirectory()&&!entry.isSymbolicLink())fail('EXCLUDED_ROOT_NOT_TREE');continue;}
    if(/^\.env(?:\.|$)|^\.dev\.vars(?:\.|$)/.test(entry.name))fail('LOCAL_CREDENTIAL_FILE_PRESENT');
    const name=prefix+entry.name;
    if(entry.isSymbolicLink())fail('RELEASE_SYMLINK');
    if(entry.isDirectory())out.push(...await files(resolve(dir,entry.name),name+'/',skipRoot));
    else if(entry.isFile())out.push(name);
    else fail('NONREGULAR_RELEASE_FILE');
  }
  return byteSort(out);
}
async function verifyFiles(root,records,actualPaths){
  validateRecords(records);
  if(JSON.stringify(actualPaths)!==JSON.stringify(byteSort(Object.keys(records))))fail('RELEASE_FILE_SET_CHANGED');
  for(const [path,expected]of Object.entries(records)){
    if(!(await lstat(resolve(root,path))).isFile())fail('RELEASE_FILE_NOT_REGULAR');
    const bytes=await readFile(resolve(root,path));
    if(bytes.length!==expected.bytes||sha256(bytes)!==expected.sha256)fail('RELEASE_FILE_BYTES_CHANGED');
  }
}
export async function verifySourceInventory(candidate,records){
  return verifyFiles(candidate,records,await files(candidate,'',new Set(['dist','node_modules','.local','.wrangler'])));
}
export function validateManifestPair(pins,sourceBytes,artifactBytes){
  if(pins?.format!==1||pins.state!=='bound')fail('RELEASE_NOT_FROZEN');
  for(const key of ['sourceManifestSha256','artifactManifestSha256','sourceTreeSha256','artifactTreeSha256','approvedStateSha256','canonicalMigrationTreeSha256','canonicalBaselineMigrationTreeSha256','productionConfigSha256','targetConfigSha256'])if(!HASH.test(pins[key]||''))fail('INCOMPLETE_RELEASE_PINS');
  if(sha256(sourceBytes)!==pins.sourceManifestSha256||sha256(artifactBytes)!==pins.artifactManifestSha256)fail('RELEASE_MANIFEST_CHANGED');
  const source=JSON.parse(sourceBytes),artifacts=JSON.parse(artifactBytes);
  if(source.format!==3||artifacts.format!==3||source.state!=='frozen'||artifacts.state!=='frozen')fail('RELEASE_MANIFEST_NOT_FROZEN');
  if(source.treeAlgorithm!==TREE_ALGORITHM||artifacts.treeAlgorithm!==TREE_ALGORITHM)fail('TREE_ALGORITHM_MISMATCH');
  if(!RELEASE_ID_PATTERN.test(pins.releaseId||'')||source.releaseId!==pins.releaseId||artifacts.releaseId!==pins.releaseId)fail('RELEASE_ID_MISMATCH');
  const sourceTree=treeDigest(source.files),artifactTree=treeDigest(artifacts.artifacts);
  if(sourceTree!==source.sourceTreeSha256||sourceTree!==artifacts.sourceTreeSha256||sourceTree!==pins.sourceTreeSha256)fail('SOURCE_TREE_MISMATCH');
  if(artifactTree!==artifacts.artifactTreeSha256||artifactTree!==pins.artifactTreeSha256)fail('ARTIFACT_TREE_MISMATCH');
  if(artifacts.sourceManifestSha256!==pins.sourceManifestSha256)fail('BUILD_SOURCE_MANIFEST_MISMATCH');
  assertReleaseIdentity(pins);
  const build=artifacts.build;
  if(!build||build.exitCode!==0||typeof build.command!=='string'||!build.command.trim()||!Number.isFinite(Date.parse(build.startedAt))||!Number.isFinite(Date.parse(build.finishedAt))||Date.parse(build.finishedAt)<Date.parse(build.startedAt)||build.inputSourceTreeSha256!==sourceTree||build.outputSourceTreeSha256!==sourceTree)fail('BUILD_SOURCE_ASSOCIATION_MISSING');
  return {source,artifacts};
}
export function verifyMigrationInventory(migrations,pins){
  validateRecords(migrations);
  const expectedMigrations=byteSort(Object.keys(migrations));
  if(expectedMigrations.length!==21||expectedMigrations.some((name,i)=>!name.startsWith(String(i+1).padStart(4,'0')+'_')||!/^\d{4}_[a-z0-9_]+\.sql$/.test(name))||treeDigest(migrations)!==pins.canonicalMigrationTreeSha256)fail('MIGRATIONS_NOT_EXACT_RELEASE_21');
  const baseline=Object.fromEntries(expectedMigrations.slice(0,17).map(name=>[name,migrations[name]]));
  if(pins.canonicalBaselineMigrationTreeSha256!==CANONICAL_BASELINE_MIGRATION_TREE_SHA256||treeDigest(baseline)!==CANONICAL_BASELINE_MIGRATION_TREE_SHA256)fail('APPLIED_CANONICAL_17_CHANGED');
  return expectedMigrations;
}
export async function verifyRelease(candidate,configuration){
  candidate=resolve(candidate);
  configuration??=await loadDeploymentConfig(candidate);
  const verification=configuration.verificationRoot;
  const pins=JSON.parse(await readFile(resolve(verification,'release-pins.json')));
  // No retained earlier release manifest or caller-selected manifest directory fallback.
  if(pins.state!=='bound')fail('RELEASE_NOT_FROZEN');
  const sourceBytes=await readFile(resolve(verification,'source-manifest.json'));
  const artifactBytes=await readFile(resolve(verification,'artifact-manifest.json'));
  const {source,artifacts}=validateManifestPair(pins,sourceBytes,artifactBytes);
  // Complete source inventory includes architecture metadata/checker and all fixtures.
  // Only these explicit dependency/runtime/output roots are outside this source tree.
  await verifySourceInventory(candidate,source.files);
  await verifyFiles(resolve(candidate,'dist'),artifacts.artifacts,await files(resolve(candidate,'dist')));
  for(const required of ['package.json','package-lock.json','wrangler.production.example.json','deploy/schema-contract.json'])if(!source.files[required])fail('REQUIRED_BUILD_INPUT_MISSING');
  const configBytes=await readFile(configuration.configPath);
  if(sha256(configBytes)!==pins.productionConfigSha256||configuration.targetConfigSha256!==pins.targetConfigSha256)fail('APPROVED_CONFIG_CHANGED');
  const migrations=Object.fromEntries(Object.entries(source.files).filter(([path])=>path.startsWith('migrations/')).map(([path,entry])=>[path.slice(11),entry]));
  const expectedMigrations=verifyMigrationInventory(migrations,pins);
  if(!artifacts.artifacts['worker/index.js']||!artifacts.artifacts['web/index.html'])fail('REQUIRED_RELEASE_ARTIFACT_MISSING');
  if(configuration.approvedStateSha256!==pins.approvedStateSha256)fail('APPROVED_STATE_CHANGED');
  const approvedState=configuration.approvedState;
  const config=JSON.parse(configBytes),target=configuration.target;
  verifyProductionConfig(candidate,config,configuration);
  const schema=JSON.parse(await readFile(resolve(here,'schema-contract.json')));
  if(schema.format!==1||!Array.isArray(schema.migrations)||schema.migrations.length!==21||schema.migrations.some((m,i)=>m.name!==expectedMigrations[i]||migrations[m.name]?.sha256!==m.sha256))fail('CANONICAL_SCHEMA_SOURCE_CHANGED');
  return {releaseId:pins.releaseId,uploadTag:pins.uploadTag,sourceTreeSha256:pins.sourceTreeSha256,
    policy:{prerequisites:{databaseId:config.d1_databases[0].database_id,migrationNames:expectedMigrations,gate:configuration.gate,security:approvedState.security},compatibilityDate:config.compatibility_date,compatibilityFlags:config.compatibility_flags,
      migrationTag:config.migrations.at(-1).tag,assets:{notFoundHandling:config.assets.not_found_handling,runWorkerFirst:config.assets.run_worker_first},
      bindings:[{name:'ASSETS',type:'assets'},{name:'DB',type:'d1',id:config.d1_databases[0].database_id},...Object.entries(config.vars).map(([name,text])=>({name,type:'plain_text',textSha256:sha256(text)}))]},
    account:target.account,worker:target.worker,cliVersion:CLI_VERSION,artifactTreeSha256:pins.artifactTreeSha256,
    workerSha256:artifacts.artifacts['worker/index.js'].sha256,migrations:21,artifacts:Object.keys(artifacts.artifacts).length};
}

export function verifyProductionConfig(candidate,config,configuration){
 const target=configuration.target,base=dirname(configuration.configPath);
 if(config.account_id!==target.account||config.name!==target.worker||config.no_bundle!==true||config.vars?.MCP_ENABLED!=='false'||config.vars?.AUTH_ORIGIN!=='https://'+configuration.hostname||config.workers_dev!==false||config.preview_urls!==false)fail('APPROVED_TARGET_OR_SECURITY_CONFIG_CHANGED');
 if(typeof config.main!=='string'||resolve(base,config.main)!==resolve(candidate,'dist/worker/index.js')||typeof config.assets?.directory!=='string'||resolve(base,config.assets.directory)!==resolve(candidate,'dist/web'))fail('APPROVED_ARTIFACT_PATH_CHANGED');
 if(config.d1_databases?.length!==1||config.d1_databases[0].binding!=='DB'||config.d1_databases[0].database_id!==configuration.databaseId||typeof config.d1_databases[0].migrations_dir!=='string'||resolve(base,config.d1_databases[0].migrations_dir)!==resolve(candidate,'migrations'))fail('APPROVED_DATABASE_CHANGED');
 if(!Array.isArray(config.migrations)||!config.migrations.length||!Array.isArray(config.compatibility_flags)||typeof config.compatibility_date!=='string')fail('RUNTIME_CONFIG_INCOMPLETE');
}
