// @module verification
// @role identity-contract-purity
// Type-only dependencies must not pull Identity's application contracts into a D1 adapter.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,resolve,relative} from 'node:path';
import {createHash} from 'node:crypto';
import ts from 'typescript';
import {parseImports} from '../../scripts/architecture/imports.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const roots=['src/modules/identity/public.ts','src/modules/identity/application.ts','src/modules/identity/ports.ts','src/modules/identity/operator-application.ts','src/modules/identity/operator-contracts.ts'];
const sources=new Map();
async function closure(overrides=new Map()){
 const seen=new Set(),errors=[];
 async function visit(file){
  if(seen.has(file))return;seen.add(file);
  const path=relative(root,file).replaceAll('\\','/');
  if(!path.startsWith('src/modules/')){errors.push({path,reason:'concrete dependency outside provider-independent modules'});return;}
  const source=overrides.get(path)??await readFile(file,'utf8');sources.set(path,source);
  const parsed=parseImports(path,source);assert.deepEqual(parsed.parseErrors,[]);assert.deepEqual(parsed.dynamic,[]);
  for(const edge of parsed.imports){
   assert(edge.specifier.startsWith('.'),'pure Identity imports no platform package: '+edge.specifier);
   const resolved=ts.resolveModuleName(edge.specifier,file,{moduleResolution:ts.ModuleResolutionKind.Bundler},ts.sys).resolvedModule;
   assert(resolved,'unresolved dependency '+path+' -> '+edge.specifier);
   await visit(resolve(dirname(file),relative(dirname(file),resolved.resolvedFileName)));
  }
 }
 for(const entry of roots)await visit(resolve(root,entry));
 return {files:[...seen].map(file=>relative(root,file).replaceAll('\\','/')).sort(),errors};
}
const actual=await closure();assert.deepEqual(actual.errors,[]);
const source=sources.get(roots[0]);
const negative=await closure(new Map([[roots[0],source+'\nimport type {Json} from "../../adapters/d1/persistence/public";\n']]));
assert(negative.errors.some(error=>error.path==='src/adapters/d1/persistence/public.ts'),'negative control detects original type-only D1 dependency');
await mkdir(resolve(root,'.local/evidence'),{recursive:true});
const report={passed:true,scope:'actual Identity application/public/ports transitive imports including type-only imports',files:actual.files,negativeControl:negative.errors,sourceHashes:Object.fromEntries(await Promise.all(actual.files.map(async file=>[file,createHash('sha256').update(await readFile(resolve(root,file))).digest('hex')])))};
await writeFile(resolve(root,'.local/evidence/identity-contract-purity.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
