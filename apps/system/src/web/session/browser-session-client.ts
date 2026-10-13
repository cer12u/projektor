// @module browser-session
// @role transport
import type {Identity} from "../../modules/identity/dto";
import {request} from './http-client';
import {newNonce} from './browser-nonce';
import {withLoginChallenge,coordinateLoginChallenge,duringAuthPage} from './login-challenge';
import {sessionChange} from './session-coordination';
export async function beginBrowserSession(){
 const nonce=newNonce();
 const csrf=await withLoginChallenge(request,async token=>{await request('/api/auth/browser-session/context',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':token},body:JSON.stringify({nonce})});return token;});
 return {nonce,csrf};
}
export function finishBrowserSession(nonce:string,ticket:string,csrf:string){
 return duringAuthPage(signal=>sessionChange(async()=>{await coordinateLoginChallenge(()=>request('/api/auth/browser-session/redeem',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({nonce,ticket})}),signal);return request<Identity>('/api/auth/me');}));
}
