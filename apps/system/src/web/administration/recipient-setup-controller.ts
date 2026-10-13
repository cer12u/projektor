// @module administration
// @role controller
import {useEffect,useRef,useState,type FormEvent} from 'react';
import type {RecipientSetupStatus} from '../../modules/identity/public';
import {request,withLoginChallenge} from '../session/access';
import {HttpError} from '../platform/index';
import {prepareRecipientContext,readRecipientSetup,completeRecipientSetup,abandonRecipientContext} from './recipient-setup-client';
import {loadRecipientMarker,saveRecipientContext,retainRecipientStatus,requireRecipientMarker,retireRecipientMarker,markRecipientAbandoned} from './recipient-setup-storage';
export function useRecipientSetupController(){
 const [initial]=useState(()=>{try{return {marker:loadRecipientMarker(),blocked:false};}catch{return {marker:null,blocked:true};}});
 const [requestId,setRequestId]=useState(initial.marker?.requestId??''),[status,setStatus]=useState<RecipientSetupStatus|null>(null),[ended,setEnded]=useState(!!initial.marker?.retirement),[busy,setBusy]=useState(false),[missingContext,setMissingContext]=useState(false),[confirmed,setConfirmed]=useState(false),[unknown,setUnknown]=useState(!!initial.marker&&!initial.marker.retirement),[message,setMessage]=useState(initial.blocked?'保持した設定依頼を読めません。保存先を確認し、管理者へ相談してください。新しい設定依頼は作りません。':'');
 const current=useRef(initial.marker?.requestId??''),writing=useRef(false),live=useRef(true);
 function apply(value:RecipientSetupStatus){if(!live.current||value.requestId!==current.current)return;setMissingContext(false);retainRecipientStatus(value);setStatus(value);setUnknown(false);setConfirmed(false);setMessage(value.state==='waiting'?'この依頼IDを管理者へ伝えてください。管理者が対象と用途を指定した後、状態を確認します。':value.state==='completed'?'パスワード設定の完了を確認しました。新しいパスワードでログインしてください。':'対象・用途・発行者を確認してください。間違っている場合は入力せず管理者へ相談してください。');}
 function failed(error:unknown){if(!live.current)return;setStatus(null);setConfirmed(false);setUnknown(!!current.current);setMessage(error instanceof HttpError&&error.status===403&&error.code==='recipient_setup_still_active'?'有効な未完了の設定依頼は終了できません。設定状態を確認し、元の依頼の対象・用途・発行者を確認して設定を続けてください。取消が必要な場合は管理者へ相談してください。':error instanceof HttpError&&[401,403].includes(error.status)?'この設定依頼を再開する権限を確認できません。管理者による取消・再設定が必要です。別の設定権を自動発行しません。':'設定状態を確認できません。元の依頼IDと操作情報を保持しています。新しい依頼を作らず、保存先と接続を確認して状態を再確認してください。');}
 async function run(work:()=>Promise<void>){if(writing.current||initial.blocked)return;writing.current=true;setBusy(true);setConfirmed(false);try{await work();}catch(error){failed(error);}finally{writing.current=false;if(live.current)setBusy(false);}}
 async function context(csrf:string,signal:AbortSignal,id?:string,replaceAbandonedId?:string){const value=await prepareRecipientContext(csrf,id,replaceAbandonedId);signal.throwIfAborted();if(!live.current)return null;saveRecipientContext(value,replaceAbandonedId);setEnded(false);current.current=value.requestId;setRequestId(value.requestId);return value.requestId;}
 async function recover(){const id=current.current;if(!id||missingContext||ended)return;await run(async()=>{requireRecipientMarker(id);setStatus(null);setUnknown(true);await withLoginChallenge(request,async(csrf,signal)=>{if(!await context(csrf,signal,id))return;apply(await readRecipientSetup(csrf,id));});});}
 async function begin(){if(current.current&&!ended){await recover();return;}await run(async()=>withLoginChallenge(request,async(csrf,signal)=>{
  // A marker from another tab always selects resume-only context. Fresh creation is explicit.
  const stored=loadRecipientMarker();const id=await context(csrf,signal,stored?.retirement?undefined:stored?.requestId,stored?.retirement?stored.requestId:undefined);if(!id)return;setUnknown(true);apply(await readRecipientSetup(csrf,id));
 }));}
 async function save(event:FormEvent<HTMLFormElement>){
  event.preventDefault();if(writing.current||!confirmed||unknown||status?.state!=='ready')return;
  const accepted=status,form=event.currentTarget,data=new FormData(form),entry=data.get('password'),password=typeof entry==='string'?entry:'';
  if(password!==data.get('confirm')){setMessage('確認用パスワードが一致していません。');return;}
  await run(async()=>{retainRecipientStatus(accepted,true);await withLoginChallenge(request,async(csrf,signal)=>{
   if(!await context(csrf,signal,accepted.requestId))return;
   // Refresh first: a prior completion may have succeeded, or this context may have lost authority.
   const latest=await readRecipientSetup(csrf,accepted.requestId);retainRecipientStatus(latest);signal.throwIfAborted();if(!live.current)return;if(latest.state==='completed'){apply(latest);form.reset();return;}if(latest.state!=='ready')throw new Error('recipient_binding_lost');
   try{apply(await completeRecipientSetup(csrf,accepted.requestId,{operationId:accepted.operationId,principalId:accepted.principalId,issuerId:accepted.issuerId,purpose:accepted.purpose,password}));form.reset();}
   catch(error){if(error instanceof HttpError&&[401,403].includes(error.status))throw error;setUnknown(true);apply(await readRecipientSetup(csrf,accepted.requestId));}
  });});
 }
 function retire(id:string,confirmedAbandonment=false){if(confirmedAbandonment)markRecipientAbandoned(id);else retireRecipientMarker(id);setEnded(true);current.current=id;setRequestId(id);setStatus(null);setUnknown(false);setConfirmed(false);setMissingContext(false);}
 async function abandon(){
  const id=current.current;if(!id||writing.current||!window.confirm('この設定依頼を終了します。未完了で有効な設定権が残る場合はサーバーが拒否します。終了後も新しい依頼は自動作成しません。続けますか？'))return;
  await run(async()=>{if(loadRecipientMarker()?.requestId!==id)throw new Error('recipient_context_changed');setStatus(null);setUnknown(true);await withLoginChallenge(request,async(csrf,signal)=>{
   const result=await abandonRecipientContext(csrf,id);signal.throwIfAborted();if(!live.current||current.current!==id)return;
   if(result.abandoned){retire(id,true);setMessage('元の設定contextの終了を確認しました。必要な場合だけ、新しい設定依頼を明示的に準備してください。');}
   else{setMissingContext(true);setMessage('元のブラウザ証明がありません。サーバー上の設定権が終了したかは確認できません。管理者へ元の依頼の取消を相談してください。端末の記録だけを終了する場合は、別の確認操作が必要です。');}
  });});
 }
 function retireMissing(){if(!missingContext||writing.current||!window.confirm('サーバー上の設定権の取消は確認できていません。端末の依頼記録だけを終了します。必要な取消は管理者へ依頼してください。続けますか？'))return;try{retire(current.current);setMessage('端末の依頼記録だけを終了しました。サーバーの取消を確認したとは扱いません。新しい依頼を始める場合は明示的に準備してください。');}catch(error){failed(error);}}
 useEffect(()=>{live.current=true;if(initial.marker&&!initial.marker.retirement)void recover();return()=>{live.current=false;};},[]);
 return {requestId,status,busy,ended,missingContext,abandon,retireMissing,confirmed,setConfirmed,unknown,message,blocked:initial.blocked,begin,recover,save};
}
