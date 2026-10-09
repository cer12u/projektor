/** App-owned authentication only. Passwords, pairing secrets and CSRF tokens live
 * in browser memory; the opaque session is an HttpOnly cookie owned by the server.
 * A business request is never replayed by this module. */
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const fail=code=>Object.assign(Error(code),{code});
export const needsLogin=code=>['AUTH_REQUIRED','AUTH_UNAUTHENTICATED','UNAUTHENTICATED','SESSION_EXPIRED','SESSION_REVOKED','SESSION_AUTHORITY_CHANGED','SESSION_REPLAY_REJECTED','AUTHORITY_CHANGED','INVALID_SESSION'].includes(code);
const authority=['principalId','credentialId','sessionId','authVersion','grantGeneration','absoluteExpiresAt'];
export function randomSecret(){const bytes=crypto.getRandomValues(new Uint8Array(32));return {bytes,secret:btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'')};}
export async function createPairing(purpose){
 const {bytes,secret}=randomSecret();
 const fingerprint=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');bytes.fill(0);
 return {grantId:crypto.randomUUID(),secret,purpose,fingerprint};
}
export function validPassword(password){return typeof password==='string'&&password.isWellFormed()&&[...password].length>=15&&new TextEncoder().encode(password).length<=1024;}
export function sameAuthority(a,b){return !!a&&!!b&&authority.every(key=>a[key]===b[key]);}
/** Another tab may complete a legitimate login for this same account. Only a
 * fresh authenticated response can replace the session family; account authority
 * stays fixed and the caller must revalidate its workspace/resource/key access. */
