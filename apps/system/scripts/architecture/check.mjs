// @module tooling.architecture
// @role check
import {readFile, writeFile} from 'node:fs/promises';
import {resolve, dirname, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {inventory} from './inventory.mjs';
import {validateArchitecture} from './registry.mjs';
import {validateConfiguration} from './configuration.mjs';
import {validateBoundaries} from './boundaries.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const repositoryRoot=resolve(here,basename(dirname(here))==='scripts'?'../..':'..');
const registry=JSON.parse(await readFile(resolve(repositoryRoot,'architecture/module-registry.json'),'utf8'));
const root=registry.pathBase==='repository'?repositoryRoot:dirname(repositoryRoot);
const scanned=await inventory(root,registry.scopes,[...registry.dependencyInstallations,...(registry.runtimeStateDirectories||[]),...(registry.generatedTrees||[])]);
const readback=await Promise.all(scanned.files.map(async file=>{const bytes=await readFile(resolve(root,file.path));return {path:file.path,source:bytes.toString('utf8'),sha256:createHash('sha256').update(bytes).digest('hex')};}));
const sources=new Map(readback.map(file=>[file.path,file.source]));
const result=validateArchitecture(registry,scanned.files,sources);
result.checkedFiles=scanned.files;
for(const file of readback)if(file.sha256!==scanned.files.find(item=>item.path===file.path).sha256)result.errors.push({code:'file-changed-during-check',path:file.path});
const configuration=validateConfiguration(registry,sources,scanned.files,scanned.generatedFiles);
const boundaries=validateBoundaries(registry,sources);
result.errors.push(...configuration.errors,...boundaries.errors);
result.semanticBoundaries=boundaries;
result.passed=result.errors.length===0;
result.configuration=configuration;
result.classifiedTrees=scanned.classifiedTrees;
result.observedGeneratedFiles=scanned.generatedFiles;
const invalidTags=new Set(result.errors.filter(error=>['missing-tag','duplicate-tag','unknown-tag','tag-owner-mismatch','missing-role-tag','duplicate-role-tag','role-tag-mismatch'].includes(error.code)).map(error=>error.path));
result.counts={files:scanned.files.length,modules:Object.keys(registry.modules).length,byKind:registry.files.reduce((counts,file)=>(counts[file.kind]=(counts[file.kind]||0)+1,counts),{}),immutable:registry.files.filter(file=>file.immutableSha256).length,taggedAuthored:registry.files.filter(file=>file.kind==='authored'&&!invalidTags.has(file.path)).length,declaredInterfaces:registry.interfaces.length,lockedThirdPartyPackages:registry.thirdPartyPackages.length,violations:result.errors.length};
result.scope='Static ownership, named public/private interfaces, tags and configured role rules only. Responsibility and business correctness also require source review and runtime evidence. No product acceptance claim.';
const output=process.argv[2];
if(output) await writeFile(resolve(output),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({passed:result.passed,files:result.actualFiles,imports:result.edges.length,errors:result.errors.length,errorCounts:result.errors.reduce((out,error)=>(out[error.code]=(out[error.code]||0)+1,out),{})},null,2));
if(!result.passed) process.exitCode=1;
