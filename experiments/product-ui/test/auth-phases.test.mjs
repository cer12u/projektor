import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PREFIX,IDS,PHASES,STATES,authPhaseRecord,authPhase} from '../e2e/auth-phases.mjs';
test('auth phase diagnostics emit only fixed IDs and states, never raw failure values',async()=>{
 assert.deepEqual(IDS,['H01','H02','H03']);assert.equal(new Set(PHASES).size,PHASES.length);assert.deepEqual(STATES,['start','pass','fail','timeout']);
 const marker='SYNTHETIC_PRIVATE_BODY_PASSWORD';assert.throws(()=>authPhaseRecord(marker,'signin','start'),{message:'INVALID_AUTH_PHASE'});assert.throws(()=>authPhaseRecord('H01',marker,'fail'),{message:'INVALID_AUTH_PHASE'});assert.throws(()=>authPhaseRecord('H01','signin',marker),{message:'INVALID_AUTH_PHASE'});
 const records=[],write=process.stdout.write;process.stdout.write=function(value){records.push(String(value));return true;};
 try{await assert.rejects(authPhase('H02','receipt_confirm',async()=>{throw Error(marker);}),error=>error.message===marker);}
 finally{process.stdout.write=write;}
 assert.equal(records.length,2);assert.deepEqual(records.map(line=>JSON.parse(line.slice(PREFIX.length))),[{id:'H02',phase:'receipt_confirm',state:'start'},{id:'H02',phase:'receipt_confirm',state:'fail'}]);assert.ok(records.every(line=>line.startsWith(PREFIX)&&!line.includes(marker)));
});