export function canAdoptSession(previous,current){return sameAuthority(previous,current)||!!previous&&!!current&&previous.sessionId!==current.sessionId&&['principalId','credentialId','authVersion','grantGeneration'].every(key=>previous[key]===current[key]);}
function checkSnapshot(value){
 const s=value?.session;
 if(!s||!['principalId','credentialId','sessionId'].every(k=>uuid(s[k]))||!['authVersion','grantGeneration','expiresAt','idleExpiresAt','absoluteExpiresAt'].every(k=>Number.isSafeInteger(s[k])&&s[k]>0)||typeof value.csrfToken!=='string'||!value.csrfToken)throw fail('AUTH_PROTOCOL_ERROR');
 if(s.expiresAt>s.idleExpiresAt||s.idleExpiresAt>s.absoluteExpiresAt)throw fail('AUTH_PROTOCOL_ERROR');
 return {session:Object.fromEntries([...authority,'expiresAt','idleExpiresAt'].map(k=>[k,s[k]])),csrfToken:value.csrfToken};
}
export function createAppAuth({baseUrl=globalThis.location?.origin,fetchImpl=globalThis.fetch,deadlineMs=8000}={}){
 const base=new URL(baseUrl);if(!['http:','https:'].includes(base.protocol)||base.username||base.password||globalThis.location&&base.origin!==globalThis.location.origin)throw fail('CROSS_ORIGIN_ENDPOINT');
 let snapshot=null,flight=null,csrf=null,notified=false,pendingLogin=null,loginBusy=false;const listeners=new Set();
 const request=async(path,{body,token,signal}={})=>{
  const abort=new AbortController(),cancel=()=>abort.abort();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)abort.abort();
  const timer=setTimeout(cancel,deadlineMs);
  try{
   const response=await fetchImpl(new URL('/v1/auth/'+path,base),{method:body===undefined?'GET':'POST',credentials:'same-origin',redirect:'error',cache:'no-store',signal:abort.signal,headers:{Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json','X-Projektor-Auth-CSRF':token})},...(body===undefined?{}:{body:JSON.stringify(body)})});
   if(response.headers.get('content-type')?.split(';')[0].trim()!=='application/json')throw fail('AUTH_PROTOCOL_ERROR');
   const value=await response.json();if(!response.ok||value?.error)throw fail(typeof value?.error?.code==='string'?value.error.code:response.status===401?'AUTH_REQUIRED':'AUTH_UNAVAILABLE');return value;
  }catch(error){throw typeof error?.code==='string'?error:fail('AUTH_OUTCOME_UNKNOWN');}finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
 };
 const preCSRF=async()=>{const value=await request('csrf');if(typeof value.csrfToken!=='string'||!value.csrfToken||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=Date.now())throw fail('AUTH_PROTOCOL_ERROR');csrf=value;return csrf.csrfToken;};
 const session=async()=>checkSnapshot(await request('session'));
 const restore=({refresh=false}={})=>{
  if(flight)return flight;
  flight=(async()=>{
   const current=await session();if(snapshot&&!canAdoptSession(snapshot.session,current.session))throw fail('AUTHORITY_CHANGED');snapshot=current;
   if(current.session.idleExpiresAt<=Date.now()||current.session.absoluteExpiresAt<=Date.now())throw fail('AUTH_REQUIRED');
   if(refresh||current.session.expiresAt<=Date.now()+30000){
    const expected=Object.fromEntries(authority.map(k=>[k,current.session[k]]));
    try{const renewed=checkSnapshot(await request('refresh',{body:{operationId:crypto.randomUUID(),expected},token:current.csrfToken}));if(!sameAuthority(current.session,renewed.session))throw fail('AUTHORITY_CHANGED');snapshot=renewed;}
    catch(error){
     // A racing rotation/login in another tab or a lost refresh reply is
     // resolved by one fresh cookie/session read, never by a mutation replay.
     // Never repeat the refresh mutation or replay the interrupted business write.
     if(!['SESSION_ROTATION_RACE','AUTH_OUTCOME_UNKNOWN','AUTH_CSRF_REJECTED','SESSION_AUTHORITY_CHANGED'].includes(error.code))throw error;
     const observed=await session();if(!canAdoptSession(current.session,observed.session)||observed.session.expiresAt<=Date.now())throw fail('AUTH_REQUIRED');snapshot=observed;
    }
   }
   if(snapshot.session.expiresAt<=Date.now())throw fail('AUTH_REQUIRED');return snapshot.session;
  })().finally(()=>{flight=null;});return flight;
 };
 const loginReceipt=async()=>{
  if(!pendingLogin)throw fail('AUTH_LOGIN_NOT_PENDING');
  const value=await request('login-receipt',{body:pendingLogin,token:await preCSRF()});
  if(value.state==='not_observed')throw fail('AUTH_LOGIN_UNCONFIRMED');
  snapshot=checkSnapshot(value);pendingLogin=null;notified=false;return snapshot.session;
 };
 return {
  restore,loginReceipt,
  get loginPending(){return !!pendingLogin;},
  discardLogin(){pendingLogin=null;},
  async login(password){
   if(pendingLogin)throw fail('AUTH_LOGIN_PENDING');if(loginBusy)throw fail('AUTH_BUSY');loginBusy=true;
   try{
    const token=await preCSRF();const operationId=crypto.randomUUID(),{secret:retrySecret}=randomSecret();pendingLogin={operationId,retrySecret};
    try{snapshot=checkSnapshot(await request('login',{body:{password,...pendingLogin},token}));pendingLogin=null;}
    catch(error){if(!['AUTH_OUTCOME_UNKNOWN','AUTH_PROTOCOL_ERROR'].includes(error.code)){pendingLogin=null;throw error;}return await loginReceipt();}
    notified=false;return snapshot.session;
   }finally{loginBusy=false;}
  },
  /** Owner controls expose public metadata only; token-producing endpoints are excluded. */
  async nativeOwner(action,input,{signal}={}){
   if(!['list','pairing/approve','revoke','device/list','device/enable','device/revoke'].includes(action))throw fail('OWNER_ACTION_INVALID');
   try{
    const current=checkSnapshot(await request('session',{signal}));
    if(snapshot&&!canAdoptSession(snapshot.session,current.session))throw fail('AUTHORITY_CHANGED');snapshot=current;
    const value=await request('machine-credentials/'+action,{body:input,token:current.csrfToken,signal});
    if(!value?.data||typeof value.data!=='object'||Array.isArray(value.data))throw fail('AUTH_PROTOCOL_ERROR');return value.data;
   }catch(error){if(needsLogin(error.code)&&!notified){notified=true;queueMicrotask(()=>{for(const listener of listeners)listener();});}throw error;}
  },
  async logout(){
   let current;try{current=await session();}catch(error){if(!needsLogin(error.code))throw error;snapshot=null;notified=true;return;}
   if(snapshot&&!sameAuthority(snapshot.session,current.session))throw fail('AUTHORITY_CHANGED');
   await request('logout',{body:{},token:current.csrfToken});snapshot=null;notified=true;
  },
  async logoutStatus(){try{await session();return false;}catch(error){if(needsLogin(error.code)&&!['AUTHORITY_CHANGED','SESSION_AUTHORITY_CHANGED'].includes(error.code)){snapshot=null;return true;}throw error;}},
  async grantStatus(pair){return request('grants/status',{body:{grantId:pair.grantId,secret:pair.secret},token:await preCSRF()});},
  async grantReceipt(pair,operationId){return request('grants/receipt',{body:{grantId:pair.grantId,secret:pair.secret,operationId},token:await preCSRF()});},
  async completeGrant(pair,password,operationId){return request('grants/complete',{body:{grantId:pair.grantId,secret:pair.secret,password,operationId},token:await preCSRF()});},
  clear(){snapshot=null;csrf=null;pendingLogin=null;},
  confirmAccess(){notified=false;},
  subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
  async fetch(input,options){const response=await fetchImpl(input,options);if(response.status===401&&!notified){notified=true;queueMicrotask(()=>{for(const listener of listeners)listener();});}return response;},
 };
}
