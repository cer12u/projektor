// UI owner adapter/public helpers -> real HTTP entry/workerd/Store. No browser claim.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAppAuth} from '../src/app-auth.mjs';
import {readPublicProposal,loadDeviceState,deviceApprovalInput,actionEvidence} from '../src/native-device.mjs';
import {startNativeDeviceFixture} from '../e2e/native-device-fixture.mjs';
test('public owner client approves pairing, reads device metadata, explicitly enables and revokes through real HTTP',async t=>{
 const h=await startNativeDeviceFixture();t.after(()=>h.close());const calls=[];
 const auth=createAppAuth({baseUrl:h.origin,fetchImpl:async(url,init)=>{calls.push({path:new URL(url).pathname,body:init.body?JSON.parse(init.body):null});assert.equal(init.headers.Authorization,undefined);return h.ownerFetch(url,init);}});
 let state=await loadDeviceState(auth);assert.equal(state.principalId,h.ids.machine);assert.deepEqual(state.devices,[]);const input=readPublicProposal(JSON.stringify(h.proposal),state,h.origin);
 await auth.nativeOwner('pairing/approve',input);await h.redeem();state=await loadDeviceState(auth);assert.equal(state.credentials.length,1);assert.equal(state.credentials[0].credentialId,h.ids.machineCredential);
 const enable=deviceApprovalInput(state,h.ids.machineCredential,{mode:'until-revoked',idleMinutes:'',absoluteDate:''});await auth.nativeOwner('device/enable',enable);state=await loadDeviceState(auth);assert.equal(state.devices[0].operationId,enable.operationId);assert.equal(actionEvidence({kind:'device/enable',input:enable},state),'Device approval is recorded.');assert.equal(state.devices[0].untilRevoked,true);assert.equal(state.devices[0].absoluteExpiresAt,null);assert.equal(state.devices[0].idleTimeoutMs,null);
 await auth.nativeOwner('device/revoke',{credentialId:h.ids.machineCredential});state=await loadDeviceState(auth);assert.equal(state.devices[0].revoked,true);assert.equal(state.credentials[0].revoked,true);h.assertPublic({state,calls});assert.equal(calls.filter(call=>call.path.endsWith('/device/enable')).length,1);assert.ok(calls.every(call=>!call.path.endsWith('/issue')&&!call.path.endsWith('/pairing/redeem')&&!call.path.endsWith('/device/refresh')));
});
