// @module tooling.architecture
// @role resolution
import {posix} from 'node:path';
import {builtinModules} from 'node:module';
const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')));
export function classifySpecifier(specifier) {
  if (specifier.startsWith('.')) return {kind: 'relative'};
  if (specifier.startsWith('cloudflare:')) return {kind:'platform',package:specifier};
  if (specifier.startsWith('python:')) return {kind:['python:json','python:pathlib'].includes(specifier)?'builtin':'package',package:specifier};
  if (specifier.startsWith('node:') || builtins.has(specifier)) return {kind: 'builtin', package: `node:${specifier.replace(/^node:/, '')}`};
  if (/^(?:https?:|file:|data:|\/)/.test(specifier)) return {kind: 'external-location'};
  return {kind: 'package', package: specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]};
}
export function resolveImport(importer, specifier, paths) {
  const base = posix.normalize(posix.join(posix.dirname(importer), specifier));
  const choices = [base, ...['.ts','.tsx','.js','.jsx','.mjs','.cjs','.json','.d.ts','.wasm','.css'].map(ext => base + ext), ...['.ts','.tsx','.js','.mjs','.d.ts'].map(ext => `${base}/index${ext}`)];
  if (/\.(js|jsx|mjs)$/.test(base)) choices.push(base.replace(/\.(js|jsx|mjs)$/, '.ts'), base.replace(/\.(js|jsx|mjs)$/, '.tsx'));
  return choices.find(path => paths.has(path));
}
