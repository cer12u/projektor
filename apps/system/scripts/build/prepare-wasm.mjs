// @module tooling.build
// @role wasm
// P1a: adapt ONLY the fixed upstream module loader for Workers' static Wasm imports.
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
const base = new URL("../../", import.meta.url);
const dir = new URL('src/adapters/crypto/generated/', base);
await mkdir(dir, { recursive: true });
const pkg = JSON.parse(await readFile(new URL('node_modules/hash-wasm/package.json', base), 'utf8'));
if (pkg.version !== '4.12.0') throw new Error('Review the loader before changing hash-wasm version');
let source = await readFile(new URL('node_modules/hash-wasm/dist/index.esm.js', base), 'utf8');
const provenance = { version: pkg.version, sourceSha256: createHash('sha256').update(source).digest('hex'), modules: {} };
for (const name of ['argon2', 'blake2b']) {
  const m = source.match(new RegExp(`var name([^ ]*) = "${name}";\\s*var data\\1 = "([^"]+)";`));
  if (!m) throw new Error(`Missing upstream binary: ${name}`);
  const bytes = Buffer.from(m[2], 'base64');
  await writeFile(new URL(`${name}.wasm`, dir), bytes);
  provenance.modules[name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
const old = 'const asm = decodeBase64(binary.data);\n                const promise = WebAssembly.compile(asm);';
if (source.split(old).length !== 2) throw new Error('Upstream loader shape changed');
source = source.replace(old, 'const promise = Promise.resolve(staticModules[binary.name]);');
source = `import argon2Module from './argon2.wasm';\nimport blake2bModule from './blake2b.wasm';\nconst staticModules = {argon2: argon2Module, blake2b: blake2bModule};\n` + source;
await writeFile(new URL('upstream.tmp.mjs', dir), source);
await build({ stdin: { contents: "export {argon2id} from './upstream.tmp.mjs';", resolveDir: dir.pathname }, bundle: true, format: 'esm', target: 'es2023', outfile: new URL('hash-wasm.js', dir).pathname, external: ['*.wasm'], legalComments: 'inline' });
await writeFile(new URL('hash-wasm.d.ts', dir), "export {argon2id} from 'hash-wasm';\n");
await copyFile(new URL('node_modules/hash-wasm/LICENSE', base), new URL('LICENSE.hash-wasm', dir));
await writeFile(new URL('docs/wasm-provenance.json', base), JSON.stringify(provenance, null, 2) + '\n');
// A separate local benchmark build records linear memory; production never imports it.
const bench = source.replace('wasmInstance.exports.Hash_SetMemorySize(totalSize);', 'wasmInstance.exports.Hash_SetMemorySize(totalSize);\n        benchmarkMemory.push(wasmInstance.exports.memory.buffer.byteLength);');
await writeFile(new URL('benchmark.tmp.mjs', dir), 'export const benchmarkMemory = [];\n' + bench);
await build({stdin: {contents: "export {argon2id, benchmarkMemory} from './benchmark.tmp.mjs';", resolveDir: dir.pathname}, bundle: true, format: 'esm', target: 'es2023', outfile: new URL('benchmark.js', dir).pathname, external: ['*.wasm']});
// Intermediate files aren't delivery sources.
const { unlink } = await import('node:fs/promises');
await unlink(new URL('upstream.tmp.mjs', dir));
await unlink(new URL('benchmark.tmp.mjs', dir));
console.log('Static upstream Argon2id / BLAKE2b modules prepared; algorithm unchanged.');
