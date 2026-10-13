// @module tooling.architecture
// @role file-types
import {extname} from 'node:path';
export const scriptExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
export function tagStyle(path) {
  const ext = extname(path);
  if (scriptExtensions.has(ext) || ext === '.jsonc') return 'slash';
  if (ext === '.css') return 'css';
  if (ext === '.html') return 'html';
  if (['.py', '.sh', '.yaml', '.yml', '.toml'].includes(ext)) return 'hash';
  if (ext === '.sql') return 'sql';
  return null;
}
