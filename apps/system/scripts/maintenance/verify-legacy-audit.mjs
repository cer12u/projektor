// @module maintenance
// @role audit-artifact-verifier
// Offline validation only. Never contacts a provider, opens a database or prints source rows.
import {build} from 'esbuild';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const file=process.argv[2];if(!file||process.argv.length!==3)throw Error('Usage: node scripts/maintenance/verify-legacy-audit.mjs /private/path/legacy-audit.json');
const repository=fileURLToPath(new URL('../../',import.meta.url)),temporary=await mkdtemp(join(tmpdir(),'projektor-audit-verify-'));
try{
 await build({stdin:{contents:"export {prepareLegacyAuditArtifact} from './src/adapters/d1/work/legacy-audit-import';",resolveDir:repository},outfile:join(temporary,'verify.mjs'),bundle:true,platform:'node',format:'esm'});
 const {prepareLegacyAuditArtifact}=await import(pathToFileURL(join(temporary,'verify.mjs')).href);
 const prepared=await prepareLegacyAuditArtifact(await readFile(resolve(file),'utf8'));
 console.log(JSON.stringify({status:'validated',sourceTable:prepared.artifact.sourceTable,count:prepared.rows.length,datasetId:prepared.datasetId,sourceArtifactSha256:prepared.artifactHash,sourceRowsSha256:prepared.artifact.rowsSha256,allIndividualRowHashesMatch:true,databaseRelationsVerified:false,databaseWrites:0}));
}finally{await rm(temporary,{recursive:true,force:true});}
