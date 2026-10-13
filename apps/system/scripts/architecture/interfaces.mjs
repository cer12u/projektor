// @module tooling.architecture
// @role interfaces
import ts from 'typescript';

const modifier=(node,kind)=>node.modifiers?.some(item=>item.kind===kind);
const nameOf=node=>node.name&&ts.isIdentifier(node.name)?node.name.text:null;
export function exportedNames(tree){
 const names=[],wildcards=[];
 for(const node of tree.statements){
  if(ts.isExportDeclaration(node)){
   if(!node.exportClause)wildcards.push(node);
   else if(ts.isNamedExports(node.exportClause))for(const item of node.exportClause.elements)names.push(item.name.text);
   else names.push(node.exportClause.name.text);
  }else if(ts.isExportAssignment(node))names.push('default');
  else if(modifier(node,ts.SyntaxKind.ExportKeyword)){
   if(modifier(node,ts.SyntaxKind.DefaultKeyword))names.push('default');
   else if(ts.isVariableStatement(node))for(const item of node.declarationList.declarations){const name=nameOf(item);if(name)names.push(name);}
   else{const name=nameOf(node);if(name)names.push(name);}
  }
 }
 return {names:[...new Set(names)],wildcards};
}

export function permitsInterface(entry,source){
 const consumers=entry.consumers||[];
 const match=consumers.some(consumer=>consumer.module===source.module&&(!consumer.roles||consumer.roles.includes(source.role))&&(!consumer.paths||consumer.paths.includes(source.path)));
 if(entry.kind==='public')return consumers.length===0||match;
 if(entry.kind==='assembly')return source.module==='composition'&&match;
 if(entry.kind==='transaction')return consumers.some(consumer=>consumer.module===source.module&&(!consumer.roles||consumer.roles.includes(source.role))&&(!consumer.paths||consumer.paths.includes(source.path)));
 if(entry.kind==='test')return consumers.some(consumer=>consumer.module===source.module&&consumer.paths?.includes(source.path)&&(!consumer.roles||consumer.roles.includes(source.role)));
 return false;
}

/** Validate named, owner-reviewed surfaces; this does not prove semantic responsibility. */
export function validatePublicInterfaces(registry,sources){
 const errors=[],files=new Map(registry.files.map(file=>[file.path,file])),seen=new Set();
 for(const entry of registry.interfaces||[]){
  const key=entry.path+'#'+entry.kind;
  if(seen.has(key))errors.push({code:'duplicate-interface',path:entry.path,kind:entry.kind});seen.add(key);
  const file=files.get(entry.path);
  if(!file){errors.push({code:'interface-file-missing',path:entry.path});continue;}
  if(file.module!==entry.module)errors.push({code:'interface-owner-mismatch',path:entry.path,module:entry.module,actual:file.module});
  if(!Array.isArray(entry.exports))errors.push({code:'interface-exports-not-declared',path:entry.path});
  if(!['public','assembly','transaction','test'].includes(entry.kind))errors.push({code:'interface-kind-invalid',path:entry.path});
  if(['assembly','transaction'].includes(entry.kind)&&(!(entry.consumers||[]).length||!entry.consumers.every(consumer=>consumer.roles?.length||consumer.paths?.length)))errors.push({code:'restricted-interface-consumers-not-exact',path:entry.path});
  if(entry.kind==='test'&&(!(entry.consumers||[]).length||!entry.consumers.every(consumer=>consumer.paths?.length)))errors.push({code:'test-spi-consumers-not-exact',path:entry.path});
  if(entry.kind!=='public'&&(entry.consumers||[]).some(consumer=>registry.modules[consumer.module]?.kind==='verification'&&!consumer.paths?.length))errors.push({code:'test-spi-consumers-not-exact',path:entry.path});
  const tree=ts.createSourceFile(entry.path,sources.get(entry.path)||'',ts.ScriptTarget.Latest,true),exports=exportedNames(tree);
  if(entry.kind==='public'&&exports.wildcards.length)errors.push({code:'wildcard-public-export',path:entry.path});
  const allowed=new Set(entry.exports||[]);
  if(entry.kind==='public'&&/^public(?:-|$)/.test(file.role))for(const name of exports.names)if(!allowed.has(name))errors.push({code:'undeclared-public-export',path:entry.path,symbol:name});
  for(const name of allowed)if(!exports.names.includes(name))errors.push({code:'interface-export-missing',path:entry.path,symbol:name});
 }
 return {errors};
}
