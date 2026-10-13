// @module administration
// @role controller
import {useCallback,useEffect,useRef,useState} from 'react';
import {HttpError} from '../platform/index';
import {SetupNotApplied,type ManagementClient} from './management-client';
import type {SetupMetadata,SetupReceipt,SetupSubmission} from './management-model';
export function useManagementSetupController({api,principalId,active,disabled,pendingOperation,onPendingOperation,onError,onLock}:{api:ManagementClient;principalId:string;active:boolean;disabled:boolean;pendingOperation:SetupSubmission|null;onPendingOperation:(value:SetupSubmission|null,expectedOperationId?:string)=>boolean;onError:(error:unknown)=>void;onLock?:(locked:boolean)=>void}){
 const [state,setState]=useState<SetupMetadata|null>(null),[busy,setBusy]=useState(false),[recipientRequestId,setRecipientRequestId]=useState(pendingOperation?.recipientRequestId??''),[message,setMessage]=useState(''),[operationId,setOperationId]=useState(pendingOperation?.operationId??''),[unknown,setUnknown]=useState(!!pendingOperation);
 const live=useRef(true),writing=useRef(false),generation=useRef(0),scope=useRef({api,principalId}),current=useRef({api,principalId,active,disabled});
 current.current={api,principalId,active,disabled};
 const clear=useCallback(()=>{generation.current++;},[]);
 useEffect(()=>{live.current=true;const owner={api,principalId};scope.current=owner;clear();setState(null);void api.setupState(principalId).then(s=>{if(live.current&&scope.current===owner)setState(s);}).catch(error=>{if(live.current&&scope.current===owner){setMessage('設定権の状態を取得できません。');onError(error);}});return()=>{live.current=false;generation.current++;};},[api,principalId,onError,clear]);
 useEffect(()=>{
  const focus=()=>{clear();const owner=scope.current;void api.context().then(c=>{if(live.current&&scope.current===owner&&!c.globalAdministrator){clear();onError(new HttpError(403,'forbidden'));}}).catch(error=>{if(live.current&&scope.current===owner){clear();onError(error);}});};
  const visibility=()=>{if(document.hidden)clear();};
  const channel=typeof BroadcastChannel!=='undefined'?new BroadcastChannel('projektor-auth-events'):null;if(channel)channel.onmessage=clear;
  window.addEventListener('focus',focus);window.addEventListener('pagehide',clear);document.addEventListener('visibilitychange',visibility);
  return()=>{generation.current++;channel?.close();window.removeEventListener('focus',focus);window.removeEventListener('pagehide',clear);document.removeEventListener('visibilitychange',visibility);};
 },[api,onError,clear]);
 useEffect(()=>{if(pendingOperation&&!writing.current){setOperationId(pendingOperation.operationId);setUnknown(true);clear();}},[pendingOperation,clear]);
 useEffect(()=>{if(disabled||!active)clear();},[disabled,active,clear]);
 useEffect(()=>{onLock?.(busy||unknown);return()=>onLock?.(false);},[busy,unknown,onLock]);
 useEffect(()=>{const warn=(e:BeforeUnloadEvent)=>{if(unknown||busy)e.preventDefault();};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[unknown,busy]);
 function received(receipt:SetupReceipt,purpose:'initial'|'reset'|null){setState(receipt.snapshot);if(!onPendingOperation(null,receipt.operationId)){setUnknown(true);setMessage('操作結果は確認しましたが、保持情報を更新できません。再発行せず保存状態を確認してください。');return;}setUnknown(false);setMessage(purpose?'発行結果を確認しました。本人が元のブラウザで設定状態を確認し、対象・用途・発行者を確認して完了してください。秘密の受渡しはありません。':'設定権の取消結果を確認しました。');}
 async function change(purpose:'initial'|'reset'|null){
  if(!state||disabled||busy||unknown||pendingOperation||writing.current||!active||document.hidden)return;
  const requestId=recipientRequestId.trim();if(purpose&&!/^[A-Za-z0-9_-]{1,128}$/.test(requestId)){setMessage('本人が元のブラウザで準備した依頼IDを入力してください。');return;}
  const label=purpose===null?'未使用の設定権を取り消す':purpose==='initial'?'初回設定権を発行する':'再設定権を発行する';if(!window.confirm(`固定主体ID: ${principalId}\n${purpose?`本人の依頼ID: ${requestId}\n`:""}${label}操作です。既存の未使用設定権は取り消されます。続けますか？`))return;
  const id=crypto.randomUUID(),submission:SetupSubmission={actorId:api.owner,principalId,operationId:id,revision:state.revision,purpose,...(purpose?{recipientRequestId:requestId}:{})};
  if(!onPendingOperation(submission)){setMessage('操作IDを保持できないため送信しません。保存先を確認してください。');return;}
  writing.current=true;setBusy(true);setUnknown(true);clear();const ticket=generation.current,owner=scope.current;setOperationId(id);
  const sameOwner=()=>live.current&&scope.current===owner&&current.current.api===api&&current.current.principalId===principalId;
  try{
   const receipt=await api.changeSetup(principalId,state.revision,id,purpose,requestId);if(!sameOwner())return;
   // Do not repaint metadata after a newer identity or page lifecycle invalidation.
   if(ticket!==generation.current||document.hidden||!current.current.active||current.current.disabled)return;
   received(receipt,purpose);
  }catch(error){
   if(error instanceof SetupNotApplied){
    // Clear only this exact non-secret marker even when identity change already unmounted us.
    const cleared=onPendingOperation(null,id);if(!sameOwner())return;clear();
    if(cleared){setUnknown(false);setOperationId('');setMessage('この操作は未送信、またはサーバーが不採用と確認しました。現在の状態を再確認してください。');}
    else{setUnknown(true);setMessage('不採用は確認しましたが、保持情報を更新できません。新しい操作は送信しません。');}
    onError(error.original);try{const latest=await api.setupState(principalId);if(sameOwner())setState(latest);}catch{/* Retain no secret and report existing authority failure. */}
   }else{if(!sameOwner())return;clear();setUnknown(true);setMessage('設定権操作の結果は未確認です。元の実行主体で再ログインし、この操作IDの結果を確認してください。結果が見つからない間は新しい操作を送信しません。');onError(error);}
  }
  finally{writing.current=false;if(sameOwner())setBusy(false);}
 }
 async function recover(){if(busy||writing.current||!pendingOperation||pendingOperation.actorId!==api.owner||pendingOperation.principalId!==principalId)return;const owner=scope.current;setBusy(true);clear();try{const receipt=await api.setupResult(pendingOperation.operationId,pendingOperation.principalId);if(live.current&&scope.current===owner)received(receipt,pendingOperation.purpose);}catch(error){if(live.current&&scope.current===owner){onError(error);setMessage('結果を確認できません。新しい設定権を自動発行しません。');}}finally{if(live.current&&scope.current===owner)setBusy(false);}}
return {principalId,active,disabled,state,busy,recipientRequestId,setRecipientRequestId,message,operationId,unknown,clear,change,recover};
}
