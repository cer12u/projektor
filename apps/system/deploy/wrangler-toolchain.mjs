// @module deployment
// @role toolchain
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {CLI_VERSION} from './cloudflare-port.mjs';
import {createHash} from 'node:crypto';
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw new Error(code); };
export async function verifyToolchain(candidate) {
  const pkg = JSON.parse(await readFile(resolve(candidate, 'node_modules/wrangler/package.json')));
  if (pkg.version !== CLI_VERSION) fail('WRANGLER_VERSION_CHANGED');
  if (sha256(await readFile(resolve(candidate, 'node_modules/wrangler/bin/wrangler.js'))) !== '780661a508810f3b65786895b1ca9aacbc4f55d329ae6b8c1e49ec8433569f77') fail('WRANGLER_LAUNCHER_CHANGED');
  if (sha256(await readFile(resolve(candidate, 'node_modules/wrangler/wrangler-dist/cli.js'))) !== '31866b9a3686777254819158e60ebe4920d1d91141cde68846c62b52f75d7a66') fail('WRANGLER_BUNDLE_CHANGED');
  return {cliVersion:CLI_VERSION};
}
