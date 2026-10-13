// @module administration
// @role controller
import {post} from './password-setup-client';
import {useEffect,useRef,useState,type FormEvent} from 'react';
import {request,prepareLoginChallenge,LoginChallengeCoordinationUnavailable,LoginChallengePreparationError} from '../session/access';
import {HttpError} from '../platform/index';
import type {Target} from './password-setup-contracts';
import {recipientKey,loadRecipientOperation,reserveRecipientOperation,requireRecipientOperation,matchesRecipient,type RecipientOperation} from './password-setup-storage';
interface Receipt {operationId:string;snapshot:{principalId:string;configured:boolean}}
export function usePasswordSetupController(){
 const [csrf,setCsrf]=useState(''),[right,setRight]=useState(''),[target,setTarget]=useState<Target|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[operation,setOperation]=useState(''),[unknown,setUnknown]=useState(false),[completed,setCompleted]=useState(false),[retry,setRetry]=useState(false);
 const writing=useRef(false),live=useRef(true),pending=useRef<{key:string;operation:RecipientOperation}|null>(null);
 useEffect(()=>{live.current=true;void prepare().catch(prepareFailed);return()=>{live.current=false;};},[]);
 function prepareFailed(error:unknown){if(!live.current)return;if(error instanceof LoginChallengePreparationError)error=error.cause;setCsrf('');setMessage(error instanceof LoginChallengeCoordinationUnavailable?'このブラウザではタブ間の認証操作を安全に調整できません。対応ブラウザで開いてください。':'接続できません。設定権はこの画面にだけ保持しています。接続を再準備してください。');}
 async function run(work:()=>Promise<void>){if(writing.current)return;writing.current=true;setBusy(true);setMessage('');try{await work();}finally{writing.current=false;if(live.current)setBusy(false);}}
 async function retryPrepare(){await run(async()=>{try{await prepare();}catch(error){prepareFailed(error);}});}
 async function prepare(){const csrfToken=await prepareLoginChallenge(request);if(live.current)setCsrf(csrfToken);return csrfToken;}
 function confirm(result:Receipt,id:string,principalId:string){
  if(result?.operationId!==id||result.snapshot?.principalId!==principalId||result.snapshot.configured!==true)throw new Error('invalid_setup_receipt');
  if(!live.current)return;setCompleted(true);setRight('');setUnknown(false);setRetry(false);setTarget(null);setMessage('元の操作の設定完了を確認しました。その操作で送信したパスワードでログインしてください。');
 }
 async function recoverFor(proof:string,key:string,saved:RecipientOperation){
  if(await recipientKey(proof)!==key)throw new Error('recipient_grant_changed');if(!live.current)return;
  requireRecipientOperation(key,saved.operationId,saved.principalId);
  try{confirm(await post<Receipt>('result',{setupRight:proof,operationId:saved.operationId}),saved.operationId,saved.principalId);return;}
  catch(error){
   if(!live.current)return;setUnknown(true);setRetry(false);setTarget(null);
   if(error instanceof HttpError&&[403,404].includes(error.status)){
    // A missing/denied result does not prove nonapplication. Only a fresh,
    // still-unconsumed grant context can enable an explicit same-ID attempt.
    try{const current=await post<Target>('context',{setupRight:proof});if(!matchesRecipient(saved,current))throw new Error('recipient_target_changed');
     if(live.current){setTarget(current);setRetry(true);setMessage('結果は未確認です。同じ設定権が利用可能なことを確認しました。再試行する場合は元のパスワードを再入力し、同じ操作IDで明示的に送信してください。');}return;
    }catch{if(live.current)setMessage('設定権または結果を確認できません。操作IDを保持し、自動再送しません。元の設定権を確認するか管理者に取消・再設定を依頼してください。');return;}
   }
   setMessage('結果を取得できません。操作IDを保持しています。元の設定権で結果を再確認してください。');
  }
 }
 async function open(event:FormEvent){event.preventDefault();const proof=right;await run(async()=>{
  setTarget(null);setRetry(false);setCompleted(false);
  try{const key=await recipientKey(proof);if(!live.current)return;const saved=loadRecipientOperation(key);
   if(saved){pending.current={key,operation:saved};setOperation(saved.operationId);setUnknown(true);await recoverFor(proof,key,saved);return;}
   const current=await post<Target>('context',{setupRight:proof});if(!live.current)return;
   pending.current=null;setOperation('');setUnknown(false);setTarget(current);
  }catch(error){if(live.current)setMessage(error instanceof HttpError&&error.status===403?'設定権が使えません。元の設定権を確認するか管理者に再設定を依頼してください。':'確認または保存先の読取りに失敗しました。パスワードを送信していません。');}
 });}
 async function save(event:FormEvent<HTMLFormElement>){
  event.preventDefault();if(writing.current||!target||unknown&&!retry)return;
  const form=event.currentTarget,data=new FormData(form),entry=data.get('password'),password=typeof entry==='string'?entry:'';
  if(password!==data.get('confirm')){setMessage('確認用パスワードが一致していません。');return;}
  const proof=right,current=target;
  await run(async()=>{
   let saved:RecipientOperation,key:string;
   try{key=await recipientKey(proof);
    if(pending.current){if(pending.current.key!==key)throw new Error('recipient_grant_changed');saved=requireRecipientOperation(key,pending.current.operation.operationId,current.principalId);if(!matchesRecipient(saved,current))throw new Error('recipient_target_changed');}
    else{const reserved=await reserveRecipientOperation(key,current);saved=reserved.operation;pending.current={key,operation:saved};setOperation(saved.operationId);setUnknown(true);
     if(!reserved.fresh){await recoverFor(proof,key,saved);return;}}
   }catch{if(live.current)setMessage('操作IDを端末に保持できないため、パスワードを送信していません。保存先を確認してください。');return;}
   if(!live.current)return;setRetry(false);
   try{confirm(await post<Receipt>('complete',{setupRight:proof,operationId:saved.operationId,password}),saved.operationId,saved.principalId);form.reset();}
   catch(error){if(!live.current)return;setUnknown(true);setTarget(null);
    if(error instanceof LoginChallengePreparationError)prepareFailed(error);
    else setMessage('完了を確認できません。操作IDを保持しています。元の設定権で結果を確認するまで送信を繰り返しません。');}
  });
 }
 async function recover(){const saved=pending.current,proof=right;if(!saved||!proof)return;await run(async()=>{try{await recoverFor(proof,saved.key,saved.operation);}catch{if(live.current)setMessage('保持した操作IDを確認できません。新しい操作を送信しません。');}});}
 return {csrf,right,setRight,target,busy,message,operation,unknown,completed,retry,retryPrepare,open,save,recover};
}
