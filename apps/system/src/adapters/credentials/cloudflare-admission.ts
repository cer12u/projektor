// @module adapter.cloudflare-admission
// @role adapter

export interface AccessServiceEnvelope{
 version:1; environment:'production'|'synthetic-local'; origin:string;
 applicationId:string; serviceTokenId:string; expiresAt:number;
 clientId:string; clientSecret:string;
}
export interface AccessServiceOptions{
 mode:'service-auth'; applicationId:string; serviceTokenId:string;
 loadCredential:()=>Promise<unknown>;
}
const uuid=/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/;
const fields=['version','environment','origin','applicationId','serviceTokenId','expiresAt','clientId','clientSecret'];
function serviceAuthHeaders(origin:string,environment:string,options:AccessServiceOptions){
 // Snapshot caller-owned configuration before any await or secret load.
 const {mode,applicationId,serviceTokenId,loadCredential}=options;
 if(mode!=='service-auth'||!uuid.test(applicationId)||!uuid.test(serviceTokenId)||typeof loadCredential!=='function')throw new Error('access_service_configuration_invalid');
 return async():Promise<Record<string,string>>=>{
  let raw:unknown;
  try{raw=await loadCredential();}catch{throw new Error('access_service_provider_unavailable');}
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('access_service_credential_invalid');
  const e=raw as AccessServiceEnvelope;
  if(Object.keys(e).some(k=>!fields.includes(k))||e.version!==1||e.environment!==environment||e.origin!==origin||e.applicationId!==applicationId||e.serviceTokenId!==serviceTokenId||!Number.isSafeInteger(e.expiresAt)||e.expiresAt<=Math.floor(Date.now()/1000)||typeof e.clientId!=='string'||!e.clientId.length||e.clientId.length>512||!/^[\x21-\x7e]+$/.test(e.clientId)||typeof e.clientSecret!=='string'||!e.clientSecret.length||e.clientSecret.length>1024||!/^[\x21-\x7e]+$/.test(e.clientSecret))throw new Error('access_service_credential_invalid');
  return {'CF-Access-Client-Id':e.clientId,'CF-Access-Client-Secret':e.clientSecret};
 };
}

/** Optional adapter. Core SDK sees only the origin-bound admission port. */
export function accessServiceAdmission(origin:string,environment:string,options:AccessServiceOptions):import("../../agent/public").RequestAdmission {
 const load=serviceAuthHeaders(origin,environment,options);
 return {async authorize(target){
  if(target.origin!==origin||target.environment!==environment)throw new Error('access_service_credential_invalid');
  return {headers:await load()};
 }};
}
