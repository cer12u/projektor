import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBarrier,safePageLocation} from '../e2e/barrier.mjs';
test('missing expected request times out with bounded non-secret diagnostics',async()=>{
  const gate=createBarrier({label:'POST /commands',timeoutMs:15,diagnostics:()=>({location:safePageLocation('https://fixture.invalid/?view=issue&token=secret&draftId=private-id')})});
  const start=Date.now();await assert.rejects(gate.waitForRequest(),error=>/BARRIER_TIMEOUT.*expected-request/.test(error.message)&&error.message.includes('view=issue')&&!error.message.includes('secret')&&!error.message.includes('private-id'));
  assert.ok(Date.now()-start<500);gate.release();
});
test('response hold is bounded even if a scenario never releases it',async()=>{
  const gate=createBarrier({label:'GET /projects',timeoutMs:15});gate.enter();await gate.waitForRequest();await assert.rejects(gate.holdResponse(),/response-release/);gate.release();await gate.holdResponse();
});
test('normal entry/release and repeated cleanup leave no pending gate',async()=>{
  const gate=createBarrier({label:'normal',timeoutMs:50});const wait=gate.waitForRequest();gate.enter();gate.enter();await wait;
  const hold=gate.holdResponse();gate.release();gate.release();await hold;await gate.holdResponse();
  assert.equal(safePageLocation('not a URL'),'<unavailable>');
});
test('upstream request failures cannot echo a header/cookie even with a spoofed prefix',async()=>{
  const {gateFailureMessage}=await import('../e2e/barrier.mjs');
  for(const error of [new Error('Cookie: session=secret'),new Error('BARRIER_TIMEOUT Authorization: Bearer secret'),{message:'Set-Cookie: private'}]){
    assert.equal(gateFailureMessage(error),'GATE_REQUEST_FAILED: expected synthetic request/response was unavailable');
  }
});
test('timeout reporting is optional and cannot change a timeout into success',async()=>{
  let reports=0;const gate=createBarrier({label:'test label',timeoutMs:15,onTimeout(label,phase){reports++;assert.equal(label,'test label');assert.equal(phase,'expected-request');throw Error('reporting unavailable');}});
  await assert.rejects(gate.waitForRequest(),/BARRIER_TIMEOUT/);assert.equal(reports,1);gate.release();
});
