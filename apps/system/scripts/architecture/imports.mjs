// @module tooling.architecture
// @role imports
import ts from 'typescript';
import {extname} from 'node:path';
import {scriptExtensions} from './file-types.mjs';
export function parseImports(path, source) {
  const extension=extname(path);
  if (extension === '.html') return {imports:[...source.matchAll(/<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+)["']/g)].filter(match=>!match[1].startsWith('http')).map(match=>({specifier:match[1].startsWith('/')?'.'+match[1]:match[1],typeOnly:false,kind:'html-resource',line:source.slice(0,match.index).split('\n').length})),dynamic:[]};
  if (extension === '.css') return {imports:[...source.matchAll(/@import\s+(?:url\()?['"]([^'"]+)['"]/g)].map(match=>({specifier:match[1],typeOnly:false,kind:'css-import',line:source.slice(0,match.index).split('\n').length})),dynamic:[]};
  if (extension === '.py') return {imports:[...source.matchAll(/^(?:from|import)\s+([\w.]+)/gm)].map(match=>({specifier:'python:'+match[1].split('.')[0],typeOnly:false,kind:'python-import',line:source.slice(0,match.index).split('\n').length})),dynamic:[]};
  if (!scriptExtensions.has(extension)) return {imports: [], dynamic: []};
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const imports = [], dynamic = [];
  function record(node, expression, typeOnly, kind, names = []) {
    const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
    if (ts.isStringLiteralLike(expression)) imports.push({specifier: expression.text, typeOnly:typeOnly || path.endsWith('.d.ts'), kind, line, names});
    else dynamic.push({expression: expression.getText(tree), kind, line, names});
  }
  function visit(node) {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier) {
      const clause = node.importClause;
      const typeOnly = Boolean(clause?.isTypeOnly || (clause?.namedBindings && ts.isNamedImports(clause.namedBindings) && !clause.name && clause.namedBindings.elements.length && clause.namedBindings.elements.every(item => item.isTypeOnly)));
      const names=[];if(clause?.name)names.push('default');if(clause?.namedBindings){if(ts.isNamespaceImport(clause.namedBindings))names.push('*');else for(const item of clause.namedBindings.elements)names.push(item.propertyName?.text||item.name.text);}
      record(node, node.moduleSpecifier, typeOnly, 'import',names);
    } else if(ts.isImportEqualsDeclaration(node)&&ts.isExternalModuleReference(node.moduleReference)&&node.moduleReference.expression) record(node,node.moduleReference.expression,Boolean(node.isTypeOnly),'import-equals',['*']);
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier) record(node, node.moduleSpecifier, Boolean(node.isTypeOnly || (node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length && node.exportClause.elements.every(item=>item.isTypeOnly))), 'export',node.exportClause&&ts.isNamedExports(node.exportClause)?node.exportClause.elements.map(item=>item.propertyName?.text||item.name.text):['*']);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) record(node, node.argument.literal, true, 'import-type',node.qualifier?[node.qualifier.getText(tree).split('.')[0]]:['*']);
    else if (ts.isCallExpression(node) && node.arguments.length) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) record(node, node.arguments[0], false, 'dynamic-import');
      else if (ts.isIdentifier(callee) && callee.text === 'require') record(node, node.arguments[0], false, 'require');
      else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'require' && callee.name.text === 'resolve') record(node, node.arguments[0], false, 'require-resolve');
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return {imports, dynamic, parseErrors: tree.parseDiagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))};
}
