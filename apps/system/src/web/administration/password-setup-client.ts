// @module administration
// @role transport
import {request} from '../session/access';
import {withLoginChallenge} from '../session/access';
export async function post<T>(path:string,input:unknown){return withLoginChallenge(request,fresh=>request<T>('/api/auth/password-setup/'+path,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json','X-CSRF-Token':fresh},body:JSON.stringify(input)}));}
