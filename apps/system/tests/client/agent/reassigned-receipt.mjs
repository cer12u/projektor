// @module verification
// @role reassigned-receipt
// Regression: a current assignee's confirmation may legitimately describe a former owner's attempt.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const out=resolve('.local/evidence/reassigned-receipt');await mkdir(out,{recursive:true});
const built=await build({entryPoints:['src/agent/operations.ts'],outfile:out+'/validator.mjs',bundle:true,platform:'browser',format:'esm',metafile:true});
const {verifyPreparedReceipt,agentOperationClient}=await import(out+'/validator.mjs');
const saved={operationId:'confirm-B',input:{attemptId:'old-attempt'},route:{kind:'report',projectId:'P',issueId:'I',action:'reconcile'},target:{kind:'execution-report.reconcile',projectId:'P',targetId:'I'}};
const evidence={issueId:'I',projectId:'P',attemptId:'old-attempt',principalId:'B',operationId:'confirm-B'};
const receipt={operationId:'confirm-B',source:'committed',snapshot:{confirmation:{...evidence},execution:{...evidence,principalId:'A'},importedReport:null}};
let checks=0;
for(const importedReport of [null,{...evidence}]){verifyPreparedReceipt(saved,{...receipt,snapshot:{...receipt.snapshot,importedReport}},'B');checks++;}
for(const [section,field,value] of [['execution','issueId','other'],['execution','projectId','OTHER'],['execution','attemptId','other'],['confirmation','principalId','A'],['confirmation','attemptId','other'],['confirmation','operationId','other'],['importedReport','principalId','A'],['importedReport','attemptId','other']]){
 const wrong=structuredClone({...receipt,snapshot:{...receipt.snapshot,importedReport:{...evidence}}});wrong.snapshot[section][field]=value;
 assert.throws(()=>verifyPreparedReceipt(saved,wrong,'B'),/operation_response_mismatch/);checks++;
}
const restartSaved={...saved,operationId:'restart-B',input:{attemptId:'old-attempt',leaseVersion:2,confirmationOperationId:'confirm-B'},route:{...saved.route,action:'restart'}};
const restartReceipt={operationId:'restart-B',source:'committed',snapshot:{attempt:{...evidence,attemptId:'new-attempt',startOperationId:'restart-B'},confirmation:{...evidence,leaseVersion:2,newAttemptId:'new-attempt'}}};
verifyPreparedReceipt(restartSaved,restartReceipt,'B');checks++;
for(const [section,field,value] of [['confirmation','attemptId','unrelated-old'],['confirmation','operationId','different-confirmation'],['confirmation','leaseVersion',1],['confirmation','newAttemptId','unrelated-new'],['attempt','startOperationId','different-op'],['attempt','attemptId','unrelated-new']]){
 const wrong=structuredClone(restartReceipt);wrong.snapshot[section][field]=value;assert.throws(()=>verifyPreparedReceipt(restartSaved,wrong,'B'),/operation_response_mismatch/);checks++;
}
for(const action of ['progress','failed','completed']){
 const record={...saved,route:{...saved.route,action}},response={...receipt,snapshot:{...evidence}};
 verifyPreparedReceipt(record,response,'B');checks++;
 for(const field of ['attemptId','operationId']){assert.throws(()=>verifyPreparedReceipt(record,{...response,snapshot:{...evidence,[field]:'wrong'}},'B'),/operation_response_mismatch/);checks++;}
}
const future={sequence:1,operationId:'future',formatVersion:2,recorded:true,inputHash:'a'.repeat(64),route:{kind:'issue',projectId:'P',id:'I_'+'1'.repeat(64)},input:{operationId:'future'},target:{kind:'issue.edit',projectId:'P',targetId:'I_'+'1'.repeat(64)},requiredPermissions:['view','edit'],preparedAt:1,result:{status:'confirmed',snapshot:{id:'I_'+'1'.repeat(64)}}};
const summary=Object.fromEntries(['sequence','operationId','formatVersion','inputHash','target','preparedAt'].map(k=>[k,future[k]]));summary.result={status:'confirmed'};
const client=agentOperationClient(async path=>path.includes('?')?{operations:[summary],nextAfter:null}:future);
assert.equal((await client.get('future')).result.status,'confirmed');checks++;assert.equal((await client.list()).operations[0].formatVersion,2);checks++;
for(const formatVersion of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1]){const bad=agentOperationClient(async()=>({...future,formatVersion}));await assert.rejects(()=>bad.get('future'),/operation_response_invalid/);checks++;}
const sourceHashes=Object.fromEntries(await Promise.all(Object.keys(built.metafile.inputs).map(async p=>[p,createHash('sha256').update(await readFile(p)).digest('hex')])));
await writeFile(out+'/results.json',JSON.stringify({passed:true,checks,scope:'pure SDK receipt correlation; actual server reassignment tested separately',sourceHashes},null,2)+'\n');console.log(JSON.stringify({passed:true,checks}));
