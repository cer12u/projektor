// @module tooling.architecture
// @role boundaries
import ts from 'typescript';
import {resolveImport} from './resolution.mjs';
import {scriptExtensions} from './file-types.mjs';
import {parseImports} from './imports.mjs';
import {extname} from 'node:path';

const statefulHooks=new Set(['useState','useReducer','useEffect','useLayoutEffect','useInsertionEffect','useRef','useSyncExternalStore','useImperativeHandle','useActionState','useOptimistic']);
const credentialHeaders=new Set(['authorization','cookie','x-csrf-token','cf-access-jwt-assertion']);
/** Narrow semantic checks for the specific UI/control-plane boundaries under repair. */
export function validateBoundaries(registry,sources){
  const errors=[],files=new Map(registry.files.map(file=>[file.path,file]));
  for(const file of registry.files){
    if(file.kind!=='authored'||!scriptExtensions.has(extname(file.path))) continue;
    const source=sources.get(file.path);if(source===undefined)continue;
    const tree=ts.createSourceFile(file.path,source,ts.ScriptTarget.Latest,true);
    // An owner may contain both pure business code and its adapter; same ownership is not permission.
    const repositoryPath=file.path.replace(/^candidate\//,'');
    const pureRoles=new Set(['rules','pure-rules','domain-rules','domain-model','domain-outcome','application','application-contracts','use-cases','ports','port','persistence-contract','public','public-contract','public-use-cases']);
    const pureBusiness=repositoryPath.startsWith('src/modules/')||(registry.modules?.[file.module]?.kind==='business'&&pureRoles.has(file.role));
    const parsed=parseImports(file.path,source), boundaryImports=[...parsed.imports];
    for(const dependency of parsed.dynamic){
      const mapping=(file.dynamicDependencies||[]).find(item=>item.expression===dependency.expression);
      for(const mapped of mapping?.specifiers||[])boundaryImports.push({...dependency,...(typeof mapped==='string'?{specifier:mapped}:mapped)});
    }
    // Registered generated imports must obey the same pure-code boundary as direct imports.
    for(const dependency of [...boundaryImports])if(!resolveImport(file.path,dependency.specifier,files)){
      const mapping=(file.generatedImports||[]).find(item=>item.specifier===dependency.specifier);
      for(const mapped of mapping?.specifiers||[])boundaryImports.push({...dependency,...(typeof mapped==='string'?{specifier:mapped}:mapped)});
    }
    if(pureBusiness)for(const dependency of boundaryImports){
      const targetPath=resolveImport(file.path,dependency.specifier,files),target=targetPath?files.get(targetPath):null;
      if(!target)continue;
      const targetRepositoryPath=target.path.replace(/^candidate\//,'');
      const concrete=/^src\/(?:adapters|apps|web|agent)\//.test(targetRepositoryPath)||/^(?:private-)?d1(?:-|$)/.test(target.role)||['transaction-spi','atomic-commit','assembly','composition-entry'].includes(target.role)||target.module==='platform.d1';
      if(concrete)errors.push({code:'pure-code-imports-concrete-adapter',path:file.path,target:target.path,typeOnly:dependency.typeOnly,line:dependency.line,detail:'Business rules, use cases and contracts depend on typed ports, including within one owner.'});
    }

    const isBrowser=['browser-session','workbench','administration','platform.browser'].includes(file.module);
    const isController=isBrowser&&/(?:^|-)controller$/.test(file.role);
    const isView=isBrowser&&/(?:^|-)view$/.test(file.role);
    const isComposition=/(?:^|-)composition$/.test(file.role)||['deployment-entry','assembly','composition-entry'].includes(file.role);
    const imported=new Map(),reactNamespaces=new Set(),databaseReceivers=new Set(['db','DB','database']);
    function databaseLike(node){return ts.isIdentifier(node)?databaseReceivers.has(node.text)||/(?:db|database)$/i.test(node.text):ts.isPropertyAccessExpression(node)?/(?:db|database)$/i.test(node.name.text):false;}
    function collectDatabaseAliases(node){if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&((node.initializer&&databaseLike(node.initializer))||node.type&&/\b(?:D1Database|AuthDB|DatabaseSync)\b/.test(node.type.getText(tree))))databaseReceivers.add(node.name.text);ts.forEachChild(node,collectDatabaseAliases);}
    collectDatabaseAliases(tree);
    for(const node of tree.statements){
      if(!ts.isImportDeclaration(node)||!ts.isStringLiteralLike(node.moduleSpecifier)||node.importClause?.isTypeOnly)continue;
      const specifier=node.moduleSpecifier.text,bindings=node.importClause?.namedBindings;
      const target=resolveImport(file.path,specifier,files),module=target?files.get(target).module:null,role=target?files.get(target).role:null;
      if(node.importClause?.name){imported.set(node.importClause.name.text,{name:'default',module,role,package:specifier});if(specifier==='react')reactNamespaces.add(node.importClause.name.text);}
      if(bindings&&ts.isNamedImports(bindings)) for(const binding of bindings.elements) if(!binding.isTypeOnly) imported.set(binding.name.text,{name:binding.propertyName?.text||binding.name.text,module,role,package:specifier});
      if(bindings&&ts.isNamespaceImport(bindings)){imported.set(bindings.name.text,{name:'*',module,role,package:specifier});if(specifier==='react')reactNamespaces.add(bindings.name.text);}
    }
    const fail=(code,node,detail)=>errors.push({code,path:file.path,module:file.module,line:tree.getLineAndCharacterOfPosition(node.getStart(tree)).line+1,detail});
    function visit(node){
      if(isController&&(ts.isJsxElement(node)||ts.isJsxSelfClosingElement(node)||ts.isJsxFragment(node)))fail('controller-renders-jsx',node,'Controller must return state/actions, not rendered JSX.');
      if(ts.isCallExpression(node)){
        const callee=node.expression;
        const name=ts.isIdentifier(callee)?callee.text:ts.isPropertyAccessExpression(callee)?callee.name.text:null;
        const object=ts.isPropertyAccessExpression(callee)&&ts.isIdentifier(callee.expression)?callee.expression.text:null;
        const binding=ts.isIdentifier(callee)?imported.get(callee.text):object?imported.get(object):null;
        const isFetch=ts.isIdentifier(callee)&&callee.text==='fetch'||name==='fetch'&&['globalThis','window','self'].includes(object);
        if(isBrowser&&file.role!=='browser-transport'&&isFetch)fail('fetch-outside-browser-transport',node,'Generic fetch belongs only to the declared browser transport role.');
        if(isView){
          if(ts.isPropertyAccessExpression(callee)&&/\b(?:sessionStorage|localStorage|indexedDB|clipboard)\b/.test(callee.expression.getText(tree)))fail('view-performs-browser-effect',node,callee.expression.getText(tree));
          if((binding?.package==='react'&&statefulHooks.has(binding.name))||(reactNamespaces.has(object)&&statefulHooks.has(name)))fail('view-stateful-hook',node,name);
          if(isFetch||['httpRequest','jsonRequest'].includes(name))fail('view-performs-request',node,name);
          if(binding?.role&&(/(?:^|-)(?:transport|credentials|command|access)(?:-|$)/.test(binding.role)))fail('view-calls-effect-port',node,binding.role);
        }
        if(isComposition){
          if(['prepare','batch','exec'].includes(name)&&ts.isPropertyAccessExpression(callee)&&databaseLike(callee.expression))fail('composition-implements-persistence',node,name);
          if(object==='JSON'&&name==='parse')fail('composition-parses-input',node,'Move parsing/validation behind its dedicated adapter.');
          if(name==='get'&&node.arguments[0]&&ts.isStringLiteralLike(node.arguments[0])&&credentialHeaders.has(node.arguments[0].text.toLowerCase()))fail('composition-parses-credentials',node,node.arguments[0].text);
        }
      }
      ts.forEachChild(node,visit);
    }
    visit(tree);
  }
  return {errors};
}
