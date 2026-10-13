// @module verification
// @role delivery-outcome-contracts
// Architecture spec §3–5: failure reason, application evidence and disclosure are independent.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const sourcePath=resolve('src/apps/http/outcomes.ts'),source=await readFile(sourcePath,'utf8');
const directory=await mkdtemp(join(tmpdir(),'projektor-delivery-outcomes-'));
const report={level:'focused Node contract tests of actual bundled delivery mapper',productionActions:0,
 source:'src/apps/http/outcomes.ts',sourceSha256:createHash('sha256').update(source).digest('hex'),results:[]};
const op='request-owned-operation',snapshot={privateBody:'must remain protected',revision:7};
const statuses={invalid:400,unauthenticated:401,forbidden:403,conflict:409,input_mismatch:409,not_found:404,unavailable:503,internal:500,rate_limited:429};
async function load(name,mutated=false){
 const output=join(directory,name+'.mjs');
 await build({stdin:{contents:"export * from './src/apps/http/outcomes';export {InputError} from './src/modules/change-outcomes';export {IdentityError} from './src/modules/identity/public';",resolveDir:process.cwd(),sourcefile:'delivery-contract-entry.ts'},outfile:output,bundle:true,format:'esm',platform:'node',plugins:[{name:'pin-tested-mapper',setup(builder){builder.onLoad({filter:/\/http\/outcomes\.ts$/},()=>({contents:mutated?source.replace("outcome.disclosure==='allowed'&&",''):source,loader:'ts',resolveDir:resolve('src/apps/http')}));}}]});
 return import(pathToFileURL(output).href);
}
async function failure(api,promise){try{await promise;assert.fail('expected a mapped failure');}catch(error){assert.ok(error instanceof api.DeliveryFailure);return error;}}
async function protectedUnknown(api,disclosure){
 // Intentionally include stale protected data from an adapter. Runtime mapping must
 // obey explicit disclosure even if an upstream value exceeds the TypeScript union.
 const error=await failure(api,api.changeValue(Promise.resolve({application:'unknown',disclosure,operationId:op,failure:{kind:'forbidden',code:'permission_revoked'},authorizedCurrent:snapshot})));
 assert.equal(error.status,403);assert.deepEqual(error.body,{error:'permission_revoked',operationId:op,application:'unknown'});
 assert.ok(!('mutationOutcome' in error.body));assert.ok(!JSON.stringify(error.body).includes(snapshot.privateBody));
}
try{
 const api=await load('actual');
 for(const disclosure of ['denied','withheld'])await protectedUnknown(api,disclosure);
 report.results.push({name:'denied/withheld unknown suppress protected current and retain operation ID without nonapplication inference',passed:true});
 const conflict=await failure(api,api.changeValue(Promise.resolve({application:'unknown',disclosure:'allowed',operationId:op,failure:{kind:'conflict',code:'revision_conflict',reason:'stale_revision'},authorizedCurrent:snapshot})));
 assert.equal(conflict.status,409);assert.deepEqual(conflict.body,{error:'revision_conflict',reason:'stale_revision',operationId:op,application:'unknown',current:snapshot});
 for(const [kind,status] of Object.entries(statuses)){
  const error=await failure(api,api.changeValue(Promise.resolve({application:'unknown',disclosure:'withheld',operationId:op,failure:{kind}})));
  assert.equal(error.status,status);assert.deepEqual(error.body,{error:'temporarily_unavailable',operationId:op,application:'unknown'});
 }
 report.results.push({name:'authorized conflict may disclose current; every failure status remains application-unknown',passed:true});
 const certificate={operationId:op,status:'not_applied',phase:'pre_dispatch'};
 const rejected=await failure(api,api.changeValue(Promise.resolve({application:'not_applied',disclosure:'withheld',certificate,failure:{kind:'invalid',code:'invalid_patch',fields:{patch:'unsupported'}}})));
 assert.equal(rejected.status,400);assert.deepEqual(rejected.body,{error:'invalid_patch',fields:{patch:'unsupported'},mutationOutcome:certificate});assert.strictEqual(rejected.body.mutationOutcome,certificate);
 const missing=await failure(api,api.resultValue(Promise.resolve({status:'missing',operationId:op,application:'unknown',failure:{kind:'not_found',code:'operation_not_found'}})));
 assert.equal(missing.status,404);assert.deepEqual(missing.body,{error:'operation_not_found',operationId:op,application:'unknown'});
 report.results.push({name:'only explicit nonapplication certificate is mapped; missing receipt404 preserves unknown',passed:true});
 for(const [kind,status] of Object.entries(statuses)){
  const failure={kind,code:'domain_'+kind,fields:{input:'bounded field'}};
  const mapped=api.protocolFailure(new api.IdentityError(failure.kind,failure.code,failure.fields));assert.equal(mapped.status,status);assert.deepEqual(mapped.body,{error:failure.code,fields:failure.fields});
 }
 const input=api.protocolFailure(new api.InputError('invalid_input',{target:'required'}));assert.equal(input.status,400);assert.deepEqual(input.body,{error:'invalid_input',fields:{target:'required'}});
 assert.strictEqual(api.protocolFailure(input),input);assert.equal(api.protocolFailure(new Error('untrusted internal detail')),undefined);
 report.results.push({name:'IdentityError maps all typed statuses including429; InputError maps400 and unknown errors are not exposed',passed:true});
 const receipt={operationId:op,snapshot};
 assert.strictEqual(await api.readValue(Promise.resolve({status:'value',value:snapshot})),snapshot);
 assert.strictEqual(await api.resultValue(Promise.resolve({status:'confirmed',receipt})),receipt);
 for(const source of ['committed','recovered'])assert.deepEqual(await api.changeValue(Promise.resolve({application:'confirmed',disclosure:'allowed',source,receipt})),{...receipt,source});
 const denied=await failure(api,api.readValue(Promise.resolve({status:'denied',failure:{kind:'forbidden',code:'hidden'}})));assert.deepEqual(denied.body,{error:'hidden'});
 report.results.push({name:'success preserves exact receipt/snapshot and committed-versus-recovered source',passed:true});
 assert.ok(source.includes("outcome.disclosure==='allowed'&&"),'negative control targets exact disclosure guard');
 const mutant=await load('removed-disclosure-guard',true);
 await assert.rejects(()=>protectedUnknown(mutant,'denied'),assert.AssertionError);
 report.results.push({name:'negative control: removing disclosure guard is detected by protected-current assertion',passed:true});
 report.passed=true;
}catch(error){report.passed=false;report.failure=error.message;throw error;}
finally{await mkdir('.local/evidence',{recursive:true});await writeFile('.local/evidence/delivery-outcomes-check.json',JSON.stringify(report,null,2)+'\n');await rm(directory,{recursive:true,force:true});}
console.log(JSON.stringify(report));
