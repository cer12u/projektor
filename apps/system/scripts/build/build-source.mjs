// @module tooling.build
// @role worker
import { build } from 'esbuild';
import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

await mkdir('dist/worker', { recursive: true });
const result = await build({
  entryPoints: ['src/apps/worker.ts'], outfile: 'dist/worker/index.js', bundle: true,
  format: 'esm', target: 'es2023', platform: 'neutral', mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'browser'], external: ['node:*', 'cloudflare:*'], metafile: true,
  plugins: [{ name: 'static-wasm', setup(b) {
    b.onResolve({ filter: /\.wasm$/ }, a => ({ path: './' + a.path.split('/').at(-1), external: true }));
  } }],
});
if (Object.keys(result.metafile.inputs).some(p => p.includes('legacy-do-retention'))) throw new Error('retired source entered bundle');
for (const name of ['argon2.wasm', 'blake2b.wasm']) await copyFile('src/adapters/crypto/generated/' + name, 'dist/worker/' + name);
const hashes = {};
for (const name of ['index.js', 'argon2.wasm', 'blake2b.wasm']) {
  const data = await readFile('dist/worker/' + name);
  hashes[name] = { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
}
await writeFile('.local/evidence/source-build.json', JSON.stringify({
  builtFrom: 'candidate/src/apps/worker.ts', historicalDistUsed: false,
  retiredSourceIncluded: false, buildInputs: Object.keys(result.metafile.inputs), outputs: hashes,
}, null, 2) + '\n');
console.log('New source Worker bundle built; retired source absent.');
