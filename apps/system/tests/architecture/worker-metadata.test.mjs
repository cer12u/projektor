// @module verification
// @role build-metadata-regression
import assert from 'node:assert/strict';
import {normalizeWorkerMetadata} from '../../scripts/build/worker-metadata.mjs';
const source='const value=1; export {value};\n//# sourceMappingURL=worker.js.map\n';
const map=JSON.stringify({version:3,file:'worker.js',sourceRoot:'/old/build/path',sources:['../../src/apps/worker.ts'],sourcesContent:['export const value=1'],mappings:'',names:[]});
const result=await normalizeWorkerMetadata(source,map);
assert.equal(result.source.replace('//# sourceMappingURL=index.js.map',''),source.replace('//# sourceMappingURL=worker.js.map',''));
assert.equal(result.proof.beforeExecutableSha256,result.proof.afterExecutableSha256);
assert.deepEqual(JSON.parse(result.sourceMap),{...JSON.parse(map),file:'index.js',sourceRoot:'.'});
await assert.rejects(()=>normalizeWorkerMetadata('------formdata-undici-123\r\nContent-Disposition: form-data; name="worker.js"\r\n'+source,map),/Serialized upload payload/);
await assert.rejects(()=>normalizeWorkerMetadata(source.replace('worker.js.map','unexpected.js.map'),map),/source-map directive/);
await assert.rejects(()=>normalizeWorkerMetadata(source,'{}'),/source-map shape/);
console.log(JSON.stringify({passed:true,checks:6,scope:'Executable-text preservation, portable map metadata and rejection of multipart/unknown output shapes'}));
