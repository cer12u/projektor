// @module administration
// @role controller
import {useEffect,useRef,useState,type FormEvent} from 'react';
import type {OwnerSetupStatus} from "../../modules/identity/public";
import {request,withLoginChallenge} from '../session/access';
import {HttpError} from '../platform/index';
import {prepareOwnerContext,issueOwnerSetup,readOwnerSetup,completeOwnerSetup} from './owner-setup-client';
import {loadOwnerOperation,reserveOwnerOperation,requireOwnerOperation} from './owner-setup-storage';

export function useOwnerSetupController(){
  const [initial]=useState(()=>{try{return {operation:loadOwnerOperation()??'',blocked:false};}catch{return {operation:'',blocked:true};}});
  const [operation,setOperation]=useState(initial.operation),[status,setStatus]=useState<OwnerSetupStatus|null>(null);
  const [busy,setBusy]=useState(false),[unknown,setUnknown]=useState(!!initial.operation),[canIssue,setCanIssue]=useState(false);
  const [message,setMessage]=useState(initial.blocked?'保持した初回設定操作を読めません。保存先を確認してください。設定を送信しません。':'');
  const current=useRef(initial.operation),principal=useRef(''),writing=useRef(false),live=useRef(true);
  function apply(value:OwnerSetupStatus,id:string){
    if(value.operationId!==id||(principal.current&&principal.current!==value.principalId))throw new Error('owner_setup_subject_changed');
    if(!live.current||current.current!==id)return;
    principal.current=value.principalId;setStatus(value);setUnknown(false);setCanIssue(false);
    setMessage(value.state==='completed'?'設定の完了を確認しました。新しいパスワードでログインしてください。':'同じ初回設定操作を確認しました。');
  }
  function failed(error:unknown){
    if(!live.current)return;setStatus(null);setUnknown(!!current.current);setCanIssue(false);
    setMessage(error instanceof HttpError&&[401,403].includes(error.status)?'設定を再開する権限を確認できません。新しい設定権を自動発行せず、管理者による取消・再設定を依頼してください。':current.current?'初回設定の状態を確認できません。操作IDを保持しています。送信を繰り返さず、状態を再確認してください。':'初回設定を送信する準備ができません。接続と保存先を確認してください。');
  }
  async function run(work:()=>Promise<void>){
    if(writing.current||initial.blocked)return;writing.current=true;setBusy(true);setCanIssue(false);setMessage('');
    try{await work();}catch(error){failed(error);}finally{writing.current=false;if(live.current)setBusy(false);}
  }
  async function read(csrf:string,id:string){
    try{apply(await readOwnerSetup(csrf,id),id);}catch(error){
      if(error instanceof HttpError&&error.status===404){if(live.current){setStatus(null);setUnknown(true);setCanIssue(true);setMessage('この操作の結果はまだ見つかりません。同じ操作IDでの開始だけを明示的に再試行できます。設定権を自動発行しません。');}return;}
      throw error;
    }
  }
  async function recover(){
    const id=current.current;if(!id)return;
    await run(async()=>{setStatus(null);setUnknown(true);requireOwnerOperation(id);
      await withLoginChallenge(request,async(csrf,signal)=>{await prepareOwnerContext(csrf,id);signal.throwIfAborted();if(!live.current)return;await read(csrf,id);});
    });
  }
  async function begin(){
    if(current.current){await recover();return;}
    await run(async()=>withLoginChallenge(request,async(csrf,signal)=>{
      // Another tab may have reserved the operation since this page mounted.
      // A stored ID always chooses resume-only context, never a fresh capability.
      const existing=loadOwnerOperation();
      if(existing){current.current=existing;if(live.current){setOperation(existing);setUnknown(true);}await prepareOwnerContext(csrf,existing);signal.throwIfAborted();if(!live.current)return;await read(csrf,existing);return;}
      await prepareOwnerContext(csrf);signal.throwIfAborted();if(!live.current)return;
      let reserved;
      try{reserved=await reserveOwnerOperation();}catch{if(live.current)setMessage('操作IDを端末に保持できないため、初回設定を発行していません。保存先を確認してから再試行してください。');return;}
      const id=reserved.operationId;current.current=id;if(live.current){setOperation(id);setUnknown(true);}signal.throwIfAborted();if(!live.current)return;
      if(!reserved.fresh){await read(csrf,id);return;}
      try{apply(await issueOwnerSetup(csrf,id),id);}catch(error){if(error instanceof HttpError&&[401,403].includes(error.status))throw error;await read(csrf,id);}
    }));
  }
  async function retryIssue(){
    const id=current.current;if(!id||!canIssue)return;
    await run(async()=>{requireOwnerOperation(id);await withLoginChallenge(request,async(csrf,signal)=>{
      await prepareOwnerContext(csrf,id);signal.throwIfAborted();if(!live.current)return;
      try{apply(await issueOwnerSetup(csrf,id),id);}catch(error){if(error instanceof HttpError&&[401,403].includes(error.status))throw error;await read(csrf,id);}
    });});
  }
  async function save(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(writing.current||unknown||status?.state!=='ready')return;
    const form=event.currentTarget,data=new FormData(form),entry=data.get('password'),password=typeof entry==='string'?entry:'';
    if(password!==data.get('confirm')){setMessage('確認用パスワードが一致していません。');return;}
    const id=current.current;
    await run(async()=>{requireOwnerOperation(id);await withLoginChallenge(request,async(csrf,signal)=>{
      await prepareOwnerContext(csrf,id);signal.throwIfAborted();if(!live.current)return;
      try{const result=await completeOwnerSetup(csrf,id,password);if(result.state!=='completed')throw new Error('invalid_owner_completion');apply(result,id);form.reset();}
      catch(error){
        if(error instanceof HttpError&&[401,403].includes(error.status))throw error;
        if(live.current)setUnknown(true);await read(csrf,id);
      }
    });});
  }
  useEffect(()=>{live.current=true;if(initial.operation)void recover();return()=>{live.current=false;};},[]);
  return {operation,status,busy,unknown,canIssue,blocked:initial.blocked,message,begin,recover,retryIssue,save};
}
