// @module administration
// @role controller
import {readManagementState,writeManagementState,removeManagementState} from './management-session-storage';
import {useEffect,useMemo,useRef,useState,type FormEvent} from 'react';
import {HttpError} from '../platform/index';
import {ManagementClient} from './management-client';
import {registrationInput,restoreRegistrationDraft,type ManagementRecord,type PrincipalRegistration} from './management-model';
export function usePrincipalRegistrationFormController({api,projects,onSaved,onError,onLock}:{api:ManagementClient;projects:string[];onSaved:(r:ManagementRecord)=>void;onError:(error:unknown)=>void;onLock:(locked:boolean)=>void}){
 
 const saved=useMemo(()=>{try{const raw=readManagementState('registration',api.owner);return raw?registrationInput(JSON.parse(raw)):null;}catch{return null;}},[api.owner]);
 const partial=useMemo(()=>{try{const raw=readManagementState('registration-draft',api.owner);return raw?restoreRegistrationDraft(JSON.parse(raw)):null;}catch{return null;}},[api.owner]);
 const [input,setInput]=useState<PrincipalRegistration>(()=>saved??partial??{operationId:crypto.randomUUID(),principalId:crypto.randomUUID(),kind:'human',displayName:'',loginId:'',projects:[]}),[busy,setBusy]=useState(false),[unknown,setUnknown]=useState(!!saved),[retry,setRetry]=useState(false),[message,setMessage]=useState(saved?'保持した登録操作があります。結果を確認してください。':'');
 const writing=useRef(false),live=useRef(true),accepted=useRef(false);
 useEffect(()=>{if(!saved&&!unknown&&!accepted.current)try{writeManagementState('registration-draft',api.owner,input);}catch{setMessage('入力を端末に保持できません。閉じる前に控えてください。');}},[input,api.owner,saved,unknown]);
 useEffect(()=>{live.current=true;if(saved)onLock(true);return()=>{live.current=false;};},[onLock,saved]);
 useEffect(()=>{const warn=(event:BeforeUnloadEvent)=>{if(busy||unknown||input.displayName||input.loginId||input.projects.length){event.preventDefault();}};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[busy,unknown,input]);
 function accept(record:ManagementRecord){if(record.kind!=='principal'||record.snapshot.principalId!==input.principalId||record.snapshot.kind!==input.kind)throw new Error('invalid_registration_receipt');accepted.current=true;try{removeManagementState('registration',api.owner);removeManagementState('registration-draft',api.owner);}catch{/* Already confirmed. */}onLock(false);onSaved(record);}
 async function transmit(){if(writing.current)return;writing.current=true;setBusy(true);onLock(true);setRetry(false);try{writeManagementState('registration',api.owner,input);}catch{writing.current=false;setBusy(false);onLock(unknown);setRetry(retry);setMessage('操作IDと登録内容を端末に保持できないため送信していません。保存先を確認し、同じ操作で明示的に再試行してください。');return;}
  try{const record=await api.register(input);if(live.current)accept(record);}catch(error){if(!live.current)return;onError(error);if(error instanceof HttpError&&[400,409,413,415].includes(error.status)){onLock(false);try{removeManagementState('registration',api.owner);}catch{/* Memory still holds input. */}}else{setUnknown(true);setMessage('登録結果は未確認です。操作結果を確認してください。自動再送・再登録はしません。');}}finally{writing.current=false;if(live.current)setBusy(false);}}
 async function recover(){setBusy(true);setRetry(false);try{accept(await api.result(input.operationId));}catch(error){onError(error);if(error instanceof HttpError&&error.status===404){setRetry(true);setMessage('操作結果はまだありません。同じ固定ID・同じ内容・同じ操作IDでのみ再送できます。');}}finally{setBusy(false);}}
 function submit(event:FormEvent){event.preventDefault();if(writing.current||unknown)return;if(!input.displayName.trim()||new TextEncoder().encode(input.displayName).length>256){setMessage('表示名は空白のみ不可、256 UTF-8 bytes以内です。');return;}if(input.projects.some(p=>p.permissions.length===0||!p.permissions.includes('view'))){setMessage('所属させるプロジェクトでは閲覧と必要な権限を明示してください。');return;}if(!window.confirm(`${input.kind==='human'?'人':'Agent'} ${input.displayName}\n固定主体ID: ${input.principalId}\n明示所属: ${input.projects.map(p=>p.projectId).join(', ')||'なし'}\n全体管理者属性なしで登録しますか？`))return;void transmit();}
return {projects,input,setInput,busy,unknown,retry,message,transmit,recover,submit};
}
