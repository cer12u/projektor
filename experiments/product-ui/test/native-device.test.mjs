// Focused public-data/owner-request contracts; these do not claim browser execution.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readPublicProposal,checkDeviceState,deviceApprovalInput,calendarExpiry,actionEvidence,checkReviewedAction} from '../src/native-device.mjs';
import {createAppAuth} from '../src/app-auth.mjs';
import {parseRoute} from '../src/router.ts';
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0'),now=Date.now(),origin='https://owner.test';
const state={principalId:id(1),allowedScopes:['issue:read','issue:write'],maxLifetimeMs:3600000,maxRedeemLifetimeMs:600000,grantGeneration:3,credentials:[{credentialId:id(2),principalId:id(1),scopes:['issue:read'],expiresAt:now+3600000,createdAt:now,revoked:false}],pairingGrants:[],devices:[]};
const proposal={grantId:id(3),credentialId:id(4),secretDigest:'a'.repeat(64),scopes:['issue:read'],expiresAt:now+600000,redeemExpiresAt:now+300000,expectedGeneration:3};
test('public proposal accepts exact bound metadata and rejects secret/token fields or another target',()=>{
 assert.deepEqual(readPublicProposal(JSON.stringify(proposal),state,origin,now),proposal);assert.deepEqual(readPublicProposal(JSON.stringify({origin,principalId:id(1),approval:proposal}),state,origin,now),proposal);
 for(const value of [{...proposal,secret:'private-preimage'},{...proposal,token:'pn1_private'},{origin:'https://other.test',principalId:id(1),approval:proposal},{origin,principalId:id(9),approval:proposal},{...proposal,expectedGeneration:2},{...proposal,scopes:['wiki:write']},{...proposal,redeemExpiresAt:now-1}])assert.throws(()=>readPublicProposal(JSON.stringify(value),state,origin,now));
});
test('duration is explicit, uses verified version, and until-revoked serializes exactly two null bounds',()=>{
 assert.throws(()=>checkDeviceState(state,{principalId:id(1)}),/METADATA/);
 const verified=checkDeviceState(state,{principalId:id(1),devices:[]}),unlimited=deviceApprovalInput(verified,id(2),{mode:'until-revoked',idleMinutes:'99',absoluteDate:'ignored'},now);
 assert.deepEqual(Object.keys(unlimited).sort(),['absoluteExpiresAt','credentialId','expectedVersion','idleTimeoutMs','operationId','untilRevoked'].sort());assert.equal(unlimited.untilRevoked,true);assert.equal(unlimited.idleTimeoutMs,null);assert.equal(unlimited.absoluteExpiresAt,null);assert.equal(unlimited.expectedVersion,0);
 const prior={credentialId:id(2),principalId:id(1),scopes:['issue:read'],version:7,idleTimeoutMs:null,absoluteExpiresAt:now+600000,untilRevoked:false,lastRefreshAt:now,revoked:false};const current=checkDeviceState(state,{principalId:id(1),devices:[prior]});
 const idle=deviceApprovalInput(current,id(2),{mode:'idle',idleMinutes:'7.5',absoluteDate:''},now);assert.equal(idle.expectedVersion,7);assert.equal(idle.idleTimeoutMs,450000);assert.equal(idle.absoluteExpiresAt,null);assert.equal(idle.untilRevoked,false);
 assert.throws(()=>deviceApprovalInput(current,id(2),{mode:'expires',idleMinutes:'',absoluteDate:''},now),/DURATION/);assert.throws(()=>deviceApprovalInput(current,id(2),{mode:'idle',idleMinutes:'0',absoluteDate:''},now),/DURATION/);assert.equal(calendarExpiry(Number.MAX_SAFE_INTEGER),'See the device approval duration');
});
test('lost reply status binds the actual operation and exact settings instead of treating any device as success',()=>{
 const input=deviceApprovalInput(state,id(2),{mode:'until-revoked',idleMinutes:'',absoluteDate:''},now),action={kind:'device/enable',input};const device={credentialId:id(2),version:1,idleTimeoutMs:null,absoluteExpiresAt:null,untilRevoked:true,revoked:false,operationId:input.operationId};
 assert.throws(()=>checkReviewedAction({...action,principalId:id(9),scopes:['issue:read']},state,origin,now),/TARGET_MISMATCH/);
 assert.equal(actionEvidence(action,{...state,devices:[device]}),'Device approval is recorded.');assert.equal(actionEvidence(action,{...state,devices:[{...device,version:2}]}),null);assert.equal(actionEvidence(action,{...state,devices:[{...device,operationId:id(9)}]}),'Current device approval matches the reviewed settings.');assert.equal(actionEvidence(action,{...state,devices:[{...device,revoked:true}]}),null);
});
test('owner transport fetches session CSRF, never offers token-producing actions and never retries a mutation',async()=>{
 const calls=[],session={principalId:id(8),credentialId:id(9),sessionId:id(10),authVersion:1,grantGeneration:1,expiresAt:now+600000,idleExpiresAt:now+3600000,absoluteExpiresAt:now+7200000};
 const auth=createAppAuth({baseUrl:origin,fetchImpl:async(url,options)=>{const path=new URL(url).pathname;calls.push({path,options});if(path.endsWith('/session'))return Response.json({session,csrfToken:'synthetic-owner-csrf'});assert.equal(options.headers['X-Projektor-Auth-CSRF'],'synthetic-owner-csrf');assert.equal(options.headers.Authorization,undefined);assert.equal(options.credentials,'same-origin');throw Error('synthetic lost mutation reply');}});
 for(const action of ['issue','pairing/redeem','device/refresh','../logout'])await assert.rejects(auth.nativeOwner(action,{}),/OWNER_ACTION_INVALID/);assert.equal(calls.length,0);
 await assert.rejects(auth.nativeOwner('device/enable',{credentialId:id(2)}),/AUTH_OUTCOME_UNKNOWN/);assert.deepEqual(calls.map(call=>call.path),['/v1/auth/session','/v1/auth/machine-credentials/device/enable']);
});
test('device route contains no proposal or credential material',()=>{
 assert.equal(parseRoute('/?view=devices').view,'devices');for(const key of ['secret','token','proposal','credentialId'])assert.throws(()=>parseRoute('/?view=devices&'+key+'=value'),/ROUTE_INVALID/);
});
