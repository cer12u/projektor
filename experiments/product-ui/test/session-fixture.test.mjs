import {test} from 'node:test';
import assert from 'node:assert/strict';
import {selectedFixtureSession} from '../e2e/session-fixture.mjs';
const workspaceId='00000000-0000-4000-8000-000000000001';
const other='00000000-0000-4000-8000-000000000002';
const url='https://fixture.invalid/v1/session';
test('fixture bridge requires exactly one selected workspace and never defaults to a sole membership',async()=>{
  let reads=0;
  for(const query of ['', '?workspaceId=', '?workspaceId='+other, '?workspaceId='+workspaceId+'&workspaceId='+workspaceId,'?workspaceId='+workspaceId+'&extra=1']){
    const result=await selectedFixtureSession({url:url+query,method:'GET',workspaceId,readVerifiedSession:async()=>{reads++;throw Error('must not read');}});
    assert.ok([400,403].includes(result.status));assert.ok(result.body.error);assert.equal(result.body.principalId,undefined);
  }
  assert.equal(reads,0);
});
test('fixture bridge preserves actual authenticated session fields without minting identity',async()=>{
  const body={workspaceId,workspaceEpoch:other,principalId:'verified-current-actor',sessionId:'verified-session',authzVersion:7,scopes:['issue:read'],expiresAt:123};
  let reads=0;const result=await selectedFixtureSession({url:url+'?workspaceId='+workspaceId,method:'GET',workspaceId,readVerifiedSession:async()=>{reads++;return {status:200,body};}});
  assert.equal(reads,1);assert.equal(result.status,200);assert.deepEqual(result.body,body);assert.notEqual(result.body,body);
});
test('authenticated response for a different workspace is rejected instead of rebound',async()=>{
  const result=await selectedFixtureSession({url:url+'?workspaceId='+workspaceId,method:'GET',workspaceId,readVerifiedSession:async()=>({status:200,body:{workspaceId:other,principalId:'other'}})});
  assert.equal(result.status,502);assert.equal(result.body.error.code,'FIXTURE_SESSION_BINDING_MISMATCH');assert.equal(result.body.principalId,undefined);
});
test('expired or denied fixture authentication remains denied without fallback',async()=>{
  for(const status of [401,403,503]){
    const denied={status,body:{error:{code:status===401?'AUTH_REQUIRED':status===403?'FORBIDDEN':'UNAVAILABLE'}}};
    const result=await selectedFixtureSession({url:url+'?workspaceId='+workspaceId,method:'GET',workspaceId,readVerifiedSession:async()=>denied});
    assert.deepEqual(result,denied);assert.equal(result.body.principalId,undefined);
  }
});
test('selected fixture bridge cannot turn a non-read method into a session',async()=>{
  const result=await selectedFixtureSession({url:url+'?workspaceId='+workspaceId,method:'POST',workspaceId,readVerifiedSession:async()=>{throw Error('not called');}});
  assert.equal(result.status,405);
});
test('HTML-looking successful body and redirect response never become a valid selected session',async()=>{
  const base={url:url+'?workspaceId='+workspaceId,method:'GET',workspaceId};
  const html=await selectedFixtureSession({...base,readVerifiedSession:async()=>({status:200,body:'<html>sign in</html>'})});
  assert.equal(html.status,502);assert.equal(html.body.workspaceId,undefined);
  const redirect=await selectedFixtureSession({...base,readVerifiedSession:async()=>({status:302,body:{error:{code:'REDIRECT'}}})});
  assert.equal(redirect.status,302);assert.equal(redirect.body.workspaceId,undefined);
});
