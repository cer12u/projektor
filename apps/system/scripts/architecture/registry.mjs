// @module tooling.architecture
// @role registry
import {moduleTags, tagStyle, parseImports, classifySpecifier, resolveImport} from './syntax.mjs';
import {cycles} from './graph.mjs';
import {permitsInterface, validatePublicInterfaces, exportedNames} from './interfaces.mjs';
import ts from 'typescript';

/** Validate declared ownership and actual import directions; never infer permission from usage. */
export function validateArchitecture(registry, entries, sources) {
  const errors = [], edges = [], externalDependencies = [], dynamicEvidence = [];
  const byPath = new Map(), actual = new Map(entries.map(file => [file.path, file]));
  const modules = registry.modules;
  if(registry.format!==2)errors.push({code:'unsupported-registry-format',expected:2});
  for (const file of registry.files) {
    if (byPath.has(file.path)) errors.push({code:'duplicate-file',path:file.path});
    byPath.set(file.path,file);
    if (!modules[file.module]) errors.push({code:'unknown-module',path:file.path,module:file.module});
  }
  for(const tree of registry.generatedTrees||[]){
    if(tree.kind!=='generated'||!tree.reason||!tree.generatedBy?.length||!modules[tree.module])errors.push({code:'invalid-generated-tree-ownership',path:tree.path});
    for(const producer of tree.generatedBy||[])if(!byPath.has(producer))errors.push({code:'unknown-generated-input',path:tree.path,sourcePath:producer});
  }
  for (const [id,module] of Object.entries(modules)) {
    if (module.reviewStatus !== 'owner-reviewed') errors.push({code:'unreviewed-module',module:id});
    if (!module.kind || !module.responsibility || !Array.isArray(module.allowedDependencies) || !Array.isArray(module.allowedPackages)) errors.push({code:'invalid-module',module:id});
    for (const target of module.allowedDependencies || []) if (!modules[target]) errors.push({code:'unknown-allowed-module',module:id,target});
  }
  for (const path of actual.keys()) if (!byPath.has(path)) errors.push({code:'unregistered-file',path});
  for (const file of registry.files) {
    if (!actual.has(file.path)) { errors.push({code:'missing-file',path:file.path}); continue; }
    const source = sources.get(file.path) || '', module = modules[file.module];
    if (!module) continue;
    if (!file.role) errors.push({code:'missing-file-role',path:file.path});
    if (file.kind === 'authored') {
      const style = tagStyle(file.path), tags = moduleTags(source,style);
      if (!style) errors.push({code:'authored-no-tag-syntax',path:file.path});
      if (tags.length !== 1) errors.push({code:tags.length ? 'duplicate-tag' : 'missing-tag',path:file.path,tags});
      else if (!modules[tags[0]]) errors.push({code:'unknown-tag',path:file.path,tag:tags[0]});
      else if (tags[0] !== file.module) errors.push({code:'tag-owner-mismatch',path:file.path,tag:tags[0],expected:file.module});
      const roles=moduleTags(source,style,'role');
      if(roles.length!==1)errors.push({code:roles.length?'duplicate-role-tag':'missing-role-tag',path:file.path,roles});
      else if(roles[0]!==file.role)errors.push({code:'role-tag-mismatch',path:file.path,role:roles[0],expected:file.role});
    } else if (!['data','documentation','historical','vendor','generated','binary'].includes(file.kind)) errors.push({code:'unknown-file-kind',path:file.path,kind:file.kind});
    if (['data','documentation'].includes(file.kind) && tagStyle(file.path) && !file.path.endsWith('.jsonc')) errors.push({code:'executable-misclassified-as-data',path:file.path});
    if (['historical','vendor','binary'].includes(file.kind) || file.immutableSha256) {
      if (!file.immutableSha256 || file.immutableSha256 !== actual.get(file.path).sha256) errors.push({code:'immutable-bytes-changed',path:file.path});
    }
    if (file.kind === 'generated' && !file.generatedFrom?.length) errors.push({code:'missing-generated-ownership',path:file.path});
    for (const sourcePath of file.generatedFrom || []) if (!byPath.has(sourcePath)) errors.push({code:'unknown-generated-input',path:file.path,sourcePath});
    if (['historical','vendor','generated','binary'].includes(file.kind) && !file.reason) errors.push({code:'missing-ownership-reason',path:file.path});
    const parsed = parseImports(file.path, source);
    for (const message of parsed.parseErrors || []) errors.push({code:'syntax-error',path:file.path,message});
    const imports = [...parsed.imports];
    const seenDynamic = new Set();
    for (const item of parsed.dynamic) {
      const declared = (file.dynamicDependencies || []).find(d => d.expression === item.expression);
      if (!declared?.reason || !declared.specifiers?.length) { errors.push({code:'unmapped-dynamic-import',path:file.path,...item}); continue; }
      seenDynamic.add(item.expression); dynamicEvidence.push({path:file.path,...declared});
      for (const specifier of declared.specifiers) imports.push({...item,...(typeof specifier==='string'?{specifier}:specifier),typeOnly:false});
    }
    for (const declared of file.dynamicDependencies || []) if (!seenDynamic.has(declared.expression)) errors.push({code:'stale-dynamic-mapping',path:file.path,expression:declared.expression});
    for (const item of imports) {
      const kind = classifySpecifier(item.specifier);
      if (kind.kind === 'relative') {
        const target = resolveImport(file.path,item.specifier,byPath);
        if (!target) {
          const generated = (file.generatedImports || []).find(d => d.specifier === item.specifier);
          if (generated?.producer && byPath.has(generated.producer) && generated.reason && generated.specifiers?.length) { dynamicEvidence.push({path:file.path,generatedImport:generated}); for(const specifier of generated.specifiers) imports.push({...item,...(typeof specifier==='string'?{specifier}:specifier)}); continue; }
          errors.push({code:'unresolved-import',path:file.path,...item}); continue;
        }
        const targetModule = byPath.get(target).module;
        const edge={from:file.path,to:target,fromModule:file.module,toModule:targetModule,fromRole:file.role,toRole:byPath.get(target).role,typeOnly:item.typeOnly,specifier:item.specifier};
        edges.push(edge);
        if (targetModule !== file.module) {
          if(!module.allowedDependencies.includes(targetModule))errors.push({code:'forbidden-module-import',path:file.path,target,fromModule:file.module,toModule:targetModule});
          const surfaces=(registry.interfaces||[]).filter(entry=>entry.path===target&&permitsInterface(entry,file));
          edge.interfaces=surfaces.map(entry=>entry.kind);
          if(!surfaces.length)errors.push({code:'private-cross-module-import',path:file.path,target,typeOnly:item.typeOnly});
          else {
            const names=item.names||[];
            const namespace=names.includes('*')||(!names.length&&['dynamic-import','require','require-resolve'].includes(item.kind));
            const actualExports=namespace?exportedNames(ts.createSourceFile(target,sources.get(target)||'',ts.ScriptTarget.Latest,true)):null;
            const allowed=surfaces.some(entry=>namespace?!actualExports.wildcards.length&&actualExports.names.every(name=>entry.exports.includes(name)):names.length?names.every(name=>entry.exports.includes(name)):entry.allowSideEffects===true);
            if(!allowed)errors.push({code:'unapproved-interface-import',path:file.path,target,names,kind:item.kind});
          }
        }
      } else if (kind.kind === 'external-location') errors.push({code:'unclassified-external-import',path:file.path,...item});
      else {
        externalDependencies.push({path:file.path,...kind,specifier:item.specifier});
        const permitted = module.allowedPackages.includes(kind.package) || (kind.kind === 'builtin' && module.allowedPackages.includes('node:*'));
        if (!permitted) errors.push({code:'forbidden-package-import',path:file.path,package:kind.package,module:file.module});
        if (kind.kind === 'package' && !registry.packages[kind.package]) errors.push({code:'unregistered-package',path:file.path,package:kind.package});
      }
    }
    for (const reference of file.references || []) if (!byPath.has(reference)) errors.push({code:'unresolved-file-reference',path:file.path,target:reference});
  }
  errors.push(...validatePublicInterfaces(registry,sources).errors);
  const runtime = edges.filter(edge => !edge.typeOnly);
  for (const cycle of cycles(runtime)) errors.push({code:'runtime-file-cycle',files:cycle});
  const moduleEdges = runtime.filter(edge => edge.fromModule !== edge.toModule).map(edge => ({from:edge.fromModule,to:edge.toModule}));
  const ownershipCycles=cycles(moduleEdges).map(modules=>({modules,edges:runtime.filter(edge=>edge.fromModule!==edge.toModule&&modules.includes(edge.fromModule)&&modules.includes(edge.toModule))}));
  const publicEdges=runtime.filter(edge=>edge.fromModule!==edge.toModule&&edge.interfaces?.includes('public')).map(edge=>({from:edge.fromModule,to:edge.toModule}));
  for(const cycle of cycles(publicEdges))errors.push({code:'public-owner-cycle',modules:cycle});
  return {passed:errors.length===0,registeredFiles:byPath.size,actualFiles:actual.size,errors,edges,externalDependencies,dynamicEvidence,ownershipCycles};
}
