// @module browser-session
// @role adapter
// Coordinate only in-flight API requests and session changes across same-origin tabs.
// Draft editing never holds this lock. No password, cookie or body is broadcast.
export async function sessionRequest<T>(work:()=>Promise<T>):Promise<T>{
  if(!navigator.locks)return work();
  return navigator.locks.request('projektor-session-v1',{mode:'shared'},work);
}
export async function sessionChange<T>(work:()=>Promise<T>):Promise<T>{
  if(!navigator.locks)return work();
  return navigator.locks.request('projektor-session-v1',{mode:'exclusive'},work);
}
