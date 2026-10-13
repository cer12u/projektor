// @module browser-session
// @role authority
import type{Identity}from"../../modules/identity/dto";
// Observation ordering and authority lifetime are separate. Concurrent identity
// reads may supersede one another without invalidating every protected request.
let generation=0,authorityEpoch=0;let observed:Identity|null|undefined;
const lostListeners=new Set<()=>void>(),authorityListeners=new Set<()=>void>();
function advanceAuthority(){authorityEpoch++;for(const listener of authorityListeners)listener();}
export function onAuthorityChanged(listener:()=>void){authorityListeners.add(listener);return()=>{authorityListeners.delete(listener);};}
export class AuthorityChanged extends Error {constructor(){super('authority_changed');}}
export function invalidateIdentityObservations(){generation++;observed=undefined;advanceAuthority();}
export function identityObservation(){const current=++generation;return()=>current===generation;}
export function authorityObservation(){const current=authorityEpoch;return()=>current===authorityEpoch;}
export function recordIdentity(identity:Identity|null){
 // Includes same-principal session/CSRF/source replacement and permission changes.
 // The comparison stays in memory; no credential data is logged or persisted.
 const changed=JSON.stringify(observed)!==JSON.stringify(identity);observed=identity;if(changed)advanceAuthority();
}
export function latestIdentity(){return observed;}
export function onAuthenticationLost(listener:()=>void){lostListeners.add(listener);return()=>{lostListeners.delete(listener);};}
export function authenticationLost(current:()=>boolean):boolean{
 if(!current())return false;
 invalidateIdentityObservations();observed=null;
 for(const listener of lostListeners)listener();
 return true;
}

// Credential continuity is distinct from permission-only authority changes.
// The compared principal/session/CSRF/source tuple never crosses the public port.
function credentialIdentity(){
 const identity=observed;
 return identity?JSON.stringify([identity.principal.id,identity.authentication,identity.csrfToken,(identity as typeof identity&{sessionSource?:unknown}).sessionSource]):null;
}
export function captureCredentialLease():()=>boolean {
 const captured=credentialIdentity();return()=>credentialIdentity()===captured;
}
