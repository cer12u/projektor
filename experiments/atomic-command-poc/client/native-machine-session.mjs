// Short access leases over the already-approved private device provider. Never
// returns a bearer from status(); getToken is for an in-process transport only.
import {randomUUID} from 'node:crypto';
const fail=code=>Object.assign(new Error(code),{code});
export function createRenewingMachineProvider({provider,origin,fetchImpl=globalThis.fetch,renewBeforeMs,deadlineMs=10000,now=Date.now}){
 const base=new URL(origin);if(base.protocol!=='https:'||base.origin!==origin||!provider?.load||!provider?.install||!provider?.withExclusive||!Number.isSafeInteger(renewBeforeMs)||renewBeforeMs<0)throw fail('DEVICE_PROVIDER_CONFIG_INVALID');
 let flight=null;
 async function refresh(record){
  const pending=record.pendingRefresh,credentialId=record.approval.credentialId,proof='pn1_'+credentialId+'_'+record.secret,controller=new AbortController();let timer;
  try{return await Promise.race([(async()=>{const response=await fetchImpl(origin+'/v1/auth/machine-credentials/device/refresh',{method:'POST',headers:{authorization:'Bearer '+proof,'content-type':'application/json',accept:'application/json'},body:JSON.stringify({operationId:pending.operationId,expectedGeneration:pending.expectedGeneration}),credentials:'omit',redirect:'manual',cache:'no-store',signal:controller.signal});if(response.status>=300&&response.status<400)throw fail('DEVICE_REFRESH_REDIRECT');const body=await response.json();if(!response.ok)throw fail(typeof body.error?.code==='string'&&/^[A-Z_]+$/.test(body.error.code)?body.error.code:'DEVICE_REFRESH_UNAVAILABLE');return body.data??body;})(),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(fail('DEVICE_REFRESH_TIMEOUT'));},Math.min(10000,Math.max(1,deadlineMs)));})]);}catch(error){if(typeof error.code==='string'&&/^[A-Z_]+$/.test(error.code))throw error;throw fail('DEVICE_REFRESH_UNAVAILABLE');}finally{clearTimeout(timer);}
 }
 async function token(){
  // A bounded race reconciliation loop; no renewed human login or new credential.
  for(let attempt=0;attempt<3;attempt++){
   let record=await provider.load();if(!record||record.origin!==origin||!['prepared','installed'].includes(record.state))throw fail('DEVICE_PROVIDER_UNAVAILABLE');
   const credentialId=record.approval.credentialId;
   if(record.state==='installed'&&!record.pendingRefresh&&record.access?.expiresAt>now()+renewBeforeMs)return record.access.token;
   if(!record.pendingRefresh){record={...record,pendingRefresh:{operationId:randomUUID(),expectedGeneration:record.generation??0}};await provider.install(record);} // fsync before first HTTP
   const result=await refresh(record),current=await provider.load();
   if(!current||current.pendingRefresh?.operationId!==record.pendingRefresh.operationId)throw fail('DEVICE_REFRESH_SUPERSEDED');
   if(result?.credentialId!==credentialId||!Number.isSafeInteger(result.generation)||result.generation<record.pendingRefresh.expectedGeneration)throw fail('DEVICE_REFRESH_BINDING_MISMATCH');
   if(['settled','generation-conflict'].includes(result.state)){
    await provider.install({...current,generation:result.generation,pendingRefresh:null,access:null});continue; // Explicit zero-new-effect metadata settles the old attempt.
   }
   if(result.state!=='active'||result.principalId!==record.principalId||result.generation!==record.pendingRefresh.expectedGeneration+1||typeof result.accessToken!=='string'||!result.accessToken.startsWith('ps1_'+credentialId+'_')||!Number.isSafeInteger(result.expiresAt)||result.expiresAt<=now())throw fail('DEVICE_REFRESH_BINDING_MISMATCH');
   const installed={...current,state:'installed',generation:result.generation,pendingRefresh:null,access:{token:result.accessToken,expiresAt:result.expiresAt,approvalVersion:result.approvalVersion}};await provider.install(installed);return installed.access.token;
  }
  throw fail('DEVICE_REFRESH_RACE_LIMIT');
 }
 return Object.freeze({getToken(){if(flight)return flight;flight=provider.withExclusive(token).finally(()=>{flight=null;});return flight;},async status(){const r=await provider.load();return r?{credentialId:r.approval.credentialId,principalId:r.principalId,generation:r.generation??0,accessExpiresAt:r.access?.expiresAt??null,refreshPending:Boolean(r.pendingRefresh)}:{configured:false};}});
}
