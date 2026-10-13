// @module browser-session
// @role adapter
// A login challenge uses a shared HttpOnly cookie. Coordinate its rotation and
// the request using its CSRF value across all same-origin application tabs.
// Never publish the challenge or CSRF value to storage or other tabs.
export class LoginChallengeCoordinationUnavailable extends Error {
  constructor(){super('login_challenge_coordination_unavailable');}
}
export class LoginChallengePreparationError extends Error {
  constructor(cause:unknown){super('login_challenge_not_submitted',{cause});}
}
export function authPageCancelled(error:unknown):boolean{
  const cause=error instanceof LoginChallengePreparationError?error.cause:error;
  return cause instanceof Error&&cause.name==='AbortError'&&cause.message==='auth_page_left';
}
export type ChallengeRequest=<T>(path:string,options?:RequestInit)=>Promise<T>;
// Start this before waiting for either lock, so Back/navigation cancels queued work.
export async function duringAuthPage<T>(work:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  const controller=new AbortController(),cancel=()=>controller.abort(new DOMException('auth_page_left','AbortError'));
  window.addEventListener('pagehide',cancel,{once:true});
  try{return await work(controller.signal);}finally{window.removeEventListener('pagehide',cancel);}
}
export function coordinateLoginChallenge<T>(work:(signal:AbortSignal)=>Promise<T>,signal?:AbortSignal):Promise<T>{
  if(!signal)return duringAuthPage(current=>coordinateLoginChallenge(work,current));
  if(!navigator.locks)return Promise.reject(new LoginChallengeCoordinationUnavailable());
  // Separate from the session lock: login already holds that lock exclusively.
  return navigator.locks.request('projektor-login-challenge-v1',{mode:'exclusive',signal},async()=>{
    signal.throwIfAborted();
    return work(signal);
  });
}
export async function withLoginChallenge<T>(request:ChallengeRequest,work:(csrfToken:string,signal:AbortSignal)=>Promise<T>,signal?:AbortSignal):Promise<T>{
  let submitted=false;
  try{return await coordinateLoginChallenge(async current=>{
    const context=await request<{csrfToken:string}>('/api/auth/context');
    current.throwIfAborted();
    submitted=true;
    return work(context.csrfToken,current);
  },signal);}catch(error){if(!submitted)throw new LoginChallengePreparationError(error);throw error;}
}
export function prepareLoginChallenge(request:ChallengeRequest):Promise<string>{
  return withLoginChallenge(request,csrfToken=>Promise.resolve(csrfToken));
}
