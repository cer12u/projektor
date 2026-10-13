// @module browser-session
// @role controller
import {beginBrowserSession,finishBrowserSession} from './browser-session-client';
import {useEffect,useState,type FormEvent} from 'react';
import type {Identity} from "../../modules/identity/dto";
import {HttpError} from '../platform/index';
export function useBrowserSessionController(){
 const [nonce,setNonce]=useState(''),[csrf,setCsrf]=useState(''),[ticket,setTicket]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[identity,setIdentity]=useState<Identity|null>(null),[failed,setFailed]=useState(false);
 async function prepare(){setBusy(true);setTicket('');setNonce('');setFailed(false);try{const {nonce:value,csrf:fresh}=await beginBrowserSession();setCsrf(fresh);setNonce(value);setMessage('');}catch{setMessage('交換を準備できません。接続を確認して、もう一度準備してください。');setFailed(true);}finally{setBusy(false);}}
 useEffect(()=>{void prepare();},[]);
 async function redeem(event:FormEvent){event.preventDefault();setBusy(true);setMessage('');try{const current=await finishBrowserSession(nonce,ticket,csrf);if(current.principal.kind!=='agent')throw new Error('unexpected_subject');setIdentity(current);const channel=new BroadcastChannel('projektor-auth-events');channel.postMessage({kind:'changed'});channel.close();setNonce('');setCsrf('');}catch(error){setFailed(true);setMessage(error instanceof HttpError&&error.status===403?'引換券を使用できません。新しいnonceと引換券を取得してください。':'交換結果を確認できません。現在のセッションを確認するか、新しい交換を準備してください。');}finally{setTicket('');setBusy(false);}}
return {nonce,ticket,setTicket,busy,message,identity,failed,prepare,redeem};
}
