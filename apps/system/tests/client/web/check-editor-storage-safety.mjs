// @module verification
// @role browser-regression
// Hypothesis: a failed durable recovery record must prevent a network mutation.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const negative=process.argv.includes('--negative-control');
assert(process.argv.slice(2).every(v=>v==='--negative-control'));
const bundle=await build({stdin:{contents:`export {IssueEditor} from './src/web/workbench/editor';export {EditStore} from './src/web/workbench/edit-store';`,resolveDir:root,loader:'ts'},bundle:true,write:false,format:'esm',platform:'node',plugins:negative?[{name:'known-unsafe-first-write',setup(b){b.onLoad({filter:/\/editor\.ts$/},async args=>{const source=await readFile(args.path,'utf8'),needle='if(!await this.preparePending())return;await this.send();';assert(source.includes(needle));return {loader:'ts',resolveDir:path.dirname(args.path),contents:source.replace(needle,"if(!await this.preparePending()){const p=this.view.record.pending!;await this.api.send(p.projectId,p.operationId,p.body,p.issueId,p.revision,p.changes,p.title,p.references);return;}await this.send();")};});}}]:[]});
const {IssueEditor,EditStore}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
globalThis.BroadcastChannel=undefined;
// Deterministic fault tests accelerate only the editor's two-second retry timer.
const nativeTimeout=globalThis.setTimeout;globalThis.setTimeout=(work,delay,...args)=>nativeTimeout(work,delay>=2000?0:delay,...args);
const settled=async predicate=>{for(let n=0;n<100;n++){if(predicate())return;await new Promise(resolve=>nativeTimeout(resolve,1));}assert.fail('editor did not settle');};
const copy=value=>structuredClone(value),failure=()=>new DOMException('synthetic storage failure','QuotaExceededError');
class Store {
  drafts=new Map();journals=new Map();failPrepare=false;failReserve=false;failPut=false;failAfterPrepare=false;failAfterReserve=false;
  key(r){return JSON.stringify([r.owner,r.targetId,r.unitId]);}
  async load(o,t,u){return copy(this.drafts.get(JSON.stringify([o,t,u])));}
  async put(r){if(this.failPut)throw failure();this.drafts.set(this.key(r),copy(r));}
  async prepare(r,op){if(this.failPrepare)throw failure();const old=this.journals.get(op.operationId);if(old)assert.equal(old.body,op.body);this.drafts.set(this.key(r),copy(r));if(!old)this.journals.set(op.operationId,copy(op));if(this.failAfterPrepare)this.failPut=true;this.onPrepare?.();}
  async journal(o,id){if(this.failJournal)throw failure();const row=this.journals.get(id);assert(!row||row.owner===o);return copy(row);}
  async reserve(op){if(this.failReserve)throw failure();const row=this.journals.get(op.operationId);assert(row,'reservation requires the recovery journal');if(['confirmed','rejected'].includes(row.phase))return null;const next={...op,attempts:row.attempts+1,phase:'sending'};this.journals.set(op.operationId,copy(next));if(this.failAfterReserve)this.failPut=true;return next;}
  async mark(op){if(this.failMark)throw failure();this.journals.set(op.operationId,copy(op));}
  async finish(r,old,op){if(this.failPut)throw failure();this.drafts.delete(JSON.stringify(old));this.drafts.set(this.key(r),copy(r));this.journals.set(op.operationId,{...copy(op),phase:'confirmed'});}
}
async function fixture(kind,store=new Store(),existing=false){
 const resource=kind==='comment'?{kind,parentKind:'issue',parentId:'I_'+'a'.repeat(64)}:{kind};const prefix={issue:'I_',wiki:'W_',comment:'C_'}[kind];
 let writes=0,queries=0,lost=false,lastReceipt=null;const base={id:prefix+'b'.repeat(64),projectId:'P',body:'old saved body',title:'Saved',references:[],revision:1,createdAt:'2026-10-12T00:00:00Z',updatedAt:'2026-10-12T00:00:00Z'};
 const api={owner:'synthetic-owner',resource,resourceKey:kind,prefix,documentId:t=>t.startsWith(prefix)?t:null,storageTarget:id=>id,onReadDenied:()=>()=>{},assertCurrent(){},valid:v=>!!v&&typeof v.body==='string',
  async send(projectId,operationId,body,id,revision,changes,title,references){writes++;const target=id??prefix+createHash('sha256').update(JSON.stringify([api.owner,operationId])).digest('hex');lastReceipt={operationId,snapshot:{id:target,projectId,body,title,references,revision:(revision??0)+1,createdAt:'2026-10-12T00:00:00Z',updatedAt:'2026-10-12T00:00:00Z'}};if(lost)throw Error('synthetic lost acknowledgement');return lastReceipt;},
  async result(){queries++;return lastReceipt;},async get(){return base;}
 };
 const editor=new IssueEditor(store,api,'P',existing?base.id:'new:P','unit',()=>{},()=>{});await editor.init();editor.input('fixed original input');await editor.flush();
 return {editor,store,api,get writes(){return writes;},get queries(){return queries;},set lost(value){lost=value;}};
}
const results=[];const editors=[];
async function check(name,work){await work();results.push(name);console.log('PASS '+name);}
try{
 for(const kind of ['issue','wiki','comment']){
  await check(kind+': failed prepare blocks first send, repeated retry, and mutation retry while safe result reads remain possible; later durable retry retains ID and frozen input',async()=>{
   const f=await fixture(kind);editors.push(f.editor);f.store.failPrepare=true;await f.editor.save();await f.editor.flush();
   assert.equal(f.writes,0,'network mutation after failed prepare');const id=f.editor.snapshot().record.pending.operationId;
   assert.equal(f.editor.snapshot().record.status,'blocked');assert.equal(f.editor.snapshot().storageAvailable,false);
   assert.equal(f.editor.snapshot().record.pending.attempts,0);assert.equal(f.store.journals.size,0);
   f.editor.input('new unsaved input');await f.editor.flush();await f.editor.retrySameOperation();await f.editor.recover();assert.equal(f.writes,0);assert.equal(f.queries,2);assert.equal(f.editor.snapshot().record.status,'blocked');assert.equal(f.editor.snapshot().record.pending.operationId,id);
   f.store.failPrepare=false;await f.editor.retrySameOperation();await settled(()=>f.editor.snapshot().record.pending===null);await f.editor.flush();assert.equal(f.writes,1);assert.equal(f.store.journals.get(id).phase,'confirmed');assert.equal(f.editor.snapshot().record.base.body,'fixed original input');assert.equal(f.editor.snapshot().record.text,'new unsaved input');assert.equal(f.editor.snapshot().record.status,'dirty');assert.equal(f.editor.snapshot().storageAvailable,true);f.editor.dispose();
  });
  await check(kind+': failed reservation blocks every write and recovers the same prepared operation',async()=>{
   const f=await fixture(kind);editors.push(f.editor);f.store.failReserve=true;await f.editor.save();const id=f.editor.snapshot().record.pending.operationId;assert.equal(f.writes,0);assert.equal(f.editor.snapshot().record.status,'blocked');await f.editor.retrySameOperation();assert.equal(f.writes,0);f.store.failReserve=false;await f.editor.retrySameOperation();await settled(()=>f.editor.snapshot().record.pending===null);assert.equal(f.writes,1);assert.equal(f.store.journals.get(id).phase,'confirmed');f.editor.dispose();
  });
  await check(kind+': draft write failure after preparation/reservation never falls back to memory-only dispatch',async()=>{
   const f=await fixture(kind);editors.push(f.editor);f.store.failAfterReserve=true;await f.editor.save();await f.editor.flush();assert.equal(f.writes,0);assert.equal(f.editor.snapshot().record.status,'blocked');assert.equal(f.editor.snapshot().storageAvailable,false);assert.equal(f.editor.snapshot().record.text,'fixed original input');f.editor.dispose();
  });
  await check(kind+': queued draft failure before reservation cannot skip the journal',async()=>{
   const f=await fixture(kind);editors.push(f.editor);f.store.failAfterPrepare=true;f.store.onPrepare=()=>f.editor.input('queued while preparing');await f.editor.save();await f.editor.flush();assert.equal(f.writes,0);assert.equal(f.editor.snapshot().record.status,'blocked');assert.equal(f.editor.snapshot().record.pending.attempts,0);assert.equal(f.editor.snapshot().record.text,'queued while preparing');f.editor.dispose();
  });
  await check(kind+': existing-target edit has the same durable-first gate and recovers its original ID',async()=>{
   const f=await fixture(kind,new Store(),true);editors.push(f.editor);f.store.failPrepare=true;await f.editor.save();const id=f.editor.snapshot().record.pending.operationId;assert.equal(f.writes,0);assert.equal(f.editor.snapshot().record.pending.revision,1);f.store.failPrepare=false;await f.editor.retrySameOperation();await settled(()=>f.editor.snapshot().record.pending===null);assert.equal(f.writes,1);assert.equal(f.store.journals.get(id).phase,'confirmed');assert.equal(f.editor.snapshot().record.base.revision,2);f.editor.dispose();
  });
  await check(kind+': valid durable save and lost-response result recovery remain exactly once',async()=>{
   const f=await fixture(kind);editors.push(f.editor);f.lost=true;await f.editor.save();await f.editor.flush();const id=f.editor.snapshot().record.pending.operationId;assert.equal(f.writes,1);assert.equal(f.store.journals.get(id).attempts,1);assert.equal(f.editor.snapshot().record.status,'unknown');f.store.failPut=true;f.editor.input('later draft');await f.editor.flush();assert.equal(f.editor.snapshot().storageAvailable,false);f.store.failPut=false;await f.editor.retrySameOperation();assert.equal(f.queries,1);assert.equal(f.writes,1);assert.equal(f.editor.snapshot().record.pending,null);assert.equal(f.editor.snapshot().record.text,'later draft');assert.equal(f.store.journals.get(id).phase,'confirmed');f.editor.dispose();
  });
 }
 for(const stage of ['failJournal','failMark'])for(const hasReceipt of [true,false])await check(stage+': storage failure still queries receipt and never schedules replay',async()=>{
  const f=await fixture('issue');editors.push(f.editor);f.lost=true;await f.editor.save();await f.editor.flush();const id=f.editor.snapshot().record.pending.operationId;f.store[stage]=true;
  if(!hasReceipt)f.api.result=async()=>{f.resultRead=true;throw Error('unknown result');};
  await f.editor.recover();await new Promise(resolve=>nativeTimeout(resolve,10));assert.equal(f.writes,1);assert.equal(f.editor.snapshot().storageAvailable,false);
  if(hasReceipt){assert.equal(f.queries,1);assert.equal(f.editor.snapshot().record.pending,null);}else{assert.equal(f.resultRead,true);assert.equal(f.editor.snapshot().record.pending.operationId,id);assert.equal(f.editor.snapshot().record.status,'blocked');}f.editor.dispose();
 });
 await check('another tab confirmed a redacted journal: storage recovery reads receipt before attempting to prepare again',async()=>{
  const f=await fixture('issue');editors.push(f.editor);f.lost=true;await f.editor.save();await f.editor.flush();const id=f.editor.snapshot().record.pending.operationId;const journal=f.store.journals.get(id);journal.phase='confirmed';delete journal.body;
  f.store.failPut=true;f.editor.input('later local input');await f.editor.flush();f.store.failPut=false;f.store.failPrepare=true;
  await f.editor.retrySameOperation();assert.equal(f.queries,1);assert.equal(f.writes,1);assert.equal(f.editor.snapshot().record.pending,null);assert.equal(f.editor.snapshot().record.base.body,'fixed original input');assert.equal(f.editor.snapshot().record.text,'later local input');f.editor.dispose();
 });
 await check('actual EditStore preparation uses both stores in one transaction and is idempotent and does not reset attempts or replace a command',async()=>{
  const maps={drafts:new Map(),operations:new Map()};let failAdd=false;
  const db={transaction(names){let timer;const tx={};let aborted=false;tx.abort=()=>{aborted=true;clearTimeout(timer);setTimeout(()=>tx.onabort?.(),0);};const local=Object.fromEntries(Object.entries(maps).map(([k,v])=>[k,new Map([...v].map(([key,row])=>[key,copy(row)]))]));const finish=()=>{clearTimeout(timer);timer=setTimeout(()=>{if(aborted)return;for(const name of names)maps[name]=local[name];tx.oncomplete?.();},0);};tx.objectStore=name=>({get(key){const request={};setTimeout(()=>{request.result=copy(local[name].get(JSON.stringify(key)));request.onsuccess?.();finish();},0);return request;},put(row){local[name].set(JSON.stringify(name==='drafts'?[row.owner,row.targetId,row.unitId]:[row.owner,row.operationId]),copy(row));finish();},add(row){if(failAdd)throw new DOMException('synthetic add failure','DataCloneError');const key=JSON.stringify([row.owner,row.operationId]);assert(!local[name].has(key));local[name].set(key,copy(row));finish();}});return tx;}};
  const store=new EditStore();store.open=async()=>db;
  const op={owner:'O',operationId:'OP',projectId:'P',body:'frozen',title:'T',references:[],attempts:0,queries:0,phase:'prepared'},record={owner:'O',projectId:'P',targetId:'new:P',unitId:'U',text:'latest',pending:op};
  failAdd=true;await assert.rejects(store.prepare(record,op),e=>e.name==='DataCloneError');assert.equal(maps.drafts.size,0);assert.equal(maps.operations.size,0);failAdd=false;
  await store.prepare(record,op);assert.equal(maps.drafts.size,1);assert.equal(maps.operations.size,1);maps.operations.get(JSON.stringify(['O','OP'])).attempts=2;
  await store.prepare({...record,text:'newer input'},op);assert.equal(maps.operations.size,1);assert.equal(maps.operations.get(JSON.stringify(['O','OP'])).attempts,2);assert.equal(maps.drafts.get(JSON.stringify(['O','new:P','U'])).text,'newer input');
  const changed={...op,body:'different'};await assert.rejects(store.prepare({...record,pending:changed},changed),/operation_journal_mismatch/);assert.equal(maps.drafts.get(JSON.stringify(['O','new:P','U'])).text,'newer input');assert.equal(maps.operations.get(JSON.stringify(['O','OP'])).body,'frozen');
 });
 await check('failed IndexedDB open is not permanently cached; blocked late-open connection closes',async()=>{
  let requests=[],attempts=0,closed=0;globalThis.indexedDB={open(){attempts++;if(attempts===1)throw new DOMException('disabled','SecurityError');const request={result:{close(){closed++;}}};requests.push(request);return request;}};
  const store=new EditStore();await assert.rejects(store.open(),e=>e.name==='SecurityError');const pending=store.open();assert.equal(attempts,2);requests[0].onblocked();await assert.rejects(pending,/storage_blocked/);requests[0].onsuccess();assert.equal(closed,1);const ready=store.open();requests[1].onsuccess();assert.equal(await ready,requests[1].result);
 });
}catch(error){if(negative&&error.message.includes('network mutation after failed prepare')){console.log('PASS negative control: known unsafe first-write fallback detected');process.exitCode=0;}else throw error;}finally{editors.forEach(e=>e.dispose());}
if(negative){assert.equal(results.length,0,'negative control must fail the first safety invariant');}
const hashes={};for(const file of ['src/web/workbench/editor.ts','src/web/workbench/edit-store.ts','tests/client/web/check-editor-storage-safety.mjs'])hashes[file]=createHash('sha256').update(await readFile(path.join(root,file))).digest('hex');
const report={passed:true,negativeControl:negative,groups:results,sourceHashes:hashes,scope:'Actual bundled IssueEditor with fault-injected storage port and synthetic API; actual EditStore transaction decisions/open lifecycle with controlled IDB requests and accelerated retry timers. Not actual browser quota, persistence/isolation, Worker/D1 or production proof.'};await mkdir(path.join(root,'.local/evidence'),{recursive:true});await writeFile(path.join(root,'.local/evidence/editor-storage'+(negative?'-negative':'')+'.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
