// @module administration
// @role controller
import {readManagementState,writeManagementState,removeManagementState} from './management-session-storage';
import {useCallback,useEffect,useMemo,useRef,useState,type FormEvent} from 'react';
import type {ManagementProps} from './administration-contracts';
import {HttpError} from '../platform/index';
import {SubjectChanged} from '../session/access';
import {ManagementClient} from './management-client';
import {canManageRecord,draftFrom,managementChange,managementIdPattern,managementRecord,managementTarget,restoreManagementEdit,sameManagementTarget,type ManagementContext,type ManagementDraft,type ManagementHistory,type ManagementRecord,type ManagementSubmission,type SetupSubmission} from './management-model';
import {labels,issue} from './management-presentation';
import {project} from './management-target';
import {savedEdit} from './management-edit-store';
export function useManagementController({identity,identityChanged}:ManagementProps){
 const api=useMemo(()=>new ManagementClient(identity.principal.id,identityChanged),[identity.principal.id,identityChanged]);
 const identityKey=JSON.stringify([identity.principal.id,identity.projects]);
 const [loadedContext,setLoadedContext]=useState<ManagementContext|null>(null),[contextIdentity,setContextIdentity]=useState(identityKey);
 const setContext=useCallback((value:ManagementContext|null)=>{setLoadedContext(value);setContextIdentity(identityKey);},[identityKey]);
 // Hide every old-context view synchronously while current permissions are revalidated.
 const context=contextIdentity===identityKey?loadedContext:null;
 const [kind,setKind]=useState<ManagementRecord['kind']>('principal'),[projectId,setProjectId]=useState('');
 const [records,setRecords]=useState<ManagementRecord[]>([]),[nextAfter,setNextAfter]=useState<string|null>(null),[record,setRecord]=useState<ManagementRecord|null>(null),[draft,setDraft]=useState<ManagementDraft|null>(null),[latest,setLatest]=useState<ManagementRecord|null>(null);
 const [history,setHistory]=useState<ManagementHistory[]>([]),[historyAfter,setHistoryAfter]=useState<string|null>(null),[pending,setPending]=useState<ManagementSubmission|null>(null),[operationId,setOperationId]=useState('');
 const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[blocked,setBlocked]=useState(false),[canRetry,setCanRetry]=useState(false),[storage,setStorage]=useState(true),[registration,setRegistration]=useState(false),[registrationLock,setRegistrationLock]=useState(false),[setupLock,setSetupLock]=useState(false),[setupPending,setSetupPending]=useState<SetupSubmission|null>(null);
 const generation=useRef(0),writing=useRef(false),mounted=useRef(true);
 const setupOwner=useRef({actorId:identity.principal.id,principalId:record?.snapshot.principalId});setupOwner.current={actorId:identity.principal.id,principalId:record?.snapshot.principalId};
 const contextKey=context?JSON.stringify(context):'';
 const projects=context?.projects.filter(p=>managementIdPattern.test(p.id)&&p.permissions.includes('view')&&p.permissions.includes('manage'))??[];
 const dirty=!!record&&!!draft&&JSON.stringify(draft)!==JSON.stringify(draftFrom(record));
 const editable=!!context&&!!record&&canManageRecord(context,record)&&!busy&&!blocked&&!pending&&!latest&&!setupLock&&!setupPending;
 const fail=useCallback((error:unknown)=>{if(error instanceof SubjectChanged)return;if(error instanceof HttpError&&error.code==='saved_management_edit_unavailable'){setBlocked(true);setContext(null);setStorage(false);setMessage('保持した管理操作を安全に復元できません。新しい操作を送信せず、保持情報を確認してください。');return;}setMessage(issue(error));if(error instanceof HttpError&&[401,403].includes(error.status)){setBlocked(true);setRecords([]);setHistory([]);setContext(null);}setCanRetry(false);},[setContext]);
 useEffect(()=>{mounted.current=true;const id=++generation.current;setContext(null);setRecords([]);setHistory([]);setNextAfter(null);setHistoryAfter(null);void api.context().then(c=>{if(id!==generation.current)return;setContext(c);setProjectId(c.projects.find(p=>managementIdPattern.test(p.id)&&p.permissions.includes('view')&&p.permissions.includes('manage'))?.id??'');if(!c.globalAdministrator)setKind('membership');try{if(readManagementState('registration',identity.principal.id)||readManagementState('registration-draft',identity.principal.id))setRegistration(true);}catch{/* Memory-only remains available. */}const saved=savedEdit(identity.principal.id);if(saved){setSetupPending(saved.setupPending??null);setSetupLock(!!saved.setupPending);setOperationId(saved.operationId);setPending(saved.pending);setDraft(saved.draft);setRecord(saved.record);setKind(saved.record.kind);setProjectId(project(saved.record)??'');setBlocked(true);setMessage(saved.setupPending?'保持した設定権操作があります。管理権限を再確認し、設定権操作の結果を確認してください。':saved.pending?'保持した操作があります。操作結果を確認してから続けてください。':'未送信の入力を保持しています。現在の権限と改訂を再確認してください。');}}).catch(fail);return()=>{mounted.current=false;generation.current++;};},[api,identity.principal.id,identityKey,fail,setContext]);
 useEffect(()=>{const warn=(event:BeforeUnloadEvent)=>{if(dirty||pending||busy){event.preventDefault();}};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[dirty,pending,busy]);
 useEffect(()=>{if(!record||!draft)return;try{if(dirty||pending||latest||setupPending)writeManagementState('edit',identity.principal.id,{operationId,record,draft,pending,setupPending});else removeManagementState('edit',identity.principal.id);}catch{setStorage(false);}},[record,draft,dirty,latest,operationId,pending,identity.principal.id,setupPending]);
 useEffect(()=>{if(!context||pending)return;const global=kind==='principal'||kind==='credential';if(global&&!context.globalAdministrator)return;if(!global&&!projectId)return;const id=++generation.current;setBusy(true);setRecords([]);setNextAfter(null);void api.list(kind,projectId).then(r=>{if(id===generation.current){setRecords(r.records);setNextAfter(r.nextAfter);}}).catch(fail).finally(()=>{if(id===generation.current)setBusy(false);});},[api,kind,projectId,contextKey,!!pending,fail]);
 function keepSetupOperation(value:SetupSubmission|null,expectedOperationId?:string){
  if(!record||!draft||record.kind!=='principal'||record.snapshot.kind!=='human'||(value&&(value.actorId!==identity.principal.id||value.principalId!==record.snapshot.principalId)))return false;
  
  try{
   if(value){writeManagementState('edit',identity.principal.id,{operationId,record,draft,pending,setupPending:value});}
   else{
    const raw=readManagementState('edit',identity.principal.id),saved=raw?restoreManagementEdit(JSON.parse(raw)):null,recovery=saved?.setupPending;
    if(!recovery||recovery.actorId!==identity.principal.id||recovery.principalId!==record.snapshot.principalId||recovery.operationId!==expectedOperationId)return false;
    writeManagementState('edit',identity.principal.id,{...saved,setupPending:null});
   }
   if(mounted.current&&setupOwner.current.actorId===identity.principal.id&&setupOwner.current.principalId===record.snapshot.principalId){setSetupPending(value);setSetupLock(!!value);}return true;
  }catch{if(mounted.current)setStorage(false);return false;}
 }
 async function refreshContext(){setBusy(true);try{savedEdit(identity.principal.id);setContext(await api.context());if(record){const current=await api.current(record.kind,managementTarget(record),project(record));setContext(current.context);if(current.record.snapshot.revision!==record.snapshot.revision)setLatest(current.record);}setBlocked(false);setMessage('現在の管理権限と対象を確認しました。保持した入力を確認して続けてください。');}catch(error){fail(error);}finally{setBusy(false);}}
 function changeSelection(nextKind:ManagementRecord['kind'],nextProject=projectId){if(pending||registrationLock||setupLock||!!setupPending)return;if(dirty&&!window.confirm('未送信の入力を破棄して対象を切り替えますか？'))return;generation.current++;try{removeManagementState('edit',identity.principal.id);}catch{setStorage(false);}setRecord(null);setDraft(null);setHistory([]);setLatest(null);setMessage('');setKind(nextKind);setProjectId(nextProject);setRegistration(false);}
 async function open(item:ManagementRecord){if(pending||registrationLock||setupLock||!!setupPending)return;if(dirty&&!window.confirm('未送信の入力を破棄して別の対象を開きますか？'))return;const id=++generation.current;setBusy(true);setMessage('');try{const result=await api.current(item.kind,managementTarget(item),project(item));if(id!==generation.current)return;setContext(result.context);setRecord(result.record);setDraft(draftFrom(result.record));setLatest(null);setBlocked(false);setRegistration(false);setOperationId('');setHistory([]);setHistoryAfter(null);const h=await api.history(result.record);if(id===generation.current){setHistory(h.history);setHistoryAfter(h.nextAfter);}}catch(error){fail(error);}finally{if(id===generation.current)setBusy(false);}}
 async function more(){if(!nextAfter)return;setBusy(true);try{const r=await api.list(kind,projectId,nextAfter);setRecords(v=>[...v,...r.records]);setNextAfter(r.nextAfter);}catch(error){fail(error);}finally{setBusy(false);}}
 async function moreHistory(){if(!record||!historyAfter)return;setBusy(true);try{const h=await api.history(record,historyAfter);setHistory(v=>[...v,...h.history]);setHistoryAfter(h.nextAfter);}catch(error){fail(error);}finally{setBusy(false);}}
 function confirmResult(result:ManagementRecord,submission:ManagementSubmission){if(!sameManagementTarget(result,submission.record)||result.snapshot.revision!==submission.record.snapshot.revision+1)throw new Error('invalid_management_receipt');setRecord(result);setDraft(draftFrom(result));setPending(null);setLatest(null);setCanRetry(false);setMessage('変更結果を確認しました。固定IDと過去の履歴は保持されます。');try{removeManagementState('edit',identity.principal.id);}catch{setStorage(false);}}
 async function transmit(submission:ManagementSubmission){
  if(writing.current)return;writing.current=true;setBusy(true);setCanRetry(false);setMessage('');
  const fixed=structuredClone(submission);
  try{
   try{
    const previous=savedEdit(identity.principal.id),heldSetup=previous?.setupPending??setupPending;
    if(heldSetup){
     // Setup and ordinary edits cannot share a pending journal. Preserve the held right operation.
     if(previous){setRecord(previous.record);setDraft(previous.draft);setOperationId(previous.operationId);setPending(previous.pending);}
     else setPending(null);
     setSetupPending(heldSetup);setSetupLock(true);setBlocked(true);setMessage('保持した設定権操作を先に確認してください。管理変更は送信していません。');return;
    }
    // Persist the exact immutable command before the first API or identity request.
    writeManagementState('edit',identity.principal.id,{operationId:fixed.operationId,record:fixed.record,draft:fixed.draft,pending:fixed,setupPending:null});
   }catch{setStorage(false);setCanRetry(canRetry);setMessage('操作IDと管理変更を端末に保持できないため送信していません。保存先を確認し、同じ操作の結果を確認してください。');return;}
   const result=await api.send(fixed);if(!mounted.current)return;confirmResult(result,fixed);const c=await api.context();setContext(c);if(canManageRecord(c,result)){const h=await api.history(result);setHistory(h.history);setHistoryAfter(h.nextAfter);}
  }catch(error){if(!mounted.current)return;fail(error);if(error instanceof HttpError&&error.status===409&&error.current){try{const current=managementRecord(error.current);if(sameManagementTarget(current,fixed.record)){setLatest(current);setPending(null);}}catch{/* Never render an unrelated conflict response. */}}else if(error instanceof HttpError&&[400,413,415,429].includes(error.status)){setPending(null);}}
  finally{writing.current=false;if(mounted.current)setBusy(false);}
 }
 function save(event:FormEvent){event.preventDefault();if(!editable||!record||!draft||writing.current)return;try{managementChange(record,draft);}catch(error){setMessage(error instanceof Error&&error.message==='view_required'?'閲覧以外の権限には閲覧も選択してください。':'表示名は空白のみ不可、256 UTF-8 bytes以内です。');return;}const consequence=record.kind==='principal'?`${draft.active?'有効':'無効'} / 表示名: ${draft.displayName}`:record.kind==='credential'?'資格情報を失効（元に戻せません）':`このプロジェクトの権限を置換: ${draft.permissions.join(', ')||'すべて取消'}`;if(!window.confirm(`${labels[record.kind]} ${managementTarget(record)}\n${consequence}\n自分の権限・資格を取り消すと結果照会も拒否される場合があります。実行しますか？`))return;const submission={operationId:crypto.randomUUID(),record,draft:structuredClone(draft)};setOperationId(submission.operationId);setPending(submission);void transmit(submission);}
 async function recover(){if(!operationId||writing.current)return;setBusy(true);setCanRetry(false);try{const result=await api.result(operationId);if(pending)confirmResult(result,pending);else{if(!record){setRecord(result);setDraft(draftFrom(result));}setMessage('保存された操作結果を確認しました。現在の手入力は保持しています。最新状態は対象一覧から再取得してください。');}const c=await api.context();setContext(c);setBlocked(false);}catch(error){fail(error);if(error instanceof HttpError&&error.status===404&&pending){setMessage('この操作IDの結果はまだありません。同じ入力・同じ操作IDの再送だけを選べます。');setCanRetry(true);}}finally{setBusy(false);}}
 function adoptLatest(){if(!latest)return;setRecord(latest);setLatest(null);setMessage('最新版を基準にしました。手入力は保持しています。内容を確認し、保存してください。');}
 function openRegistration(){if(dirty&&!window.confirm('未送信の入力を破棄して登録画面を開きますか？'))return;try{removeManagementState('edit',identity.principal.id);}catch{setStorage(false);}setRecord(null);setDraft(null);setRegistration(true);}
 function registrationSaved(r:ManagementRecord){setRegistration(false);setRecord(r);setDraft(draftFrom(r));setKind('principal');setMessage('主体を明示登録しました。資格情報は別の正規手順で設定してください。');}

return {identity,api,context,kind,setKind,projectId,records,nextAfter,record,setRecord,draft,setDraft,latest,history,historyAfter,pending,operationId,busy,message,setMessage,blocked,canRetry,storage,setStorage,registration,setRegistration,registrationLock,setRegistrationLock,setupLock,setSetupLock,setupPending,projects,dirty,editable,fail,keepSetupOperation,refreshContext,changeSelection,open,more,moreHistory,transmit,save,recover,adoptLatest,openRegistration,registrationSaved};
}
