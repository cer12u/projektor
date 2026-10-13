// @module tooling.build
// @role metadata-normalization
import {transform} from 'esbuild';
import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
/** Validate the observed Wrangler JS/map shape; rename metadata without changing executable statements. */
export async function normalizeWorkerMetadata(source,mapText){
 const old='//# sourceMappingURL=worker.js.map',replacement='//# sourceMappingURL=index.js.map';
 if(source.startsWith('------formdata-')||/Content-Disposition:\s*form-data/i.test(source))throw new Error('Serialized upload payload is not executable Worker JavaScript');
 if(source.split(old).length!==2||!source.trimEnd().endsWith(old))throw new Error('Unexpected Wrangler source-map directive');
 await transform(source,{loader:'js',target:'esnext',format:'esm'});
 const map=JSON.parse(mapText);
 if(map.version!==3||!Array.isArray(map.sources)||!Array.isArray(map.sourcesContent)||map.sources.length!==map.sourcesContent.length)throw new Error('Unexpected Wrangler source-map shape');
 const normalized=source.replace(old,replacement),before=source.replace(old,''),after=normalized.replace(replacement,'');
 if(before!==after)throw new Error('Executable Worker text changed');
 if('file'in map)map.file='index.js';
 // Wrangler sources are relative to the output directory; keep that association portable.
 map.sourceRoot='.';
 return {source:normalized,sourceMap:JSON.stringify(map),proof:{onlySourceMapDirectiveChanged:true,beforeExecutableSha256:hash(before),afterExecutableSha256:hash(after),inputSha256:hash(source),outputSha256:hash(normalized)}};
}
