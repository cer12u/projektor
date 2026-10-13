// @module tooling.build
// @role verified-build
// Measured local build association. This never binds deployment approval or reads provider credentials.
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const sort=paths=>paths.sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
const excluded=new Set(['node_modules','.local','.wrangler','dist']);
async function inventory(directory,prefix='',skip=false){
 const records={};
 for(const entry of await readdir(directory,{withFileTypes:true})){
  if(skip&&!prefix&&excluded.has(entry.name))continue;
  const path=prefix+entry.name;
  if(entry.isSymbolicLink())throw Error('Source/artifact symlinks are not supported: '+path);
  if(entry.isDirectory())Object.assign(records,await inventory(resolve(directory,entry.name),path+'/',skip));
  else if(entry.isFile()){const bytes=await readFile(resolve(directory,entry.name));records[path]={bytes:bytes.length,sha256:hash(bytes)};}
  else throw Error('Unexpected filesystem object: '+path);
 }
 return Object.fromEntries(sort(Object.keys(records)).map(path=>[path,records[path]]));
}
const tree=records=>hash(Buffer.concat(Object.entries(records).map(([path,r])=>Buffer.from(path+'\0'+r.bytes+'\0'+r.sha256+'\n'))));
if(process.versions.node!=='24.19.0')throw Error('Use Node 24.19.0');
if(!process.env.npm_execpath)throw Error('Run through npm run build:verified');
const before=await inventory(root,'',true),startedAt=new Date().toISOString();
const exitCode=await new Promise((done,reject)=>{const child=spawn(process.execPath,[process.env.npm_execpath,'run','build'],{cwd:root,env:process.env,stdio:'inherit'});child.once('error',reject);child.once('exit',(code,signal)=>done(signal?1:code??1));});
if(exitCode!==0)throw Error('Build failed');
const after=await inventory(root,'',true),finishedAt=new Date().toISOString();
if(JSON.stringify(before)!==JSON.stringify(after))throw Error('Source changed during build; inspect changes and rerun deliberately');
const artifacts=await inventory(resolve(root,'dist')),sourceTreeSha256=tree(after),treeAlgorithm='sha256-path-null-size-null-hash-lf-v1';
const source={format:3,state:'frozen',releaseId:'local-verification',treeAlgorithm,sourceTreeSha256,files:after};
const sourceBytes=JSON.stringify(source,null,2)+'\n';
const manifest={format:3,state:'frozen',releaseId:'local-verification',scope:'Local measured build only; not deployment approval or bound release pins',treeAlgorithm,sourceManifestSha256:hash(sourceBytes),sourceTreeSha256,artifactTreeSha256:tree(artifacts),artifacts,build:{command:'npm run build',exitCode,startedAt,finishedAt,inputSourceTreeSha256:tree(before),outputSourceTreeSha256:tree(after)}};
const output=resolve(root,'.local/verification/release');await mkdir(output,{recursive:true});await mkdir(resolve(root,'.local/evidence'),{recursive:true});
await writeFile(resolve(output,'source-manifest.json'),sourceBytes);await writeFile(resolve(output,'artifact-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({sourceFiles:Object.keys(after).length,artifacts:Object.keys(artifacts).length,sourceTreeSha256,artifactTreeSha256:manifest.artifactTreeSha256}));
