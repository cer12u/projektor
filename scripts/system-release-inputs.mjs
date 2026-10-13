// @module repository.integration
// @role release-input-verification
import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const sort=keys=>keys.sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
const excluded=new Set(['node_modules','.local','.wrangler','dist']);
export async function inventory(directory,prefix='',source=false){const records={};for(const e of await readdir(directory,{withFileTypes:true})){if(source&&!prefix&&excluded.has(e.name))continue;const p=prefix+e.name;if(e.isDirectory())Object.assign(records,await inventory(resolve(directory,e.name),p+'/',source));else if(e.isFile()){const bytes=await readFile(resolve(directory,e.name));records[p]={bytes:bytes.length,sha256:hash(bytes)};}else throw Error('Nonregular release input: '+p);}return Object.fromEntries(sort(Object.keys(records)).map(p=>[p,records[p]]));}
export const treeDigest=records=>hash(Buffer.concat(Object.entries(records).sort(([a],[b])=>Buffer.compare(Buffer.from(a),Buffer.from(b))).map(([path,r])=>Buffer.from(path+'\0'+r.bytes+'\0'+r.sha256+'\n'))));
export async function verifyMeasuredInputs(app){
 const sourceBytes=await readFile(resolve(app,'.local/verification/release/source-manifest.json'));
 const source=JSON.parse(sourceBytes),manifest=JSON.parse(await readFile(resolve(app,'.local/verification/release/artifact-manifest.json')));
 if(source.format!==3||source.state!=='frozen'||manifest.format!==3||manifest.state!=='frozen'||manifest.build?.exitCode!==0||manifest.build.inputSourceTreeSha256!==source.sourceTreeSha256||manifest.build.outputSourceTreeSha256!==source.sourceTreeSha256||manifest.sourceTreeSha256!==source.sourceTreeSha256||manifest.sourceManifestSha256!==hash(sourceBytes))throw Error('Measured build association missing');
 const actualSource=await inventory(app,'',true),actualArtifacts=await inventory(resolve(app,'dist'));
 if(JSON.stringify(actualSource)!==JSON.stringify(source.files)||treeDigest(actualSource)!==source.sourceTreeSha256)throw Error('Source changed after measured build');
 if(JSON.stringify(actualArtifacts)!==JSON.stringify(manifest.artifacts)||treeDigest(actualArtifacts)!==manifest.artifactTreeSha256)throw Error('Artifact set changed after measured build');
 return manifest;
}

export async function verifyStagedInputs(stage, source, manifest){
 const stagedArtifacts={...Object.fromEntries(Object.entries(await inventory(resolve(stage,'worker'))).map(([p,r])=>['worker/'+p,r])),...Object.fromEntries(Object.entries(await inventory(resolve(stage,'web'))).map(([p,r])=>['web/'+p,r]))};
 const stagedMigrations=Object.fromEntries(Object.entries(await inventory(resolve(stage,'migrations'))).map(([p,r])=>['migrations/'+p,r]));
 const expectedMigrations=Object.fromEntries(Object.entries(source.files).filter(([p])=>p.startsWith('migrations/')));
 if(treeDigest(stagedArtifacts)!==manifest.artifactTreeSha256||JSON.stringify(Object.keys(stagedArtifacts).sort())!==JSON.stringify(Object.keys(manifest.artifacts).sort()))throw Error('Staged artifacts differ from measured build');
 if(treeDigest(stagedMigrations)!==treeDigest(expectedMigrations))throw Error('Staged migrations differ from measured source');
}
