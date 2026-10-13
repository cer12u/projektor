// @module tooling.architecture
// @role source-snapshot
// Exhaustive release-source identity, separate from generated dist and runtime state.
import {readFile,readdir,lstat,writeFile} from 'node:fs/promises';
import {resolve,relative,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const here=dirname(fileURLToPath(import.meta.url));
const root=resolve(here,basename(dirname(here))==='scripts'?'../..':'..');
const excludedRoots=new Set(['dist','node_modules','.local','.wrangler']);
const records=[];
async function visit(path){
 const name=relative(root,path).replaceAll('\\','/');
 if(excludedRoots.has(name.split('/')[0]))return;
 const stat=await lstat(path);
 if(stat.isSymbolicLink())throw new Error('Unexpected source symlink: '+name);
 if(stat.isDirectory()){for(const item of await readdir(path))await visit(resolve(path,item));return;}
 if(!stat.isFile()||/[\0\r\n]/.test(name))throw new Error('Invalid source member: '+name);
 const bytes=await readFile(path);records.push([name,{bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]);
}
await visit(root);
records.sort(([a],[b])=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
const rows=records.map(([name,value])=>`${name}\0${value.bytes}\0${value.sha256}\n`).join('');
const result={format:3,state:'captured',releaseId:'projektor-modular-candidate-20261012',treeAlgorithm:'sha256-path-null-size-null-hash-lf-v1',sourceTreeSha256:createHash('sha256').update(rows).digest('hex'),files:Object.fromEntries(records)};
const json=JSON.stringify(result,null,2)+'\n';
if(process.argv[2])await writeFile(resolve(process.argv[2]),json);else process.stdout.write(json);
