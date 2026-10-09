import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PREFIX,IDS,PHASES,STATES,authPhaseRecord,authPhase,WITNESS_PHASES,firstTabWitnessPhases} from '../e2e/auth-phases.mjs';
test('auth phase diagnostics emit only fixed IDs and states, never raw failure values',async()=>{
 assert.deepEqual(IDS,['H01','H02','H03']);assert.equal(new Set(PHASES).size,PHASES.length);assert.deepEqual(STATES,['start','pass','fail','timeout']);
 const marker='SYNTHETIC_PRIVATE_BODY_PASSWORD';assert.throws(()=>authPhaseRecord(marker,'signin','start'),{message:'INVALID_AUTH_PHASE'});assert.throws(()=>authPhaseRecord('H01',marker,'fail'),{message:'INVALID_AUTH_PHASE'});assert.throws(()=>authPhaseRecord('H01','signin',marker),{message:'INVALID_AUTH_PHASE'});
 const records=[],write=process.stdout.write;process.stdout.write=function(value){records.push(String(value));return true;};
 try{await assert.rejects(authPhase('H02','receipt_confirm',async()=>{throw Error(marker);}),error=>error.message===marker);}
 finally{process.stdout.write=write;}
 assert.equal(records.length,2);assert.deepEqual(records.map(line=>JSON.parse(line.slice(PREFIX.length))),[{id:'H02',phase:'receipt_confirm',state:'start'},{id:'H02',phase:'receipt_confirm',state:'fail'}]);assert.ok(records.every(line=>line.startsWith(PREFIX)&&!line.includes(marker)));
});

test('original-tab witnesses retain only allowlisted boolean and enum categories',()=>{
 const marker='SYNTHETIC_PRIVATE_ID_BODY';const output=firstTabWitnessPhases({peerSignal:true,visibility:'visible',root:'ready',editor:'draft_conflict',reads:{auth:true,bootstrap:true,session:true,key:true,issue:true},extra:marker});assert.ok(output.includes('witness_editor_draft_conflict'));assert.ok(output.every(value=>WITNESS_PHASES.includes(value)&&PHASES.includes(value)));assert.ok(!JSON.stringify(output).includes(marker));
 const unknown=firstTabWitnessPhases({peerSignal:marker,visibility:marker,root:marker,editor:marker,reads:{auth:marker}});assert.ok(unknown.includes('witness_peer_signal_unknown'));assert.ok(unknown.includes('witness_visibility_unknown'));assert.ok(unknown.includes('witness_root_unknown'));assert.ok(unknown.includes('witness_editor_unknown'));assert.ok(!JSON.stringify(unknown).includes(marker));
 assert.ok(firstTabWitnessPhases({}).includes('witness_peer_signal_unknown'));assert.ok(firstTabWitnessPhases({peerSignal:false}).includes('witness_peer_signal_missing'));
});
