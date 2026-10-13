// @module verification
// @role nonapplication-schema
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {readFile} from 'node:fs/promises';
const spec=JSON.parse(await readFile(new URL("../../../docs/openapi.json",import.meta.url)));
const ajv=new Ajv({strict:false,allErrors:true,validateSchema:false});ajv.addSchema({...spec,$id:'candidate'},'candidate');
const validator=(method,path,status)=>ajv.compile({$ref:'candidate#/paths/'+path.replaceAll('~','~0').replaceAll('/','~1')+'/'+method+'/responses/'+status+'/content/application~1json/schema'});
const post=validator('post','/api/projects/{projectId}/issues','403'),get=validator('get','/api/projects/{projectId}/issue-operations/{operationId}','403');
const proof={error:'forbidden',mutationOutcome:{operationId:'OP',status:'not_applied',phase:'pre_dispatch'}};
assert(post(proof),JSON.stringify(post.errors));assert(post({error:'forbidden'}));assert(get({error:'forbidden'}));assert(!get(proof));
for(const invalid of[{...proof,snapshot:{body:'private'}},{...proof,mutationOutcome:{...proof.mutationOutcome,status:'unknown'}},{...proof,mutationOutcome:{...proof.mutationOutcome,phase:'post_commit'}},{...proof,mutationOutcome:{status:'not_applied',phase:'pre_dispatch'}}])assert(!post(invalid));
const report=JSON.parse(await readFile(new URL("../../../.local/evidence/nonapplication-workerd.json",import.meta.url)));
assert.equal(report.passed,true,'runtime prerequisite must pass before schema validation');
const rejected=report.scenarios.find(x=>x.name==='initially_forbidden');assert(post(rejected.response));
for(const name of['postcommit_denied','final_receipt_denied','lost_ack_denied'])assert(post(report.scenarios.find(x=>x.name===name).response));
console.log('PASS current POST403 schema validates actual workerd marked/bare denials; rejects result-GET proof, wrong phases/status, missing operation ID and secret fields');
