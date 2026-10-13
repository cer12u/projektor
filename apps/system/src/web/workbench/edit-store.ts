// @module workbench
// @role storage
import {sameReferences} from "../../modules/work/reference-contracts";
import type {EditRecord,Pending,Journal} from './edit-contracts';
import {unsavedRecord,key} from './edit-state';
export type {SaveState,Pending,EditRecord} from './edit-contracts';
export {draftReferences,dirtyRecord,unsavedRecord,provenRejectedCreation,key} from './edit-state';
const sameCommand=(row:Journal,op:Pending)=>row.owner===op.owner&&row.operationId===op.operationId&&(row.resourceKey??'issue')===(op.resourceKey??'issue')&&row.projectId===op.projectId&&row.issueId===op.issueId&&row.revision===op.revision&&row.body===op.body&&row.title===op.title&&sameReferences(row.references,op.references)&&JSON.stringify(row.changes)===JSON.stringify(op.changes);
const eventValue=<T>(r:IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error??new Error('storage_failed'));});
const complete=(t:IDBTransaction)=>new Promise<void>((resolve,reject)=>{t.oncomplete=()=>resolve();t.onerror=()=>reject(t.error??new Error('storage_failed'));t.onabort=()=>reject(t.error??new Error('storage_aborted'));});
export class EditStore{
  private opened?:Promise<IDBDatabase>;
  open():Promise<IDBDatabase>{
    if(!this.opened){const opened=new Promise<IDBDatabase>((resolve,reject)=>{
      let failed=false;const r=indexedDB.open('projektor-edits-v1',1);
      r.onupgradeneeded=()=>{const db=r.result;db.createObjectStore('drafts',{keyPath:['owner','targetId','unitId']});db.createObjectStore('operations',{keyPath:['owner','operationId']});};
      r.onerror=()=>{failed=true;reject(r.error??new Error('storage_unavailable'));};r.onblocked=()=>{failed=true;reject(new Error('storage_blocked'));};r.onsuccess=()=>{if(failed)r.result.close();else resolve(r.result);};
    });this.opened=opened;void opened.catch(()=>{if(this.opened===opened)this.opened=undefined;});}return this.opened;
  }
  async load(owner:string,targetId:string,unitId:string):Promise<EditRecord|undefined>{
    const db=await this.open(),t=db.transaction('drafts','readonly');
    const r=await eventValue<EditRecord|undefined>(t.objectStore('drafts').get([owner,targetId,unitId]) as IDBRequest<EditRecord|undefined>);
    if(r&&(r.schema!==1||r.owner!==owner||r.targetId!==targetId||r.unitId!==unitId||typeof r.text!=='string'))throw new Error('invalid_local_draft');return r;
  }
  async list(owner:string):Promise<EditRecord[]>{
    const db=await this.open(),t=db.transaction('drafts','readonly');const rows=await eventValue<EditRecord[]>(t.objectStore('drafts').getAll() as IDBRequest<EditRecord[]>);
    return rows.filter(r=>r.schema===1&&r.owner===owner&&typeof r.text==='string').sort((a,b)=>b.updatedAt-a.updatedAt);
  }
  async put(record:EditRecord):Promise<void>{const db=await this.open(),t=db.transaction('drafts','readwrite'),done=complete(t);t.objectStore('drafts').put(record);await done;}
  async prepare(record:EditRecord,op:Pending):Promise<void>{
    const db=await this.open(),t=db.transaction(['drafts','operations'],'readwrite'),done=complete(t),s=t.objectStore('operations');
    try{
      const row=await eventValue<Journal|undefined>(s.get([op.owner,op.operationId]) as IDBRequest<Journal|undefined>);
      // Explicit storage recovery may repeat preparation, but must not replace another command or reset attempt counts.
      if(record.owner!==op.owner||record.projectId!==op.projectId||!record.pending||!sameCommand(record.pending,op)||row&&!sameCommand(row,op))throw new Error('operation_journal_mismatch');
      t.objectStore('drafts').put(record);if(!row)s.add(op);await done;
    }catch(error){try{t.abort();}catch{/* The transaction may already have aborted. */}await done.catch(()=>{});throw error;}
  }
  async journal(owner:string,operationId:string):Promise<Journal|undefined>{const db=await this.open(),t=db.transaction('operations','readonly');return eventValue<Journal|undefined>(t.objectStore('operations').get([owner,operationId]) as IDBRequest<Journal|undefined>);}
  async reserve(op:Pending):Promise<Pending|null>{
    const db=await this.open(),t=db.transaction('operations','readwrite'),done=complete(t),s=t.objectStore('operations');
    const row=await eventValue<Journal|undefined>(s.get([op.owner,op.operationId]) as IDBRequest<Journal|undefined>);
    if(!row){await done;throw new Error('operation_journal_missing');}
    if(row.phase==='confirmed'||row.phase==='rejected'||row.attempts>=4){await done;return null;}
    if(!sameCommand(row,op)){await done;throw new Error('operation_journal_mismatch');}
    const next={...op,attempts:row.attempts+1,queries:Math.max(row.queries,op.queries),lastAttemptAt:Date.now(),phase:'sending' as const};s.put(next);await done;return next;
  }
  /** Retire a proven non-dispatched first attempt atomically, before permitting a new operation. */
  async rejectCreation(op:Pending,record:EditRecord):Promise<boolean>{
    const db=await this.open(),t=db.transaction(['operations','drafts'],'readwrite'),done=complete(t),s=t.objectStore('operations');
    try{const row=await eventValue<Journal|undefined>(s.get([op.owner,op.operationId]) as IDBRequest<Journal|undefined>);
    if(record.owner!==op.owner||record.pending?.operationId!==op.operationId||record.projectId!==op.projectId||!row||op.issueId||row.issueId||op.revision!==undefined||row.revision!==undefined||op.changes!==undefined||row.changes!==undefined||(op.resourceKey??'issue')!=='issue'||op.attempts!==1||row.attempts!==1||row.phase==='confirmed'||row.phase==='rejected'||(row.resourceKey??'issue')!=='issue'||row.projectId!==op.projectId||row.body!==op.body||row.title!==op.title||!sameReferences(row.references,op.references)){
      await done;return false;
    }
    s.put({...row,phase:'rejected',nonApplication:'pre_dispatch'});t.objectStore('drafts').put({...record,pending:{...op,phase:'rejected',nonApplication:'pre_dispatch'},status:'blocked'});await done;return true;
    }catch(error){try{t.abort();}catch{/* Already aborted. */}await done.catch(()=>{});throw error;}
  }
  async mark(op:Pending):Promise<void>{
    const db=await this.open(),t=db.transaction('operations','readwrite'),done=complete(t),s=t.objectStore('operations');
    const row=await eventValue<Journal|undefined>(s.get([op.owner,op.operationId]) as IDBRequest<Journal|undefined>);
    if(row?.phase==='confirmed'||row?.phase==='rejected'){await done;return;}
    const next:Journal={...op,attempts:Math.max(row?.attempts??0,op.attempts),queries:Math.max(row?.queries??0,op.queries)};
    if(op.phase==='confirmed'||op.phase==='rejected')delete next.body;s.put(next);await done;
  }
  async retarget(record:EditRecord,oldKey:string[]):Promise<void>{const db=await this.open(),t=db.transaction('drafts','readwrite'),done=complete(t),s=t.objectStore('drafts');try{s.delete(oldKey);s.put(record);await done;}catch(error){try{t.abort();}catch{/* Already aborted. */}await done.catch(()=>{});throw error;}}
  async finish(record:EditRecord,oldKey:string[],op:Pending):Promise<void>{
    const db=await this.open(),t=db.transaction(['drafts','operations'],'readwrite'),done=complete(t),s=t.objectStore('drafts');
    try{s.delete(oldKey);if(unsavedRecord(record))s.put(record);else s.delete(key(record));
    const journal:Journal={...op,phase:'confirmed'};delete journal.body;t.objectStore('operations').put(journal);await done;}catch(error){try{t.abort();}catch{/* Already aborted. */}await done.catch(()=>{});throw error;}
  }
}
