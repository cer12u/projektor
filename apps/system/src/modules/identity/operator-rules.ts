// @module identity
// @role domain-rules
import {IdentityError} from './outcomes';
import {isPermission,type ProjectRights} from './rules';
import type {OperatorContext,CredentialProvision} from './operator-contracts';
const invalid=(code='invalid_deployment_input')=>new IdentityError('invalid',code);
function id(value:unknown){if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(value))throw invalid();return value;}
export function operatorContext(context:OperatorContext):OperatorContext{
 id(context.operatorId);id(context.operationId);if(!['production','synthetic-local'].includes(context.environment)||Object.keys(context).some(k=>!['operatorId','operationId','environment'].includes(k)))throw invalid('invalid_deployment_environment');return{...context};
}
function rights(value:ProjectRights[]):ProjectRights[]{
 if(!Array.isArray(value)||value.length>64)throw invalid('invalid_deployment_rights');const seen=new Set<string>();
 return value.map(v=>{if(!v||typeof v.projectId!=='string'||Object.keys(v).some(k=>!['projectId','permissions'].includes(k))||!(/^[A-Za-z0-9_-]{1,128}$/.test(v.projectId)||/^workspace:[a-fA-F0-9-]{36}$/.test(v.projectId))||seen.has(v.projectId)||!Array.isArray(v.permissions)||v.permissions.length>6||v.permissions.some(p=>!isPermission(p))||new Set(v.permissions).size!==v.permissions.length||(v.permissions.length&&!v.permissions.includes('view')))throw invalid('invalid_deployment_rights');seen.add(v.projectId);return{projectId:v.projectId,permissions:[...v.permissions].sort()};}).sort((a,b)=>a.projectId.localeCompare(b.projectId));
}
export function credentialProvision(raw:CredentialProvision):CredentialProvision{
 if(Object.keys(raw).some(k=>!['principalId','credentialId','authVersion','expiresAt','scopes'].includes(k)))throw invalid();const principalId=id(raw.principalId),credentialId=id(raw.credentialId),scopes=rights(raw.scopes);if(!Number.isSafeInteger(raw.authVersion)||raw.authVersion<1||!Number.isSafeInteger(raw.expiresAt))throw invalid('invalid_deployment_credential');return{principalId,credentialId,authVersion:raw.authVersion,expiresAt:raw.expiresAt,scopes};
}
export function credentialOrigin(origin:string,context:OperatorContext):string{
 let url:URL;try{url=new URL(origin);}catch{throw invalid('https_origin_required');}
 if((url.protocol!=='https:'&&!(context.environment==='synthetic-local'&&url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname)))||url.origin!==origin||url.username||url.password)throw invalid('https_origin_required');return origin;
}
/** Frozen deployment receipt fingerprint encoding; keeps prior operation identity compatible. */
export function operatorInput(value:unknown):string{
 const seen=new Set<object>();function visit(v:unknown,depth:number):string{
  if(depth>32)throw invalid('invalid_normalized_input');if(v===null||typeof v==='boolean'||typeof v==='string')return JSON.stringify(v);if(typeof v==='number'){if(!Number.isFinite(v))throw invalid();return JSON.stringify(v);}if(typeof v!=='object'||seen.has(v))throw invalid();seen.add(v);let encoded:string;
  if(Array.isArray(v)){for(let i=0;i<v.length;i++)if(!Object.hasOwn(v,i))throw invalid();encoded=`[${v.map(x=>visit(x,depth+1)).join(',')}]`;}
  else{if(Object.getPrototypeOf(v)!==Object.prototype&&Object.getPrototypeOf(v)!==null)throw invalid();encoded=`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${visit((v as Record<string,unknown>)[k],depth+1)}`).join(',')}}`;}
  seen.delete(v);return encoded;
 }const encoded=visit(value,0);if(new TextEncoder().encode(encoded).byteLength>16384)throw invalid('invalid_normalized_input');return encoded;
}
