/** Public owner-review data only. This module never accepts bearer/preimage fields. */
const id=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const fail=code=>{throw Object.assign(Error(code),{code});};
const scopes=['issue:read','issue:write','comment:write','history:read','operations:read_own','claim:write','progress:write','issue:transition','wiki:read','wiki:write'];
const validScopes=value=>Array.isArray(value)&&value.length>0&&value.length<=scopes.length&&new Set(value).size===value.length&&value.every(scope=>scopes.includes(scope));
const fingerprint=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
const proposalKeys=['grantId','credentialId','secretDigest','scopes','expiresAt','redeemExpiresAt','expectedGeneration'];
export function readPublicProposal(text,state,origin,now=Date.now()){
 if(typeof text!=='string'||new TextEncoder().encode(text).length>16384)fail('PUBLIC_PROPOSAL_REQUIRED');
 let value;try{value=JSON.parse(text);}catch{fail('PUBLIC_PROPOSAL_REQUIRED');}
 if(exact(value,['origin','principalId','approval'])){if(value.origin!==origin||value.principalId!==state.principalId)fail('PROPOSAL_TARGET_MISMATCH');value=value.approval;}
 if(!exact(value,proposalKeys)||!id(value.grantId)||!id(value.credentialId)||!fingerprint(value.secretDigest)||!validScopes(value.scopes)||!integer(value.expiresAt)||!integer(value.redeemExpiresAt)||!integer(value.expectedGeneration))fail('PUBLIC_PROPOSAL_REQUIRED');
 if(value.scopes.some(scope=>!state.allowedScopes.includes(scope))||value.scopes.includes('wiki:write')&&!value.scopes.includes('wiki:read')||value.scopes.some(scope=>['issue:write','comment:write','claim:write','progress:write','issue:transition'].includes(scope))&&!value.scopes.includes('issue:read'))fail('PROPOSAL_SCOPE_UNAVAILABLE');
 if(value.expiresAt<=now||value.expiresAt-now>state.maxLifetimeMs||value.redeemExpiresAt<=now||value.redeemExpiresAt>Math.min(value.expiresAt,now+state.maxRedeemLifetimeMs))fail('PROPOSAL_EXPIRED');
 if(value.expectedGeneration!==state.grantGeneration)fail('PROPOSAL_GENERATION_CHANGED');
 return structuredClone(value);
}
export function checkDeviceState(native,deviceList){
 if(!id(native?.principalId)||deviceList?.principalId!==native.principalId||!Array.isArray(native.allowedScopes)||native.allowedScopes.some(scope=>!scopes.includes(scope))||!integer(native.maxLifetimeMs)||!integer(native.maxRedeemLifetimeMs)||!integer(native.grantGeneration)||!Array.isArray(native.credentials)||!Array.isArray(native.pairingGrants)||!Array.isArray(deviceList.devices))fail('DEVICE_METADATA_INVALID');
 const bound=row=>id(row?.credentialId)&&row.principalId===native.principalId&&validScopes(row.scopes)&&typeof row.revoked==='boolean';
 if(native.credentials.some(row=>!bound(row)||!integer(row.expiresAt)||!integer(row.createdAt))||native.pairingGrants.some(row=>!bound(row)||!id(row.grantId)||!fingerprint(row.fingerprint)||!integer(row.expiresAt)||!integer(row.redeemExpiresAt)||!integer(row.generation)||typeof row.consumed!=='boolean')||deviceList.devices.some(row=>!bound(row)||!integer(row.version)||row.version<1||!integer(row.lastRefreshAt)||row.idleTimeoutMs!==null&&(!integer(row.idleTimeoutMs)||row.idleTimeoutMs<1000)||row.absoluteExpiresAt!==null&&!integer(row.absoluteExpiresAt)||typeof row.untilRevoked!=='boolean'||row.untilRevoked!==(row.idleTimeoutMs===null&&row.absoluteExpiresAt===null)||row.operationId!==undefined&&!id(row.operationId)))fail('DEVICE_METADATA_INVALID');
 for(const rows of [native.credentials,native.pairingGrants,deviceList.devices])if(rows.length>128||new Set(rows.map(row=>row.credentialId)).size!==rows.length)fail('DEVICE_METADATA_INVALID');
 return structuredClone({...native,devices:deviceList.devices});
}
export async function loadDeviceState(auth,{signal}={}){
 const [native,devices]=await Promise.all([auth.nativeOwner('list',{}, {signal}),auth.nativeOwner('device/list',{}, {signal})]);
 return checkDeviceState(native,devices);
}
export function deviceApprovalInput(state,credentialId,{mode,idleMinutes,absoluteDate},now=Date.now()){
 const credential=state.credentials.find(row=>row.credentialId===credentialId),prior=state.devices.find(row=>row.credentialId===credentialId);
 if(!credential||credential.revoked||prior?.revoked)fail('DEVICE_UNAVAILABLE');
 let idleTimeoutMs=null,absoluteExpiresAt=null;
 if(mode==='until-revoked'){}else if(mode==='expires'||mode==='idle'){
  if(idleMinutes!==''){const minutes=Number(idleMinutes);idleTimeoutMs=minutes*60000;if(!Number.isFinite(minutes)||!Number.isSafeInteger(idleTimeoutMs)||idleTimeoutMs<1000)fail('DEVICE_DURATION_INVALID');}
  if(mode==='idle'&&idleTimeoutMs===null)fail('DEVICE_DURATION_INVALID');
  if(mode==='expires'){absoluteExpiresAt=new Date(absoluteDate).getTime();if(!Number.isSafeInteger(absoluteExpiresAt)||absoluteExpiresAt<=now)fail('DEVICE_DURATION_INVALID');}
 }else fail('DEVICE_DURATION_INVALID');
 return {credentialId,operationId:crypto.randomUUID(),expectedVersion:prior?.version??0,idleTimeoutMs,absoluteExpiresAt,untilRevoked:mode==='until-revoked'};
}
export function calendarExpiry(value){
 if(value===null)return 'No fixed end date';
 if(!integer(value)||value>8640000000000000||value===Number.MAX_SAFE_INTEGER)return 'See the device approval duration';
 return new Date(value).toLocaleString(undefined,{timeZoneName:'short'});
}
export function approvalDuration(value){
 if(value.untilRevoked)return 'Until you revoke it; no idle or fixed expiry';
 return [value.absoluteExpiresAt===null?'No fixed end date':'Ends '+calendarExpiry(value.absoluteExpiresAt),value.idleTimeoutMs===null?'No idle limit':'Stops after '+(value.idleTimeoutMs/60000)+' minutes without refresh'].join(' · ');
}
export function actionEvidence(action,state){
 if(!action)return null;const input=action.input;
 if(action.kind==='pairing/approve'){const grant=state.pairingGrants.find(row=>row.grantId===input.grantId);return grant&&grant.credentialId===input.credentialId&&grant.fingerprint===input.secretDigest&&grant.expiresAt===input.expiresAt&&grant.redeemExpiresAt===input.redeemExpiresAt&&grant.generation===input.expectedGeneration+1&&JSON.stringify([...grant.scopes].sort())===JSON.stringify([...input.scopes].sort())&&!grant.revoked?'Pairing approval is recorded. The device can complete its own pairing.':null;}
 if(action.kind==='device/enable'){const device=state.devices.find(row=>row.credentialId===input.credentialId);if(device&&!device.revoked&&device.version===input.expectedVersion+1&&device.idleTimeoutMs===input.idleTimeoutMs&&device.absoluteExpiresAt===input.absoluteExpiresAt&&device.untilRevoked===input.untilRevoked)return device.operationId===input.operationId?'Device approval is recorded.':'Current device approval matches the reviewed settings.';return null;}
 if(action.kind==='device/revoke')return state.devices.find(row=>row.credentialId===input.credentialId)?.revoked?'Device access is revoked.':null;
 if(action.kind==='revoke')return state.credentials.find(row=>row.credentialId===input.credentialId)?.revoked||state.pairingGrants.find(row=>row.credentialId===input.credentialId)?.revoked?'Credential or pending pairing is revoked.':null;
 return null;
}

export function checkReviewedAction(action,state,origin,now=Date.now()){
 if(!action||action.principalId!==state?.principalId)fail('PROPOSAL_TARGET_MISMATCH');
 if(action.kind==='pairing/approve')return readPublicProposal(JSON.stringify(action.input),state,origin,now);
 const row=state.credentials.find(value=>value.credentialId===action.input.credentialId)??state.pairingGrants.find(value=>value.credentialId===action.input.credentialId);
 if(!row||row.revoked||JSON.stringify([...row.scopes].sort())!==JSON.stringify([...action.scopes].sort()))fail('DEVICE_UNAVAILABLE');
 if(action.kind==='device/enable'){const version=state.devices.find(value=>value.credentialId===row.credentialId)?.version??0;if(version!==action.input.expectedVersion)fail('DEVICE_APPROVAL_VERSION_CHANGED');if(action.input.absoluteExpiresAt!==null&&action.input.absoluteExpiresAt<=now)fail('DEVICE_DURATION_INVALID');}
 return structuredClone(action.input);
}
