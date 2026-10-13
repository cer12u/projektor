// @module identity
// @role private-assertion
import { createRemoteJWKSet,customFetch,errors,jwtVerify,type FetchImplementation,type RemoteJWKSet } from 'jose';
import type { AccessTrust,VerifiedAccessAssertion } from "../../modules/identity/access-policy";
import { ApiError } from "../protocol-errors";
export function validAccessIssuer(value:unknown):value is string{return typeof value==='string'&&/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(value);}
const ISSUANCE_SKEW_SECONDS=30;
/** JOSE owns protocol/crypto; this adapter only bounds its fixed, public-key HTTP fetch. */
export const boundedJwksFetch=(issuer:string):FetchImplementation=>async(url,options)=>{
 if(!validAccessIssuer(issuer)||url!==`${issuer}/cdn-cgi/access/certs`)throw new ApiError(503,'federation_keys_unavailable');
 const signal=AbortSignal.any([options.signal,AbortSignal.timeout(5000)]);
 const response=await fetch(url,{method:'GET',redirect:'manual',credentials:'omit',headers:{Accept:'application/json'},signal});
 if(response.status!==200||!response.body)throw new ApiError(503,'federation_keys_unavailable');
 const length=response.headers.get('Content-Length');
 if(length!==null&&(!/^\d+$/.test(length)||Number(length)>65536)){
  await response.body.cancel();throw new ApiError(503,'federation_keys_unavailable');
 }
 const type=response.headers.get('Content-Type')?.split(';')[0].trim();
 if(type!=='application/json'){await response.body.cancel();throw new ApiError(503,'federation_keys_unavailable');}
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try {
  for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;
   if(size>65536){await reader.cancel();throw new ApiError(503,'federation_keys_unavailable');}chunks.push(next.value);}
 } finally {reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 return new Response(bytes,{status:200,headers:{'Content-Type':'application/json'}});
};
// Only public signing keys are cached. No request, JWT, identity or DB authority is retained.
let publicKeys:{issuer:string;keys:RemoteJWKSet}|undefined;
function keys(issuer:string):RemoteJWKSet {
 if(publicKeys?.issuer!==issuer)publicKeys={issuer,keys:createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`),{
  timeoutDuration:5000,cacheMaxAge:600000,cooldownDuration:30000,[customFetch]:boundedJwksFetch(issuer),
 })};
 return publicKeys.keys;
}
export async function verifyAccessAssertion(token:string,config:AccessTrust,now:number):Promise<VerifiedAccessAssertion>{
 if(!validAccessIssuer(config.issuer)||!/^[a-f0-9]{64}$/.test(config.audience))throw new ApiError(503,'federation_configuration_invalid');
 if(!token||token.length>16384||!/^[-_A-Za-z0-9]+\.[-_A-Za-z0-9]+\.[-_A-Za-z0-9]+$/.test(token))throw new ApiError(401,'unauthenticated');
 let verified:Awaited<ReturnType<typeof jwtVerify>>;
 try {verified=await jwtVerify(token,keys(config.issuer),{issuer:config.issuer,audience:config.audience,
  algorithms:['RS256'],requiredClaims:['iss','aud','sub','exp','iat'],currentDate:new Date(now*1000),clockTolerance:0});}
 catch(error){
  if(error instanceof ApiError)throw error;
  if(error instanceof errors.JWTClaimValidationFailed||error instanceof errors.JWTExpired
    ||error instanceof errors.JWSInvalid||error instanceof errors.JWSSignatureVerificationFailed
    ||error instanceof errors.JWTInvalid||error instanceof errors.JOSEAlgNotAllowed
    ||error instanceof errors.JOSENotSupported||error instanceof errors.JWKSNoMatchingKey)
   throw new ApiError(401,'unauthenticated');
  throw new ApiError(503,'federation_keys_unavailable');
 }
 const {payload,protectedHeader}=verified;
 const audiences=typeof payload.aud==='string'?[payload.aud]:payload.aud;
 if(payload.type!=='app'||Object.hasOwn(payload,'common_name')||typeof payload.sub!=='string'||!payload.sub
   ||payload.sub.length>256||!audiences||audiences.length!==1||audiences[0]!==config.audience
   ||!Number.isSafeInteger(payload.exp)||!Number.isSafeInteger(payload.iat)||payload.exp!<=now
   ||payload.exp!<=payload.iat!||payload.iat!>now+ISSUANCE_SKEW_SECONDS
   ||(payload.nbf!==undefined&&(!Number.isSafeInteger(payload.nbf)||payload.nbf>now))
   ||protectedHeader.jku!==undefined||protectedHeader.x5u!==undefined||protectedHeader.jwk!==undefined)
  throw new ApiError(401,'unauthenticated');
 return {issuer:config.issuer,audience:config.audience,subject:payload.sub,expiresAt:payload.exp!,notBefore:payload.nbf??0};
}
