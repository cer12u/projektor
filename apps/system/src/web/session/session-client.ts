// @module browser-session
// @role transport
import {request} from './http-client';
import {HttpError} from '../platform/index';
export async function jsonRequest<T>(path:string,options?:RequestInit):Promise<T> {
  try{return await request<T>(path,options);}catch(error){if(error instanceof HttpError)throw new Error(String(error.status));throw error;}
}

import type {Identity} from "../../modules/identity/dto";
import type {LoginInput} from './session-contracts';
export const requestIdentity=()=>jsonRequest<Identity>('/api/auth/me');
export const requestLogin=(input:LoginInput,csrf:string)=>jsonRequest('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(input)});
export const requestLogout=(csrf:string)=>jsonRequest('/api/auth/logout',{method:'POST',headers:{'X-CSRF-Token':csrf}});
