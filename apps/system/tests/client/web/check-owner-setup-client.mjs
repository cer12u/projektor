// @module verification
// @role browser-regression
// Defect hypotheses: response-only grant loss, send-before-persist, automatic reissue,
// and password/capability persistence. Actual compiled client/controller; controlled
// HTTP, storage, locks and hooks. This is not browser or real Identity/D1 evidence.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import * as hooks from "../../support/management-recovery-fixture/parent-hooks.mjs";
const negative=process.argv.includes('--negative-control');
const paths=['src/web/administration/owner-setup-controller.ts','src/web/administration/owner-setup-client.ts','src/web/administration/owner-setup-storage.ts','src/web/session/login-challenge.ts'];
const hashes={};for(const path of paths)hashes[path]=createHash('sha256').update(await readFile(path)).digest('hex');
await mkdir('.local/evidence',{recursive:true});
const outfile='.local/owner-setup-client'+(negative?'-negative':'')+'.mjs';
await build({stdin:{contents:"export {useOwnerSetupController} from './src/web/administration/owner-setup-controller';export {readOwnerSetup} from './src/web/administration/owner-setup-client';",resolveDir:process.cwd(),loader:'ts'},outfile,bundle:true,platform:'node',format:'esm',plugins:[{name:'controlled-hooks',setup(b){b.onResolve({filter:/^react$/},()=>({path:new URL("../../support/management-recovery-fixture/parent-hooks.mjs",import.meta.url).pathname,external:true}));if(negative)b.onLoad({filter:/owner-setup-storage\.ts$/},async args=>{const text=await readFile(args.path,'utf8');assert(text.includes('localStorage.setItem(key,operationId);'));return {contents:text.replace('localStorage.setItem(key,operationId);',"try{localStorage.setItem(key,operationId);}catch{return {operationId,fresh:true};}"),loader:'ts'};});}}]});
const {useOwnerSetupController,readOwnerSetup}=await import('../../../'+outfile);
const key='projektor-owner-initial-operation-v1',root='/api/auth/password-setup/owner-initial',original='11111111-1111-4111-8111-111111111111';
let storage,calls,events,failStorage,handler,model;
const response=(id,state='ready',extra={})=>({principalId:'synthetic-owner',operationId:id,state,expiresAt:1999999999,...(state==='completed'?{completedAuthVersion:2}:{}),...extra});
const json=(value,status=200)=>Response.json(value,{status});
function setup(saved){
 hooks.reset();storage=new Map(saved?[[key,saved]]:[]);calls=[];events=[];failStorage=false;handler=async(path,body)=>json(response(body.operationId));
 globalThis.window=new EventTarget();
 globalThis.localStorage={getItem:k=>storage.get(k)??null,setItem(k,v){events.push(['persist',k,v]);if(failStorage)throw Error('quota');storage.set(k,v);}};
 Object.defineProperty(globalThis,'navigator',{value:{locks:{request:async(_name,options,fn)=>{options.signal?.throwIfAborted();return fn();}}},configurable:true});
 globalThis.fetch=async(path,init={})=>{
  const body=init.body?JSON.parse(init.body):undefined;calls.push({path,body});events.push(['request',path]);
  assert.equal(init.credentials,'same-origin');assert.equal(init.headers?.Cookie,undefined);
  if(path==='/api/auth/context')return json({csrfToken:'synthetic-csrf'});
  assert.equal(init.method,'POST');assert.equal(init.redirect,'error','setup requests cannot redirect a password or capability');assert.equal(init.headers['X-CSRF-Token'],'synthetic-csrf');
  if(path===root+'/context')return handler.context?handler.context(body):json({expiresAt:1999999999});
  return handler(path,body);
 };
}
function render(){for(let n=0;n<10;n++){hooks.begin();model=useOwnerSetupController();hooks.flush();if(!hooks.changed())return model;}throw Error('render did not settle');}
async function settle(){for(let n=0;n<6;n++){await new Promise(resolve=>setImmediate(resolve));render();}}
const at=suffix=>calls.filter(c=>c.path===root+suffix);
const report={scope:'actual bundled owner setup controller/client and session challenge; controlled hooks, fetch and localStorage, not browser or real server',hashes,negativeControl:negative,results:[]};
const pass=name=>report.results.push({name,passed:true});
try{
 setup();render();failStorage=true;await model.begin();render();
 assert.equal(at('').length,0,'storage failure must stop owner issuance');assert.equal(storage.size,0);assert.equal(model.operation,'');assert.match(model.message,/発行していません/);pass('storage failure sends no initial issuance after context');
 setup();render();handler=async(path,body)=>{if(path===root){assert.equal(storage.get(key),body.operationId,'ID persisted before issue');throw Error('lost initial response');}assert.equal(path,root+'/status');return json(response(body.operationId));};
 await model.begin();render();const issued=model.operation;
 assert.equal(at('').length,1);assert.equal(at('/status').length,1);assert.equal(at('/status')[0].body.operationId,issued);assert.equal(model.status.state,'ready');assert.equal(storage.size,1);assert.equal(storage.get(key),issued);assert(events.findIndex(e=>e[0]==='persist')<events.findIndex(e=>e[1]===root));
 await model.begin();render();assert.equal(at('').length,1);assert.equal(at('/status').length,2);pass('lost issuance is recovered by same-ID status, repeated begin never reissues');
 setup(original);render();await settle();assert.equal(at('').length,0);assert.deepEqual(at('/context')[0].body,{operationId:original});assert.equal(model.status.state,'ready');pass('reload resumes existing capability and status only');
 setup();render();storage.set(key,original);await model.begin();render();assert.deepEqual(at('/context')[0].body,{operationId:original});assert.equal(at('').length,0);assert.equal(model.status.state,'ready');pass('ID added by another tab after mount still selects resume-only context');
 setup(original);handler.context=async()=>json({error:'forbidden'},403);render();await settle();assert.equal(at('').length,0);assert.equal(at('/status').length,0);assert.equal(model.status,null);assert.equal(model.canIssue,false);assert.equal(storage.get(key),original);assert.match(model.message,/取消・再設定/);pass('missing or expired binding403 never rebinds or reissues');
 setup(original);handler=async()=>json({error:'not_found'},404);render();await settle();assert.equal(at('').length,0);assert.equal(model.unknown,true);assert.equal(model.canIssue,true);handler=async(_path,body)=>json(response(body.operationId));await model.retryIssue();render();assert.equal(at('').length,1);assert.equal(at('')[0].body.operationId,original);assert.equal(storage.get(key),original);pass('status404 is unknown; only explicit same-ID retry can issue');
 setup(original);render();await settle();handler=async(path,body)=>{if(path===root+'/complete'){assert.equal(body.operationId,original);assert.equal(typeof body.password,'string');throw Error('lost completion response');}assert.equal(path,root+'/status');return json(response(body.operationId,'completed'));};
 const OriginalFormData=globalThis.FormData;let reset=0;globalThis.FormData=class{get(name){return ['password','confirm'].includes(name)?'Synthetic-Test-Only!':null;}};
 try{await model.save({preventDefault(){},currentTarget:{reset(){reset++;}}});}finally{globalThis.FormData=OriginalFormData;}
 render();assert.equal(at('/complete').length,1);assert.equal(model.status.state,'completed');assert.equal(at('').length,0);assert.deepEqual([...storage],[[key,original]]);assert.equal(model.unknown,false);pass('lost completion recovers completed status, stores only original ID, never resubmits password');
 setup();render();let release;handler=async(path,body)=>{if(path===root)return new Promise(resolve=>{release=()=>resolve(json(response(body.operationId)));});return json(response(body.operationId));};const first=model.begin();await settle();await model.begin();assert.equal(at('').length,1);release();await first;render();assert.equal(at('').length,1);pass('double click is single-flight with one persisted ID');
 setup(original);handler=async(_path,body)=>json(response(body.operationId,'ready',{setupRight:'untrusted-response-secret'}));render();await settle();assert.equal(model.status,null);assert.equal(model.canIssue,false);pass('legacy secret-bearing status fails closed');
 setup(original);handler=async(_path,body)=>json(response('22222222-2222-4222-8222-222222222222'));await assert.rejects(()=>readOwnerSetup('synthetic-csrf',original),/invalid_owner_status/);pass('mismatched operation response cannot confirm the saved operation');
 setup(original);render();await settle();handler=async(_path,body)=>json(response(body.operationId,'ready',{principalId:'other-principal'}));await model.recover();render();assert.equal(model.status,null);assert.equal(model.canIssue,false);assert.equal(storage.get(key),original);pass('changed principal cannot replace an already observed setup target');
 setup();render();const fetch=globalThis.fetch;globalThis.fetch=async(path,init)=>{const value=await fetch(path,init);if(path===root+'/context')window.dispatchEvent(new Event('pagehide'));return value;};await model.begin();render();assert.equal(at('').length,0);assert.equal(storage.size,0);pass('navigation after context cancels before reservation and issuance');
 setup('corrupt');render();await model.begin();assert.equal(calls.length,0);assert.equal(model.blocked,true);pass('unreadable existing ID blocks dispatch rather than silently replacing it');
 report.passed=true;
}catch(error){report.passed=false;report.failure=error.message;if(!negative)throw error;report.defectDetected=true;}
finally{hooks.reset();await writeFile('.local/evidence/owner-setup-client'+(negative?'-negative':'')+'.json',JSON.stringify(report,null,2)+'\n');}
if(negative)assert.equal(report.defectDetected,true,'removing persistence-before-issuance must break the test');
console.log(JSON.stringify(report,null,2));
