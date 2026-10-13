// @module verification
// @role deployment-contract
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {sha256,TREE_ALGORITHM,treeDigest,validateManifestPair,verifySourceInventory,verifyMigrationInventory} from '../../deploy/guard.mjs';
const record=text=>({bytes:Buffer.byteLength(text),sha256:sha256(text)});
function bundle(){
  const files={'src/a.ts':record('export const a=1;')},artifacts={'worker/index.js':record('worker'), 'web/index.html':record('web')};
  const sourceTreeSha256=treeDigest(files),artifactTreeSha256=treeDigest(artifacts),releaseId='projektor-modular-20261012';
  const source={format:3,state:'frozen',releaseId,treeAlgorithm:TREE_ALGORITHM,sourceTreeSha256,files};
  const sourceBytes=Buffer.from(JSON.stringify(source));
  const artifact={format:3,state:'frozen',releaseId,treeAlgorithm:TREE_ALGORITHM,sourceManifestSha256:sha256(sourceBytes),sourceTreeSha256,artifactTreeSha256,artifacts,
    build:{command:'LOCAL_TEST_RECORD_ONLY',exitCode:0,startedAt:'2026-10-12T14:00:00Z',finishedAt:'2026-10-12T14:00:01Z',inputSourceTreeSha256:sourceTreeSha256,outputSourceTreeSha256:sourceTreeSha256}};
  const artifactBytes=Buffer.from(JSON.stringify(artifact));
  const pins={format:1,state:'bound',releaseId,uploadTag:releaseId+'-'+artifactTreeSha256.slice(0,12),sourceManifestSha256:sha256(sourceBytes),artifactManifestSha256:sha256(artifactBytes),sourceTreeSha256,artifactTreeSha256,approvedStateSha256:'a'.repeat(64),canonicalMigrationTreeSha256:'b'.repeat(64),canonicalBaselineMigrationTreeSha256:'d'.repeat(64),productionConfigSha256:'c'.repeat(64),targetConfigSha256:'e'.repeat(64)};
  return {source,artifact,sourceBytes,artifactBytes,pins};
}
test('tree identity uses explicit sorted path-NUL-size-NUL-hash-LF bytes',()=>{
  const a=record('a'),z=record('zz');
  const exact=Buffer.from('a\0'+a.bytes+'\0'+a.sha256+'\n'+'z\0'+z.bytes+'\0'+z.sha256+'\n');
  assert.equal(treeDigest({z,a}),sha256(exact));assert.notEqual(treeDigest({z,a}),treeDigest({z,a:{...a,bytes:2}}));
});
test('pending freeze rejects before accepting any carried-over release metadata',()=>{
  assert.throws(()=>validateManifestPair({format:1,state:'awaiting-final-build'},Buffer.from('{}'),Buffer.from('{}')),/RELEASE_NOT_FROZEN/);
});
test('valid metadata association is only structural consistency, not evidence of a real build',()=>{
  const b=bundle();assert.equal(validateManifestPair(b.pins,b.sourceBytes,b.artifactBytes).source.sourceTreeSha256,b.pins.sourceTreeSha256);
});
test('a claimed artifact tree digest is recomputed, not trusted as a label',()=>{
  const b=bundle();b.artifact.artifactTreeSha256='d'.repeat(64);const bytes=Buffer.from(JSON.stringify(b.artifact));b.pins.artifactManifestSha256=sha256(bytes);b.pins.artifactTreeSha256=b.artifact.artifactTreeSha256;
  assert.throws(()=>validateManifestPair(b.pins,b.sourceBytes,bytes),/ARTIFACT_TREE_MISMATCH/);
});
test('new artifacts cannot retain another source-manifest association',()=>{
  const b=bundle();b.artifact.sourceManifestSha256='d'.repeat(64);const bytes=Buffer.from(JSON.stringify(b.artifact));b.pins.artifactManifestSha256=sha256(bytes);
  assert.throws(()=>validateManifestPair(b.pins,b.sourceBytes,bytes),/BUILD_SOURCE_MANIFEST_MISMATCH/);
});
test('post-build source change invalidates the measured input/output association',()=>{
  const b=bundle();b.artifact.build.outputSourceTreeSha256='d'.repeat(64);const bytes=Buffer.from(JSON.stringify(b.artifact));b.pins.artifactManifestSha256=sha256(bytes);
  assert.throws(()=>validateManifestPair(b.pins,b.sourceBytes,bytes),/BUILD_SOURCE_ASSOCIATION_MISSING/);
});
test('old v8 tag cannot label the new architecture artifact',()=>{
  const b=bundle();b.pins.uploadTag='projektor-v8-authority-loss-20261012';assert.throws(()=>validateManifestPair(b.pins,b.sourceBytes,b.artifactBytes),/RELEASE_UPLOAD_TAG_MISMATCH/);
});
test('unsafe manifest paths are refused before filesystem reads',()=>{
  for(const path of ['../outside','/outside','a/../b','a\\b','a\nb'])assert.throws(()=>treeDigest({[path]:record('x')}),/UNSAFE_MANIFEST_PATH/);
});
test('new unlisted product module prevents an incomplete source inventory',async t=>{
  const root=await mkdtemp(resolve(tmpdir(),'projektor-manifest-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(resolve(root,'src'));await writeFile(resolve(root,'src/a.ts'),'a');await writeFile(resolve(root,'src/new.ts'),'new');
  await assert.rejects(verifySourceInventory(root,{'src/a.ts':record('a')}),/RELEASE_FILE_SET_CHANGED/);
});
test('architecture registry is included, while dependency/runtime roots are excluded',async t=>{
  const root=await mkdtemp(resolve(tmpdir(),'projektor-manifest-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(resolve(root,'architecture'));await writeFile(resolve(root,'architecture/registry.json'),'{}');
  for(const name of ['node_modules','.local','.wrangler','dist']){await mkdir(resolve(root,name));await writeFile(resolve(root,name,'ignored'),'runtime');}
  await verifySourceInventory(root,{'architecture/registry.json':record('{}')});
});
test('source symlink cannot point outside the reviewed candidate',async t=>{
  const root=await mkdtemp(resolve(tmpdir(),'projektor-manifest-'));t.after(()=>rm(root,{recursive:true,force:true}));await symlink('/unread-outside',resolve(root,'linked'));
  await assert.rejects(verifySourceInventory(root,{linked:record('x')}),/RELEASE_SYMLINK/);
});

test('release21 accepts the immutable applied17 baseline and rejects a forged replacement baseline pin',async()=>{
  const directory=new URL('../../migrations/',import.meta.url),records={};
  for(const name of await readdir(directory)){const bytes=await readFile(new URL(name,directory));records[name]={bytes:bytes.length,sha256:sha256(bytes)};}
  const pins={canonicalMigrationTreeSha256:treeDigest(records),canonicalBaselineMigrationTreeSha256:'0fdaa1e0f79957cdbf8f36ed0d490c59230a409893fa71a381fad14db7c81b71'};
  assert.equal(verifyMigrationInventory(records,pins).length,21);
  // A caller cannot re-pin an obsolete, extended, or noncontiguous inventory.
  const entries=Object.entries(records);
  for(const changed of [Object.fromEntries(entries.slice(0,19)),{...records,'0022_unreviewed.sql':record('extra')},Object.fromEntries(entries.map(([name,value])=>[name.startsWith('0020_')?'0021_duplicate.sql':name,value]))]){
    assert.throws(()=>verifyMigrationInventory(changed,{...pins,canonicalMigrationTreeSha256:treeDigest(changed)}),/MIGRATIONS_NOT_EXACT_RELEASE_21/);
  }
  records['0001_auth.sql']={bytes:1,sha256:sha256('x')};pins.canonicalMigrationTreeSha256=treeDigest(records);
  pins.canonicalBaselineMigrationTreeSha256=treeDigest(Object.fromEntries(Object.entries(records).filter(([p])=>Number(p.slice(0,4))<=17)));
  assert.throws(()=>verifyMigrationInventory(records,pins),/APPLIED_CANONICAL_17_CHANGED/);
});
