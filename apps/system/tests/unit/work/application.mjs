// @module verification
// @role work-application-regression
// State-independent edits deliberately omit state; state-dependent planning is covered in decisions.mjs.
// Hypotheses: invalid typed calls dispatch; normalization changes IDs/input; failures imply nonapplication;
// postcommit denial leaks a snapshot; application imports concrete persistence. No provider simulation.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const dir=resolve('.local/work-application');await mkdir(dir,{recursive:true});
const unit=await build({stdin:{contents:`export {createWorkContent} from './src/modules/work/application';export {decodeIssueChange,decodeContentChange,decodeLegacyReference} from './src/modules/work/public';`,resolveDir:process.cwd()},outfile:dir+'/application.mjs',bundle:true,platform:'node',format:'esm',metafile:true});
const {createWorkContent,decodeIssueChange,decodeContentChange,decodeLegacyReference}=await import(pathToFileURL(dir+'/application.mjs').href);
await build({stdin:{contents:`export {observeChange,observeRead,observeResult,failedChange,failureOf} from './src/adapters/d1/persistence/outcomes';export {MutationError} from './src/adapters/d1/persistence/public';export {InputError} from './src/modules/change-outcomes';export {ApiError} from './src/adapters/protocol-errors';`,resolveDir:process.cwd()},outfile:dir+'/outcomes.mjs',bundle:true,platform:'node',format:'esm'});
const {observeChange,observeResult,failedChange,MutationError,InputError,ApiError,failureOf}=await import(pathToFileURL(dir+'/outcomes.mjs').href);
let checks=0;const equal=(a,b,label)=>{assert.deepEqual(a,b,label);checks++;};
const appInputs=Object.keys(unit.metafile.inputs).filter(p=>p!=='<stdin>');assert(!appInputs.some(p=>/\/(?:platform|identity|operations)\/|\/(?:d1|mutation|issues|content|model-service)\.ts$/.test(p)),appInputs.join('\n'));checks++;
const id='I_'+'1'.repeat(64),op='typed-op',events=[];
let next={application:'unknown',disclosure:'withheld',operationId:op,failure:{kind:'unavailable',code:'mutation_unavailable'}};
const port=new Proxy({async commitIssueChange(command){events.push(command);return next;},async commitContentChange(command){events.push(command);return next;}},{get(target,key){if(key in target)return target[key];return ()=>{throw Error('Forbidden implicit read/retry: '+String(key));};}});
const work=createWorkContent(port);
const command=decodeIssueChange('P',id,{operationId:op,revision:7,body:'body\n',assigneeId:null,schedule:{start:null,end:null,due:null}});
const returned=await work.changeIssue(command);equal(returned,next,'unknown outcome preserved');equal(events,[command],'one unchanged command, no preliminary read or retry');
for(const bad of [{...command,input:{...command.input,revision:0}},{...command,input:{...command.input,body:'\ud800'}},{...command,input:{...command.input,unexpected:1}},{...command,issueId:''}]){
 const result=await work.changeIssue(bad);equal(result.application,'unknown','invalid is no certificate');equal(result.failure.kind,'invalid','invalid typed command rejected');
}equal(events.length,1,'invalid commands never dispatch');
const wiki=decodeContentChange('workspace:W',{kind:'wiki'},undefined,{operationId:op,body:''});await work.changeContent(wiki);equal(events[1],wiki,'blank Wiki body and scope retained');
assert.throws(()=>decodeContentChange('P',{kind:'comment',parentKind:'issue',parentId:id},undefined,{operationId:op,body:''}));checks++;
assert.throws(()=>decodeIssueChange('P',undefined,{operationId:op,body:''}));checks++;
equal(decodeLegacyReference('/projects/PRJ/issues/12/old-title'),{kind:'issue-number',projectKey:'PRJ',number:12},'legacy protocol decoded before application');
assert.throws(()=>decodeLegacyReference('/wiki/%ZZ'));checks++;
for(const source of ['committed','recovered']){
 const receipt={operationId:op,snapshot:{id}};next={application:'confirmed',disclosure:'allowed',source,receipt};equal(await work.changeIssue(command),next,'receipt provenance propagated');
}
for(const [error,kind] of [[new MutationError(401,'unauthenticated'),'unauthenticated'],[new MutationError(403,'forbidden'),'forbidden']]){
 const result=await observeChange(op,async()=>{const protectedCommittedSnapshot={body:'private'};void protectedCommittedSnapshot;throw error;});
 equal(result,{application:'unknown',disclosure:'denied',operationId:op,failure:{kind,code:error.code}},'postcommit read denial cannot return protected result or imply rollback');
}
const certificate={operationId:op,status:'not_applied',phase:'pre_dispatch'};
const denial=new MutationError(403,'forbidden',undefined,undefined,certificate);
equal(failedChange(op,denial),{application:'not_applied',disclosure:'withheld',certificate,failure:{kind:'forbidden',code:'forbidden'}},'only explicit matching attempt certificate is retained');
equal(failedChange('different',denial).application,'unknown','certificate for other attempt is unusable');
for(const error of [new Error('timeout'),new MutationError(404,'operation_not_found'),new MutationError(503,'mutation_unavailable')])equal(failedChange(op,error).application,'unknown','exception/absence never proves no commit');
const current={reports:[{id:'report-current'}]};equal(failedChange(op,new MutationError(409,'precondition_conflict','revision_conflict',current)),{application:'unknown',disclosure:'allowed',operationId:op,failure:{kind:'conflict',code:'precondition_conflict',reason:'revision_conflict'},authorizedCurrent:current},'authorized current may differ from receipt snapshot type');
equal(await observeResult(op,async()=>{throw new MutationError(404,'operation_not_found');}),{status:'missing',operationId:op,application:'unknown',failure:{kind:'not_found',code:'operation_not_found'}},'missing result is not nonapplication');
equal((await observeResult(op,async()=>{throw new MutationError(403,'forbidden');})).status,'denied','denied result is not missing');
for(const [error,kind] of [[new InputError('invalid_input',{body:'invalid'}),'invalid'],[new ApiError(400,'invalid_input'),'invalid'],[new ApiError(429,'login_limited'),'rate_limited'],[new MutationError(409,'operation_input_mismatch'),'input_mismatch'],[new MutationError(500,'mutation_failed'),'internal']])equal(failureOf(error).kind,kind,'failure semantics retained');
const inputs=[...appInputs,'src/adapters/d1/persistence/outcomes.ts','src/adapters/d1/persistence/public.ts','src/adapters/protocol-errors.ts'];
const report={status:'passed',checks,level:'pure rules and typed application/outcome boundaries',providerRequests:0,actualD1:false,applicationDependencies:appInputs,sourceHashes:Object.fromEntries(await Promise.all(inputs.map(async p=>[p,createHash('sha256').update(await readFile(p)).digest('hex')])))};
await writeFile(dir+'/result.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
