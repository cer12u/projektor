// @module tooling.architecture
// @role configuration
import ts from 'typescript';
import {posix} from 'node:path';

/** Validate source entrypoints and declared package ownership without executing configs. */
export function validateConfiguration(registry, sources, files, generatedFiles = []) {
  const errors=[], references=[], packages=[], pendingBuildOutputs=[];
  const byPath=new Set([...files,...generatedFiles].map(file=>file.path));
  function reference(from,to,kind){
    const path=posix.normalize(posix.join(posix.dirname(from),to));
    references.push({from,to:path,kind});
    if(!byPath.has(path)){
      const output=(registry.plannedBuildOutputs||[]).find(item=>item.path===path);
      if(output&&byPath.has(output.producer)&&output.reason&&registry.phase!=='frozen') pendingBuildOutputs.push({from,...output});
      else errors.push({code:'missing-config-source',path:from,target:path,kind});
    }
  }
  for(const file of files){
    if(!file.path.endsWith('.json')&&!file.path.endsWith('.jsonc')) continue;
    const source=sources.get(file.path);
    if(!source) continue;
    const parsed=ts.parseConfigFileTextToJson(file.path,source);
    if(parsed.error){errors.push({code:'invalid-json-configuration',path:file.path});continue;}
    const config=parsed.config;
    if(posix.basename(file.path)==='package.json'){
      for(const [name,command] of Object.entries(config.scripts||{})){
        for(const match of command.matchAll(/\bnode\s+(?:--\S+\s+)*([^\s;&|]+)/g)) reference(file.path,match[1],`npm-script:${name}`);
      }
      for(const section of ['dependencies','devDependencies']) for(const [name,version] of Object.entries(config[section]||{})){
        packages.push({name,version,section});
        if(registry.packages[name]?.version!==version) errors.push({code:'dependency-version-mismatch',path:file.path,name,expected:version,registered:registry.packages[name]?.version});
      }
    }
    if(posix.basename(file.path)==='package-lock.json'){
      const declared=registry.thirdPartyPackages||[];
      const expected=Object.entries(config.packages||{}).filter(([path])=>path).map(([path,pkg])=>({path,version:pkg.version,resolved:pkg.resolved||null,integrity:pkg.integrity||null}));
      if(JSON.stringify(declared)!==JSON.stringify(expected)) errors.push({code:'incomplete-lockfile-ownership',path:file.path,actual:expected.length,registered:declared.length});
    }
    if(file.path.endsWith('.jsonc')&&config.main) reference(file.path,config.main,'worker-entry');
    if(posix.basename(file.path).startsWith('tsconfig')&&config.extends&&config.extends.startsWith('.')) reference(file.path,config.extends,'typescript-base');
    if(posix.basename(file.path).startsWith('tsconfig')) for(const type of config.compilerOptions?.types||[]) if(type.startsWith('.')) reference(file.path,type,'typescript-local-types');
  }
  return {errors,references,packages,pendingBuildOutputs};
}
