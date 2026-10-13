// @module browser-session
// @role controller
import {useCallback,useEffect,useRef,useState} from 'react';
import type {Identity} from "../../modules/identity/dto";
import type {SessionConsumer,LoginInput,AppSessionModel} from './session-contracts';
import {withLoginChallenge,prepareLoginChallenge,duringAuthPage,authPageCancelled} from './login-challenge';
import {sessionChange} from './session-coordination';
import {identityObservation,invalidateIdentityObservations,recordIdentity,onAuthenticationLost} from './identity-observation';
import {jsonRequest,requestIdentity,requestLogin,requestLogout} from './session-client';
export function useAppSession():AppSessionModel{

  const [identity,setIdentity]=useState<Identity|null>(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false);
  const [csrf,setCsrf]=useState(''),[message,setMessage]=useState('');
  const editor=useRef<SessionConsumer|null>(null),authEvents=useRef<BroadcastChannel|null>(null),identityRef=useRef<Identity|null>(null),authChanging=useRef(false);
  const attach=useCallback((e:SessionConsumer|null)=>{editor.current=e;},[]);
  const applyIdentity=useCallback((i:Identity|null)=>{if(identityRef.current?.principal.id!==i?.principal.id){invalidateIdentityObservations();editor.current?.dispose();}identityRef.current=i;recordIdentity(i);setIdentity(old=>JSON.stringify(old)===JSON.stringify(i)?old:i);},[]);
  const identityChanged=useCallback((i:Identity)=>{if(authChanging.current)return;const changed=identityRef.current?.principal.id!==i.principal.id;applyIdentity(i);if(changed)setMessage('認証主体が変わったため、その主体の作業領域へ切り替えました。');},[applyIdentity]);
  const prepareLogin=useCallback(async()=>{setCsrf(await prepareLoginChallenge(jsonRequest));},[]);
  const reauth=useCallback(()=>{invalidateIdentityObservations();applyIdentity(null);setMessage('セッションが失効しました。入力は認証主体ごとに保持しています。ログインしてください。');void prepareLogin().catch(()=>setMessage('接続できません。再読込してログインしてください。'));},[prepareLogin,applyIdentity]);
  useEffect(()=>onAuthenticationLost(reauth),[reauth]);
  useEffect(()=>{
    let live=true;
    async function check(hide=false){if(authChanging.current)return;if(hide){invalidateIdentityObservations();applyIdentity(null);setCsrf('');}const current=identityObservation();try{const i=await requestIdentity();if(live&&current()&&!authChanging.current)applyIdentity(i);}catch(e){if(!live||!current()||authChanging.current)return;if(e instanceof Error&&e.message==='401'){applyIdentity(null);await prepareLogin();}else setMessage('接続できません。入力は端末に保持しています。');}}
    void check().finally(()=>{if(live)setLoading(false);});
    if(typeof BroadcastChannel!=='undefined'){const c=new BroadcastChannel('projektor-auth-events');authEvents.current=c;c.onmessage=()=>void check(true);}
    const focus=()=>void check();window.addEventListener('focus',focus);
    return()=>{live=false;authEvents.current?.close();window.removeEventListener('focus',focus);};
  },[prepareLogin,applyIdentity]);
  async function login(input:LoginInput,clearInput:()=>void){
    authChanging.current=true;invalidateIdentityObservations();setBusy(true);setMessage('');
    try{const i=await duringAuthPage(signal=>sessionChange(async()=>{await withLoginChallenge(jsonRequest,fresh=>requestLogin(input,fresh),signal);return requestIdentity();}));clearInput();invalidateIdentityObservations();applyIdentity(i);authEvents.current?.postMessage({kind:'changed'});setMessage('');}
    catch(e){if(authPageCancelled(e))return;const code=e instanceof Error?e.message:'';setMessage(code==='401'?'IDまたはパスワードを確認してください。':code==='429'?'ログイン試行が多すぎます。15分後にお試しください。':code==='503'?'認証処理が混み合っています。少し待ってお試しください。':'ログインできませんでした。再度お試しください。');await prepareLogin().catch(()=>setCsrf(''));}finally{invalidateIdentityObservations();recordIdentity(identityRef.current);authChanging.current=false;setBusy(false);}
  }
  async function logout(){authChanging.current=true;invalidateIdentityObservations();setBusy(true);try{await editor.current?.flush();await sessionChange(async()=>{await requestLogout(identity?.csrfToken??'');});invalidateIdentityObservations();applyIdentity(null);setMessage('');authEvents.current?.postMessage({kind:'changed'});await prepareLogin();}catch{setMessage('ログアウトできませんでした。再度お試しください。');}finally{invalidateIdentityObservations();recordIdentity(identityRef.current);authChanging.current=false;setBusy(false);}}

 return {identity,loading,busy,ready:!!csrf,message,attach,identityChanged,prepareLogin:()=>void prepareLogin().catch(()=>setMessage('ログインを準備できません。接続を確認してください。')),reauth,login,logout};
}
