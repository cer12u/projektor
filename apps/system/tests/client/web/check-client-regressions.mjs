// @module verification
// @role browser-regression
import {build} from 'esbuild';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const candidate=fileURLToPath(new URL("../../../",import.meta.url));
const bundle=await build({stdin:{contents:`export {ManagementClient} from './src/web/administration/management-client'; export {IssueApi} from './src/web/workbench/issue-api'; export {HttpError} from './src/web/platform/index'; export {IssueEditor} from './src/web/workbench/editor'; export {EditStore} from './src/web/workbench/edit-store'; export {invalidateIdentityObservations,AuthorityChanged} from './src/web/session/identity-observation';`,resolveDir:candidate,loader:'ts'},bundle:true,write:false,format:'esm',platform:'node'});
const {ManagementClient,IssueApi,HttpError,IssueEditor,EditStore,invalidateIdentityObservations,AuthorityChanged}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
Object.defineProperty(globalThis,'navigator',{value:{locks:{request:async(_name,_options,work)=>work()}},configurable:true});
const full={principal:{id:'OWNER',kind:'human',displayName:'Owner'},authentication:'session',csrfToken:'synthetic',projects:[{id:'PROJECT',permissions:['view','manage','edit']}]};
const view={...full,projects:[{id:'PROJECT',permissions:['view']}]},none={...full,projects:[]};
const member={principalId:'TARGET',projectId:'PROJECT',permissions:['view'],revision:1};
const principal={principalId:'TARGET',kind:'human',displayName:'Target',active:1,authVersion:1,globalAdministrator:0,revision:1};
const reports=[];function pass(name){reports.push(name);console.log('PASS '+name);}
function managerFetch(final,global=false,initial=full){let me=0;globalThis.fetch=async path=>{if(path==='/api/auth/me')return Response.json(++me===1?initial:final);if(path==='/api/management/context')return Response.json({globalAdministrator:global,projects:final.projects});if(path.startsWith('/api/management/records?'))return Response.json({records:[path.includes('kind=principal')?principal:member],nextAfter:null});throw Error('Unexpected '+path);};invalidateIdentityObservations();}
for(const identity of[none,view]){managerFetch(identity);await assert.rejects(()=>new ManagementClient('OWNER',()=>{}).list('membership','PROJECT'),e=>e.status===403||e instanceof AuthorityChanged);}
pass('membership list rejects final same-principal loss of view or manage');
managerFetch(none,true);await assert.rejects(()=>new ManagementClient('OWNER',()=>{}).list('membership','PROJECT'),e=>e.status===403||e instanceof AuthorityChanged);pass('in-flight membership authority change still invalidates observation even for global admin');
managerFetch(none,true,none);assert.equal((await new ManagementClient('OWNER',()=>{}).list('membership','PROJECT')).records.length,1);pass('current global administrator may explicitly manage Identity scopes without Work membership');
managerFetch(none,true,none);assert.equal((await new ManagementClient('OWNER',()=>{}).list('principal')).records.length,1);pass('global principal list remains available without project membership');
managerFetch(full,false);await assert.rejects(()=>new ManagementClient('OWNER',()=>{}).list('principal'),e=>e.status===403||e instanceof AuthorityChanged);pass('global principal list rejects current global authority loss');
managerFetch({...full,principal:{...full.principal,id:'OTHER'}});await assert.rejects(()=>new ManagementClient('OWNER',()=>{}).list('membership','PROJECT'),e=>e.message==='subject_changed');pass('late membership result rejects changed principal');
let sendMe=0;invalidateIdentityObservations();globalThis.fetch=async(path,options={})=>{
 if(path==='/api/auth/me')return Response.json(++sendMe===1?full:none);
 if(path==='/api/management/context')return Response.json({globalAdministrator:false,projects:full.projects});
 if(path==='/api/projects/PROJECT/memberships/TARGET'&&options.method==='PUT')return Response.json({snapshot:{...member,revision:2}});
 throw Error('Unexpected '+path);
};
await assert.rejects(()=>new ManagementClient('OWNER',()=>{}).send({operationId:'SEND',record:{kind:'membership',snapshot:member},draft:{displayName:'',active:true,permissions:['view']}}),e=>e.status===403||e instanceof AuthorityChanged);pass('management mutation postflight revocation suppresses receipt without claiming nonapplication');
invalidateIdentityObservations();let setupContexts=0;globalThis.fetch=async path=>{
 if(path==='/api/auth/me')return Response.json(full);
 if(path==='/api/management/context')return Response.json({globalAdministrator:++setupContexts===1,projects:full.projects});
 if(path==='/api/management/principals/TARGET/password-setup')return Response.json({snapshot:{principalId:'TARGET',revision:1}});
 throw Error('Unexpected '+path);
};
// The only authority check for setupState is the post-response check; deny it.
setupContexts=1;await assert.rejects(()=>new ManagementClient('OWNER',()=>{}).setupState('TARGET'),e=>e.status===403||e instanceof AuthorityChanged);pass('setup state does not return after current global authority is lost');
class MemoryStore{
 drafts=new Map(); journals=new Map(); rejectWithRace=false;
 async load(o,t,u){return structuredClone(this.drafts.get(JSON.stringify([o,t,u])));}
 async put(r){this.drafts.set(JSON.stringify([r.owner,r.targetId,r.unitId]),structuredClone(r));}
 async prepare(r,op){assert(!this.journals.has(op.operationId));await this.put(r);this.journals.set(op.operationId,structuredClone(op));}
 async reserve(op){const row=this.journals.get(op.operationId);if(['rejected','confirmed'].includes(row.phase))return null;const next={...op,attempts:row.attempts+1,phase:'sending'};this.journals.set(op.operationId,structuredClone(next));return next;}
 async journal(o,id){return structuredClone(this.journals.get(id));}
 async mark(op){if(['rejected','confirmed'].includes(this.journals.get(op.operationId)?.phase))return;this.journals.set(op.operationId,structuredClone(op));}
 async rejectCreation(op,record){const row=this.journals.get(op.operationId);if(this.rejectWithRace)row.attempts=2;if(row.attempts!==1)return false;this.journals.set(op.operationId,{...row,phase:'rejected',nonApplication:'pre_dispatch'});await this.put({...record,pending:{...op,phase:'rejected',nonApplication:'pre_dispatch'},status:'blocked'});return true;}
 async retarget(r,old){this.drafts.delete(JSON.stringify(old));await this.put(r);}
 async finish(r,old,op){await this.retarget(r,old);this.journals.set(op.operationId,{...op,phase:'confirmed'});}
}
const target=async(op)=>'I_'+Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(['OWNER',op.operationId])))).toString('hex');
const editors=[];
async function creation(mode,{race=false,restored=false}={}){
 const store=new MemoryStore();store.rejectWithRace=race;let identity=full,posts=[],gets=0,queries=0;
 invalidateIdentityObservations();globalThis.fetch=async(path,options={})=>{
  if(path==='/api/auth/me')return Response.json(identity);
  if(path.includes('/issue-operations/')){queries++;return Response.json({error:'forbidden'},{status:mode==='query404'?404:403});}
  if(path==='/api/projects/PROJECT/issues'&&options.method==='POST'){
   const body=JSON.parse(options.body);posts.push(body);
   if(posts.length===1){
    if(mode==='unknown'||mode==='query404')throw Error('lost acknowledgement');
    if(mode==='postflight')identity=none;
    if(mode==='marked'||mode==='mismatch'||mode==='postflight')return Response.json({error:'forbidden',mutationOutcome:{operationId:mode==='mismatch'?'DIFFERENT':body.operationId,status:'not_applied',phase:'pre_dispatch'}},{status:403});
    return Response.json({error:'forbidden'},{status:403});
   }
   return Response.json({operationId:body.operationId,snapshot:{id:await target(body),projectId:'PROJECT',body:body.body,title:body.title,references:body.references,revision:1,createdAt:'2026-10-12T00:00:00Z',updatedAt:'2026-10-12T00:00:00Z'}});
  }
  if(path.startsWith('/api/projects/PROJECT/issues/')){gets++;return Response.json({error:'forbidden'},{status:403});}
  throw Error('Unexpected '+path);
 };
 const api=new IssueApi('OWNER',()=>{});let editor=new IssueEditor(store,api,'PROJECT','new:PROJECT','unit',()=>{},()=>{});editors.push(editor);
 await editor.init();editor.input('original');await editor.flush();await editor.save();await editor.flush();const originalId=editor.snapshot().record.pending.operationId;
 if(restored){editor.dispose();if(restored==='stale'){const draft=await store.load('OWNER','new:PROJECT','unit');draft.pending.phase='sending';delete draft.pending.nonApplication;draft.status='saving';draft.text='latest queued input';await store.put(draft);}editor=new IssueEditor(store,api,'PROJECT','new:PROJECT','unit',()=>{},()=>{});editors.push(editor);await editor.init();}
 editor.input('corrected');await editor.flush();
 if(mode==='unknown'||mode==='query404')await editor.recover();
 if(mode==='postflight')identity=full;
 await editor.continueAfterDenied();await editor.save();await editor.flush();
 const result={editor,store,posts,gets,queries,originalId};return result;
}
try{
 for(const restored of[false,true,'stale']){
  const r=await creation('marked',{restored});assert.equal(r.posts.length,2);assert.notEqual(r.posts[1].operationId,r.originalId);assert.equal(r.posts[1].body,'corrected');assert.equal(r.gets,0);assert.equal(r.editor.snapshot().record.pending,null);assert.equal(r.editor.snapshot().record.base.body,'corrected');assert.equal(r.store.journals.get(r.originalId).phase,'rejected');assert.equal(r.editor.snapshot().record.heldOperations[0].body,'original');r.editor.dispose();
 }
 pass('proven pre-dispatch denial resumes corrected NEW issue with new ID, including draft reload; never fetches nonexistent target');
 for(const mode of['generic','mismatch','unknown','query404','postflight']){
  const r=await creation(mode);assert.equal(r.posts.length,1);assert.equal(r.editor.snapshot().record.pending.operationId,r.originalId);assert.equal(r.editor.snapshot().record.text,'corrected');r.editor.dispose();
 }
 pass('generic403, mismatched proof, result403/404 and postflight revocation keep original ID; no new POST');
 const race=await creation('marked',{race:true});assert.equal(race.posts.length,1);assert.equal(race.editor.snapshot().record.pending.operationId,race.originalId);race.editor.dispose();pass('a second journal attempt prevents retiring original operation');
 // A later rejected attempt cannot disprove an earlier committed request with a lost response.
 for(const status of [400,413,415]){
  const store=new MemoryStore();let receipt,posts=0,allowResult=false;
  invalidateIdentityObservations();globalThis.fetch=async(path,options={})=>{
   if(path==='/api/auth/me')return Response.json(full);
   if(path.includes('/issue-operations/'))return allowResult?Response.json(receipt):Response.json({error:'forbidden'},{status:403});
   if(path==='/api/projects/PROJECT/issues'&&options.method==='POST'){
    const body=JSON.parse(options.body);posts++;
    if(posts===1){receipt={operationId:body.operationId,snapshot:{id:await target(body),projectId:'PROJECT',body:body.body,title:body.title,references:body.references,revision:1,createdAt:'2026-10-12T00:00:00Z',updatedAt:'2026-10-12T00:00:00Z'}};throw Error('committed response lost');}
    return Response.json({error:'validation_failed'},{status});
   }
   throw Error('Unexpected '+path);
  };
  const editor=new IssueEditor(store,new IssueApi('OWNER',()=>{}),'PROJECT','new:PROJECT','validation-'+status,()=>{},()=>{});editors.push(editor);
  await editor.init();editor.input('original');await editor.flush();await editor.save();await editor.recover();
  const operationId=receipt.operationId;await editor.retrySameOperation();await editor.flush();
  assert.equal(editor.snapshot().record.pending?.operationId,operationId,'validation response must retain unresolved operation');
  assert.notEqual(store.journals.get(operationId).phase,'rejected');
  editor.input('later unsaved input');await editor.save();await editor.flush();assert.equal(posts,2,'unresolved validation response must not mint a new operation');
  editor.dispose();
  const restored=new IssueEditor(store,new IssueApi('OWNER',()=>{}),'PROJECT','new:PROJECT','validation-'+status,()=>{},()=>{});editors.push(restored);await restored.init();
  assert.equal(restored.snapshot().record.pending?.operationId,operationId);allowResult=true;await restored.recover();await restored.flush();
  assert.equal(posts,2);assert.equal(restored.snapshot().record.pending,null);assert.equal(restored.snapshot().record.base.body,'original');assert.equal(restored.snapshot().record.text,'later unsaved input');assert.equal(store.journals.get(operationId).phase,'confirmed');restored.dispose();
 }
 pass('400/413/415 after lost commit preserve operation across reload, block new IDs, and recover the original receipt');
 // Exercise actual EditStore methods with an asynchronous transaction-shaped adapter.
 // This validates decisions, not browser IndexedDB transaction isolation or persistence.
 function database(rows){return{transaction(){const transaction={};const complete=()=>setTimeout(()=>transaction.oncomplete?.(),0);return Object.assign(transaction,{objectStore:()=>({get:k=>{const request={};setTimeout(()=>{request.result=structuredClone(rows.get(JSON.stringify(k)));request.onsuccess?.();complete();},0);return request;},put:r=>{rows.set(JSON.stringify([r.owner,r.operationId]),structuredClone(r));complete();}})});}};}
 const op={owner:'OWNER',operationId:'OP',projectId:'PROJECT',resourceKey:'issue',body:'original',title:'',references:[],attempts:1,queries:0,lastAttemptAt:1,createdAt:1,phase:'sending'};
 const rows=new Map([[JSON.stringify(['OWNER','OP']),structuredClone(op)]]),actual=new EditStore(),record={owner:'OWNER',projectId:'PROJECT',targetId:'new:PROJECT',unitId:'test',text:'latest input',pending:op};actual.open=async()=>database(rows);
 assert.equal(await actual.rejectCreation(op,record),true);assert.equal(await actual.reserve(op),null);assert.equal(rows.get(JSON.stringify(['OWNER','OP'])).phase,'rejected');assert.equal(rows.get(JSON.stringify(['OWNER',null])).pending.nonApplication,'pre_dispatch');assert.equal(rows.get(JSON.stringify(['OWNER',null])).text,'latest input');
 rows.set(JSON.stringify(['OWNER','OP']),{...op,attempts:2});assert.equal(await actual.rejectCreation(op,record),false);assert.equal(rows.get(JSON.stringify(['OWNER','OP'])).attempts,2);
 pass('actual EditStore rejects only first-attempt journal and blocks later reservation of retired ID (transaction-shaped adapter)');
}finally{editors.forEach(e=>e.dispose());}
console.log(JSON.stringify({candidate,passed:reports.length,scope:'Actual client classes with synthetic fetch and in-memory storage; actual EditStore decisions with transaction-shaped adapter. Not browser, IndexedDB persistence, real Worker/D1, or production evidence.'},null,2));
