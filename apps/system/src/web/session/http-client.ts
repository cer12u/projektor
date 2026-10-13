// @module browser-session
// @role browser-transport
import {HttpError} from '../platform/index';
import {authorityObservation,authenticationLost,AuthorityChanged} from './identity-observation';
export async function request<T>(path:string,options:RequestInit={}):Promise<T>{
  if(!path.startsWith('/api/')||/[\\\u0000-\u0020\u007f]/.test(path))throw new Error('invalid_api_path');
  const protectedRead=(path==='/api/auth/me'||path==='/api/auth/logout')||(path.startsWith('/api/')&&!path.startsWith('/api/auth/')&&path!=='/api/health');
  const current=authorityObservation(),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  const fence=()=>{if(protectedRead&&!current())throw new AuthorityChanged();};
  try{
    const response=await fetch(path,{...options,credentials:'same-origin',redirect:'error',signal:controller.signal});
    fence();
    // Status is authoritative even if an edge returns HTML, an empty body or
    // malformed JSON. A token-revocation body cannot override the HTTP status.
    if(response.status===401){if(protectedRead)authenticationLost(current);throw new HttpError(401,'unauthenticated',undefined,undefined,undefined,{application:'unknown'});}
    let value:unknown;
    try{value=await response.json();}catch(error){fence();if(!response.ok)throw new HttpError(response.status,'request_failed');throw error;}
    fence();
    if(!response.ok){const v=value&&typeof value==='object'?value as {error?:string;fields?:Record<string,string>;current?:unknown;mutationOutcome?:unknown;operationId?:unknown;application?:unknown}:{};throw new HttpError(response.status,typeof v.error==='string'?v.error:'request_failed',v.fields,v.current,v.mutationOutcome,{operationId:typeof v.operationId==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v.operationId)?v.operationId:undefined,application:v.application==='unknown'?'unknown':undefined});}
    return value as T;
  }finally{clearTimeout(timer);}
}
