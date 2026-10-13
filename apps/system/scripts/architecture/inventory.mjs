// @module tooling.architecture
// @role inventory
import {readdir, readFile, lstat} from 'node:fs/promises';
import {join, relative} from 'node:path';
import {createHash} from 'node:crypto';

/** Source inventory and separately observed generated artifacts; neither grants import permission. */
export async function inventory(root, scopes, classifications = []) {
  const files = [], generatedFiles = [], classifiedTrees = [];
  const declared = new Map(classifications.map(item => [item.path, item]));
  async function record(path, key, destination, generatedTree) {
    const bytes = await readFile(path);
    destination.push({path:key,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),...(generatedTree?{generatedTree}:{} )});
  }
  async function walkGenerated(path, key, tree) {
    const stat=await lstat(path);
    if(stat.isSymbolicLink())throw new Error(`Generated artifact symlink: ${key}`);
    if(stat.isDirectory())for(const child of (await readdir(path)).sort())await walkGenerated(join(path,child),key+'/'+child,tree);
    else if(stat.isFile())await record(path,key,generatedFiles,tree);
    else throw new Error(`Unclassified generated object: ${key}`);
  }
  async function walk(path) {
    const key = relative(root, path).replaceAll('\\', '/');
    const stat = await lstat(path), tree=declared.get(key);
    if (tree) {
      const item={path:key,kind:tree.kind||'classified-runtime',symbolicLink:stat.isSymbolicLink()};
      if(tree.kind==='generated'){
        const before=generatedFiles.length;await walkGenerated(path,key,key);item.files=generatedFiles.length-before;
      }
      classifiedTrees.push(item);return;
    }
    if (stat.isSymbolicLink()) throw new Error(`Unclassified symlink: ${key}`);
    if (stat.isDirectory()) {
      for (const child of (await readdir(path)).sort()) await walk(join(path, child));
    } else if (stat.isFile()) await record(path,key,files);
    else throw new Error(`Unclassified filesystem object: ${key}`);
  }
  for (const scope of scopes) await walk(join(root, scope));
  return {files,generatedFiles,classifiedTrees};
}
