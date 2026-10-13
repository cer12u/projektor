// @module verification
// @role architecture-regression
import assert from 'node:assert/strict';
import {validateArchitecture} from "../../scripts/architecture/registry.mjs";
import {parseImports, moduleTags} from "../../scripts/architecture/syntax.mjs";
import {validateBoundaries} from "../../scripts/architecture/boundaries.mjs";
import {inventory} from "../../scripts/architecture/inventory.mjs";
import {validateConfiguration} from "../../scripts/architecture/configuration.mjs";
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const module=(allowedDependencies=[])=>({kind:'tooling',responsibility:'Synthetic test owner',reviewStatus:'owner-reviewed',allowedDependencies,allowedPackages:['node:*']});
const base={format:2,interfaces:[{path:'candidate/b.ts',module:'b',kind:'public',exports:['b']}],modules:{a:module(['b']),b:module([])},files:[{path:'candidate/a.ts',module:'a',role:'implementation',kind:'authored'},{path:'candidate/b.ts',module:'b',role:'public-contract',kind:'authored'}],packages:{}};
const entries=base.files.map(file=>({path:file.path,sha256:'fake',bytes:0}));
const texts=new Map([['candidate/a.ts','// @module a\n// @role implementation\nimport {b} from "./b";'],['candidate/b.ts','// @module b\n// @role public-contract\nexport const b=1;']]);
const run=(registry=base,source=texts,actual=entries)=>validateArchitecture(registry,actual,source);
let checks=0;
function expect(code,registry,source,actual){assert(run(registry,source,actual).errors.some(error=>error.code===code),code);checks++;}
assert(run().passed);checks++;
expect('missing-tag',base,new Map([...texts,['candidate/a.ts','export const a=1;']]));
expect('duplicate-tag',base,new Map([...texts,['candidate/a.ts','// @module a\n// @role implementation\n// @module a\n// @role implementation\nexport const a=1;']]));
expect('unknown-tag',base,new Map([...texts,['candidate/a.ts','// @module absent\nexport const a=1;']]));
expect('unregistered-file',base,texts,[...entries,{path:'candidate/extra.json',bytes:2,sha256:'fake'}]);
expect('forbidden-module-import',{...base,modules:{...base.modules,a:module([])}});
expect('runtime-file-cycle',{...base,modules:{a:module(['b']),b:module(['a'])}},new Map([...texts,['candidate/b.ts','// @module b\n// @role implementation\nimport "./a";']]));
expect('runtime-file-cycle',{...base,modules:{a:module(['b']),b:module(['a'])}},new Map([...texts,['candidate/b.ts','// @module b\n// @role implementation\nimport "./a";']]));
expect('unmapped-dynamic-import',base,new Map([...texts,['candidate/a.ts','// @module a\n// @role implementation\nawait import(selectedPath);']]));
expect('forbidden-package-import',base,new Map([...texts,['candidate/a.ts','// @module a\n// @role implementation\nimport "unapproved-package";']]));
expect('unresolved-import',base,new Map([...texts,['candidate/a.ts','// @module a\n// @role implementation\nimport "./missing";']]));
expect('immutable-bytes-changed',{...base,files:[{...base.files[0],kind:'historical',immutableSha256:'other',reason:'Synthetic historical file'},base.files[1]]});
expect('executable-misclassified-as-data',{...base,files:[{...base.files[0],kind:'documentation'},base.files[1]]});
expect('missing-generated-ownership',{...base,files:[{...base.files[0],kind:'generated',reason:'Synthetic generated file'},base.files[1]]});
assert.deepEqual(moduleTags('/* @module web.styles */','css'),['web.styles']);checks++;
assert.deepEqual(moduleTags('<!-- @module config.entry -->','html'),['config.entry']);checks++;
const parsed=parseImports('x.ts','import type {T} from "./types"; export {value} from "./impl"; await import("./late"); require("node:fs");');
assert.equal(parsed.imports.length,4);assert.equal(parsed.imports[0].typeOnly,true);checks++;
assert.deepEqual(moduleTags('const fake=`\n// @module spoofed\n`;','slash'),[]);checks++;
assert.deepEqual(moduleTags('// @module real\nconst fake=`\n// @module spoofed\n`;','slash'),['real']);checks++;
for(const [owner,role,source,code] of [
 ['workbench','controller','const view=<div/>;','controller-renders-jsx'],
 ['workbench','view','import {useState as state} from "react"; state(0);','view-stateful-hook'],
 ['workbench','view','const load=()=>fetch("/api");','view-performs-request'],
 ['workbench','controller','fetch("/api");','fetch-outside-browser-transport'],
 ['composition','server-composition','db.prepare("SELECT 1");','composition-implements-persistence'],
 ['composition','server-composition','const d=env.DB; d.prepare("SELECT 1");','composition-implements-persistence'],
 ['workbench','view','const onClick=()=>sessionStorage.removeItem("draft");','view-performs-browser-effect'],
 ['release-control','deployment-entry','JSON.parse(input);','composition-parses-input'],
 ['composition','server-composition','request.headers.get("Authorization");','composition-parses-credentials'],
]){const file={path:'candidate/example.tsx',module:owner,role,kind:'authored'};assert(validateBoundaries({files:[file]},new Map([[file.path,source]])).errors.some(error=>error.code===code),code);checks++;}
function boundaryPass(module,role,source){const file={path:'candidate/example.tsx',module,role,kind:'authored'};assert.equal(validateBoundaries({files:[file]},new Map([[file.path,source]])).errors.length,0);checks++;}
boundaryPass('workbench','view','const View=({onSave})=><button onClick={()=>onSave()}/>;');
boundaryPass('composition','server-composition','operations.prepare(command);');
boundaryPass('browser-session','browser-transport','fetch("/api");');
expect('private-cross-module-import',{...base,interfaces:[]});
expect('private-cross-module-import',{...base,interfaces:[]},new Map([...texts,['candidate/a.ts','// @module a\n// @role implementation\nimport type {b} from "./b";']]));
expect('unapproved-interface-import',{...base,interfaces:[{path:'candidate/b.ts',module:'b',kind:'test',exports:[],consumers:[{module:'a',paths:['candidate/a.ts']}]}]});
expect('missing-role-tag',base,new Map([...texts,['candidate/a.ts','// @module a\nimport {b} from "./b";']]));
expect('duplicate-role-tag',base,new Map([...texts,['candidate/a.ts','// @module a\n// @role implementation\n// @role implementation\nimport {b} from "./b";']]));
expect('role-tag-mismatch',base,new Map([...texts,['candidate/a.ts','// @module a\n// @role other\nimport {b} from "./b";']]));
expect('wildcard-public-export',base,new Map([...texts,['candidate/b.ts','// @module b\n// @role implementation\nexport * from "./a";']]));
expect('undeclared-public-export',base,new Map([...texts,['candidate/b.ts',texts.get('candidate/b.ts')+'\nexport const extra=2;']]));
expect('private-cross-module-import',{...base,interfaces:[{path:'candidate/b.ts',module:'b',kind:'assembly',exports:['b'],consumers:[{module:'a',roles:['implementation']}]}]});
expect('restricted-interface-consumers-not-exact',{...base,interfaces:[{path:'candidate/b.ts',module:'b',kind:'transaction',exports:['b'],consumers:[{module:'a'}]}]});
expect('private-cross-module-import',{...base,interfaces:[{path:'candidate/b.ts',module:'b',kind:'transaction',exports:['b'],consumers:[{module:'a',roles:['d1-private']}]}]});
expect('test-spi-consumers-not-exact',{...base,interfaces:[{path:'candidate/b.ts',module:'b',kind:'test',exports:['b'],consumers:[{module:'a'}]}]});
expect('private-cross-module-import',{...base,interfaces:[{path:'candidate/b.ts',module:'b',kind:'test',exports:['b'],consumers:[{module:'a',paths:['candidate/other-test.ts']}]}]});
for(const surface of [
 {kind:'transaction',consumers:[{module:'a',roles:['implementation']}]},
 {kind:'test',consumers:[{module:'a',paths:['candidate/a.ts']}]},
]){assert(run({...base,interfaces:[{path:'candidate/b.ts',module:'b',exports:['b'],...surface}]}).passed);checks++;}
const composed={...base,modules:{composition:module(['b']),b:module()},files:[{...base.files[0],module:'composition',role:'server-composition'},base.files[1]],interfaces:[{path:'candidate/b.ts',module:'b',kind:'assembly',exports:['b'],consumers:[{module:'composition',roles:['server-composition']}]}]};
assert(run(composed,new Map([...texts,['candidate/a.ts','// @module composition\n// @role server-composition\nimport {b} from "./b";']])).passed);checks++;
// A namespace import cannot expand a narrow test SPI, and type-only aliases obey ownership too.
const subset={...base,interfaces:[{path:'candidate/b.ts',module:'b',kind:'test',exports:['b'],consumers:[{module:'a',paths:['candidate/a.ts']}]}]};
expect('unapproved-interface-import',subset,new Map([...texts,['candidate/a.ts','// @module a\n// @role implementation\nimport * as other from "./b";'],['candidate/b.ts',texts.get('candidate/b.ts')+'\nexport const privateValue=2;']]));
expect('private-cross-module-import',{...base,interfaces:[]},new Map([...texts,['candidate/a.ts','// @module a\n// @role implementation\nimport type Other = require("./b");']]));
assert.equal(parseImports('alias.ts','import type Other = require("./b");').imports[0].typeOnly,true);checks++;
const publicCycle={...base,modules:{a:module(['b']),b:module(['a'])},interfaces:[...base.interfaces,{path:'candidate/a.ts',module:'a',kind:'public',exports:['a']}]};
expect('public-owner-cycle',publicCycle,new Map([...texts,['candidate/a.ts',texts.get('candidate/a.ts')+'\nexport const a=1;'],['candidate/b.ts','// @module b\n// @role implementation\nimport {a} from "./a"; export const b=1;']]));
const privateSubset={...base,files:[base.files[0],{...base.files[1],role:'private-policy'}],interfaces:[{path:'candidate/b.ts',module:'b',kind:'public',exports:['b'],consumers:[{module:'a'}]}]};
const privateSubsetTexts=new Map([...texts,['candidate/b.ts','// @module b\n// @role private-policy\nexport const b=1; export const hidden=2;']]);
assert(run(privateSubset,privateSubsetTexts).passed);checks++;
expect('unapproved-interface-import',privateSubset,new Map([...privateSubsetTexts,['candidate/a.ts','// @module a\n// @role implementation\nimport * as policy from "./b";']]));
expect('unapproved-interface-import',privateSubset,new Map([...privateSubsetTexts,['candidate/a.ts','// @module a\n// @role implementation\nexport {hidden} from "./b";']]));
expect('unapproved-interface-import',privateSubset,new Map([...privateSubsetTexts,['candidate/a.ts','// @module a\n// @role implementation\nimport type {hidden} from "./b";']]));
expect('unapproved-interface-import',privateSubset,new Map([...privateSubsetTexts,['candidate/a.ts','// @module a\n// @role implementation\nimport {hidden} from "./b";']]));
// Defect hypothesis: sharing an owner currently lets an application import its own D1 adapter.
const pureApplication={path:'src/modules/execution/application.ts',module:'execution',role:'application',kind:'authored'};
const d1Adapter={path:'src/adapters/d1/execution/adapter.ts',module:'execution',role:'d1-adapter',kind:'authored'};
const executionPorts={path:'src/modules/execution/ports.ts',module:'execution',role:'persistence-contract',kind:'authored'};
const pureRegistry={modules:{execution:{kind:'business'}},files:[pureApplication,d1Adapter,executionPorts]};
for(const declaration of ['import {bindD1} from "../../adapters/d1/execution/adapter";','import type {D1Port} from "../../adapters/d1/execution/adapter";']){
 const result=validateBoundaries(pureRegistry,new Map([[pureApplication.path,declaration]]));
 assert(result.errors.some(error=>error.code==='pure-code-imports-concrete-adapter'&&error.target===d1Adapter.path));checks++;
}
assert.equal(validateBoundaries(pureRegistry,new Map([[pureApplication.path,'import type {ExecutionStore} from "./ports";']])).errors.length,0);checks++;
assert.equal(validateBoundaries(pureRegistry,new Map([[d1Adapter.path,'import type {ExecutionStore} from "../../../modules/execution/ports";']])).errors.length,0);checks++;
// Defect hypothesis: a declared computed dependency bypasses same-owner pure-to-adapter checks.
for(const expression of ['await import(target);','require(target);']){
 const mapped={...pureApplication,dynamicDependencies:[{expression:'target',specifiers:['../../adapters/d1/execution/adapter'],reason:'Exact synthetic negative-control target.'}]};
 const registry={...pureRegistry,files:[mapped,d1Adapter,executionPorts]};
 const result=validateBoundaries(registry,new Map([[mapped.path,"const target='../../adapters/d1/execution/adapter';"+expression]]));
 assert(result.errors.some(error=>error.code==='pure-code-imports-concrete-adapter'&&error.target===d1Adapter.path));checks++;
}
// Actual assembly roles must delegate rather than hide persistence/input parsing.
for(const role of ['assembly','composition-entry']){
 const file={path:'src/adapters/d1/example/assembly.ts',module:'example',role,kind:'authored'};
 for(const [text,code]of [['db.prepare(sql);','composition-implements-persistence'],['JSON.parse(input);','composition-parses-input']]){
  assert(validateBoundaries({files:[file]},new Map([[file.path,text]])).errors.some(error=>error.code===code));checks++;
 }
 assert.equal(validateBoundaries({files:[file]},new Map([[file.path,'return createApplication(createAdapter(db));']])).errors.length,0);checks++;
}
// Repository-relative root configs must receive the same validation as nested configs.
const rootConfig={packages:{},thirdPartyPackages:[]};
const configFiles=[{path:'package.json'},{path:'package-lock.json'},{path:'tsconfig.json'}];
const configSources=new Map([['package.json',JSON.stringify({scripts:{verify:'node absent.mjs'},dependencies:{unregistered:'1.0.0'}})],['package-lock.json',JSON.stringify({packages:{'node_modules/extra':{version:'1.0.0'}}})],['tsconfig.json',JSON.stringify({extends:'./missing-base.json',compilerOptions:{types:['./missing-types.d.ts']}})]]);
const rootErrors=validateConfiguration(rootConfig,configSources,configFiles).errors;
for(const code of ['missing-config-source','dependency-version-mismatch','incomplete-lockfile-ownership']){assert(rootErrors.some(error=>error.code===code));checks++;}
assert(rootErrors.some(error=>error.kind==='typescript-base'));checks++;
assert(rootErrors.some(error=>error.kind==='typescript-local-types'));checks++;
// Defect hypothesis: a new hashed bundle is mistaken for new authored policy, or excluded without an inventory.
const inventoryRoot=await mkdtemp(join(tmpdir(),'projektor-ownership-'));
try{
 await mkdir(join(inventoryRoot,'src'));await mkdir(join(inventoryRoot,'dist/web'),{recursive:true});
 await writeFile(join(inventoryRoot,'src/main.ts'),'export const value=1;');
 await writeFile(join(inventoryRoot,'dist/web/index-a.js'),'a');
 const generated=[{path:'dist',kind:'generated',module:'build',generatedBy:['src/main.ts'],reason:'Synthetic deterministic build ownership.'}];
 const first=await inventory(inventoryRoot,['.'],generated);
 assert.deepEqual(first.files.map(f=>f.path),['src/main.ts']);assert.equal(first.generatedFiles.length,1);assert.equal(first.generatedFiles[0].generatedTree,'dist');checks++;
 await writeFile(join(inventoryRoot,'dist/web/index-b.js'),'b');
 const second=await inventory(inventoryRoot,['.'],generated);
 assert.deepEqual(second.files,first.files);assert.equal(second.generatedFiles.length,2);checks++;
 await writeFile(join(inventoryRoot,'src/unregistered.ts'),'export const other=2;');
 const third=await inventory(inventoryRoot,['.'],generated);
 assert(third.files.some(f=>f.path==='src/unregistered.ts'));checks++;
}finally{await rm(inventoryRoot,{recursive:true,force:true});}
console.log(JSON.stringify({passed:true,checks,scope:'Local architecture-checker regression assertions; no product or live-provider claim'}));
