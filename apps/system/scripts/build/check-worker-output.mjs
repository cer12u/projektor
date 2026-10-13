// @module tooling.build
// @role integrity
// Fail packaging if generated modules differ from the entrypoint's exact imports.
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root=new URL("../../",import.meta.url),out=new URL('dist/worker/',root);
const entry=await readFile(new URL('index.js',out),'utf8');
const imports=[...entry.matchAll(/from ["']\.\/([^"']+\.wasm)["']/g)].map(m=>m[1]);
assert.equal(imports.length,2,'Worker must import exactly the two static WASM modules');
const modules=[];
for(const name of ['argon2','blake2b']){
 const source=await readFile(new URL(`src/adapters/crypto/generated/${name}.wasm`,root));
 const expected=createHash('sha1').update(source).digest('hex')+`-${name}.wasm`;
 assert(imports.includes(expected),`Missing exact content-addressed ${name} import`);
 const actual=await readFile(new URL(expected,out));assert.deepEqual(actual,source);
 modules.push({name:expected,bytes:actual.length,sha256:createHash('sha256').update(actual).digest('hex')});
}
const expected=['index.js','index.js.map','README.md',...imports].sort();
assert.deepEqual((await readdir(out)).sort(),expected,'Stale or unreferenced Worker output');
console.log(JSON.stringify({passed:true,entrypoint:'index.js',modules,files:expected}));
