// @module identity
// @role private-assertion
import {type Configuration} from "../../modules/identity/rules";
export type {Configuration} from "../../modules/identity/rules";
import {validAccessIssuer} from './access-assertion';
/** Deployment pin and Cloudflare claim grammar are provider configuration, not domain rules. */
export function ownerConfiguration(raw:string):Configuration {
 const c=object(JSON.parse(raw) as unknown);
 if(typeof c.ownerId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(c.ownerId)||!validAccessIssuer(c.issuer)||typeof c.audience!=='string'||!/^[a-f0-9]{64}$/.test(c.audience)||typeof c.subject!=='string'||!/^[a-f0-9-]{36}$/.test(c.subject)||typeof c.closesAt!=='number'||!Number.isSafeInteger(c.closesAt)||Object.keys(c).some(k=>!['ownerId','issuer','audience','subject','closesAt'].includes(k)))throw new Error('invalid');
 return{ownerId:c.ownerId,issuer:c.issuer,audience:c.audience,subject:c.subject,closesAt:c.closesAt};
}
function object(v:unknown):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('invalid');return v as Record<string,unknown>;}
function decode(s:string):Uint8Array<ArrayBuffer>{if(!/^[A-Za-z0-9_-]+$/.test(s))throw new Error('invalid');return Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));}
function decoded(s:string){return object(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(decode(s))) as unknown);}
export type SetupStage='request'|'challenge'|'configuration'|'access_header'|'jwt_header'|'jwt_claims'|'jwks_fetch'|'jwks_body'|'jwks_key'|'key_import'|'signature'|'input'|'target'|'atomic_write'|'response';
export async function verifyOwner(token:string,c:Configuration,stage:(value:SetupStage)=>void=()=>{}):Promise<import("../../modules/identity/ports").VerifiedAssertion>{
 stage('configuration');c=ownerConfiguration(JSON.stringify(c));
 stage('jwt_header');
 if(token.length>16384)throw new Error('invalid');const parts=token.split('.');if(parts.length!==3)throw new Error('invalid');
 const header=decoded(parts[0]),claims=decoded(parts[1]),now=Math.floor(Date.now()/1000);
 stage('jwt_claims');
 if(header.alg!=='RS256'||typeof header.kid!=='string'||header.kid.length>256||header.crit!==undefined||claims.iss!==c.issuer||!Array.isArray(claims.aud)||claims.aud.length!==1||claims.aud[0]!==c.audience||claims.type!=='app'||claims.sub!==c.subject||typeof claims.email!=='string'||!claims.email||claims.common_name!==undefined||![claims.exp,claims.nbf,claims.iat].every(v=>typeof v==='number'&&Number.isSafeInteger(v))||Number(claims.exp)<=now||Number(claims.nbf)>now||Number(claims.iat)>now)throw new Error('invalid');
 stage('jwks_fetch');
 const response=await fetch(c.issuer+'/cdn-cgi/access/certs',{redirect:'manual',credentials:'omit',signal:AbortSignal.timeout(5000)});if(response.status!==200||!response.body)throw new Error('invalid');
 stage('jwks_body');
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>65536){await reader.cancel();throw new Error('invalid');}chunks.push(next.value);}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 const keys=object(JSON.parse(new TextDecoder().decode(bytes)) as unknown).keys;if(!Array.isArray(keys))throw new Error('invalid');
 stage('jwks_key');
 const matching=keys.map(v=>object(v)).filter(k=>k.kid===header.kid&&k.kty==='RSA'&&k.alg==='RS256'&&(k.use===undefined||k.use==='sig'));
 if(matching.length!==1)throw new Error('invalid');stage('key_import');const key=await crypto.subtle.importKey('jwk',matching[0],{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
 stage('signature');
 if(!await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,decode(parts[2]),new TextEncoder().encode(parts[0]+'.'+parts[1])))throw new Error('invalid');
 return{issuer:c.issuer,audience:c.audience,subject:c.subject,expiresAt:Number(claims.exp),notBefore:Number(claims.nbf)};
}
