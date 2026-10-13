// @module tooling.build
// @role metadata
// Normalize filenames/source-map metadata and static README; executable statements and WASM stay untouched.
import {readFile,writeFile,unlink,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {normalizeWorkerMetadata} from './worker-metadata.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const out=resolve(root,'dist/worker'),worker=resolve(out,'worker.js'),map=resolve(out,'worker.js.map');
const version=JSON.parse(await readFile(resolve(root,'package.json'),'utf8')).devDependencies.wrangler;
const normalized=await normalizeWorkerMetadata(await readFile(worker,'utf8'),await readFile(map,'utf8'));
await writeFile(resolve(out,'index.js'),normalized.source);await writeFile(resolve(out,'index.js.map'),normalized.sourceMap);
await unlink(worker);await unlink(map);
await writeFile(resolve(out,'README.md'),`Generated Worker artifacts.\nBuilt with pinned Wrangler ${version}; runtime, source map and static WASM are verified separately.\n`);
await mkdir(resolve(root,'.local/evidence'),{recursive:true});
await writeFile(resolve(root,'.local/evidence/build-metadata.json'),JSON.stringify(normalized.proof,null,2)+'\n');
