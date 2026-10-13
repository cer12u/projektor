// @module verification
// @role browser-regression
// Real management controller, existing hook harness, controlled storage/API; no network.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import * as hooks from "../../support/management-recovery-fixture/parent-hooks.mjs";
const source='src/web/administration/management-controller.ts',text=await readFile(source,'utf8'),negative=process.argv.includes('--negative-control');
const gate="writeManagementState('edit',identity.principal.id,{operationId:fixed.operationId,record:fixed.record,draft:fixed.draft,pending:fixed,setupPending:null});";
assert(text.includes(gate));
await mkdir('.local/evidence',{recursive:true});
const outfile='.local/management-persistence'+(negative?'-negative':'')+'.mjs';
await build({stdin:{contents:"export {useManagementController as useController} from './src/web/administration/management-controller';export {HttpError} from './src/web/platform/index';",resolveDir:process.cwd(),sourcefile:'management-persistence-entry.ts'},outfile,bundle:true,platform:'node',format:'esm',plugins:[{name:'controlled-management-boundaries',setup(b){b.onResolve({filter:/^react$/},()=>({path:new URL("../../support/management-recovery-fixture/parent-hooks.mjs",import.meta.url).pathname,external:true}));b.onResolve({filter:/\.\/management-client$/},()=>({path:new URL("../../support/management-recovery-fixture/client.mjs",import.meta.url).pathname,external:true}));if(negative)b.onLoad({filter:/management-controller\.ts$/},()=>({contents:text.replace(gate,'/* unsafe continuation: no synchronous command persistence */'),loader:'ts'}));}}]});
const {useController,HttpError}=await import('../../../'+outfile);
const report={scope:'local real management controller with controlled storage/API and existing hooks',productionActions:0,sourceSha256:createHash('sha256').update(text).digest('hex'),negativeControl:negative,results:[]};
const record={kind:'principal',snapshot:{principalId:'TARGET',kind:'human',displayName:'Before',active:1,authVersion:1,globalAdministrator:0,revision:1}};
const draft={displayName:'After',active:true,permissions:[]},submission={operationId:'ORIGINAL_EDIT',record,draft};
const changed={kind:'principal',snapshot:{...record.snapshot,displayName:'After',revision:2}};
const context={globalAdministrator:true,projects:[]},key='projektor-management-edit:OWNER';
const setup={actorId:'OWNER',principalId:'TARGET',operationId:'HELD_SETUP',revision:1,purpose:'initial'};
let store,failStore,props,api,model,calls,results;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function render(){for(let n=0;n<30;n++){hooks.begin();model=useController(props);hooks.flush();await tick();if(!hooks.changed())return model;}throw Error('render did not settle');}
function reset(saved){hooks.reset();store=new Map(saved?[[key,JSON.stringify(saved)]]:[]);failStore=false;calls=[];results=[];
 globalThis.window=new EventTarget();window.confirm=()=>true;globalThis.sessionStorage={getItem:k=>store.get(k)??null,setItem(k,v){if(failStore)throw Error('quota');store.set(k,v);},removeItem:k=>store.delete(k)};
 api={owner:'OWNER',context:async()=>context,list:async()=>({records:[record],nextAfter:null}),current:async()=>({record,context}),history:async()=>({history:[],nextAfter:null}),send:async value=>{calls.push(structuredClone(value));return changed;},result:async id=>{results.push(id);throw new HttpError(404,'operation_not_found');}};
 globalThis.testApi=()=>api;props={identity:{principal:{id:'OWNER',kind:'human',displayName:'Owner'},authentication:'session',projects:[]},identityChanged(){}};
}
async function editable(){reset();await render();await model.open(record);await render();model.setDraft(structuredClone(draft));await render();}
try{
 await editable();failStore=true;model.save({preventDefault(){}});await render();
 assert.equal(calls.length,0,'storage failure must stop ordinary management mutation');assert.equal(model.busy,false);assert(model.pending);const id=model.operationId;assert.equal(model.pending.operationId,id);assert.match(model.message,/送信していません/);
 await tick();await render();assert.equal(calls.length,0);report.results.push({name:'quota failure before a new edit sends zero requests and retains the exact pending operation ID',passed:true});
 failStore=false;await model.recover();await render();assert.deepEqual(results,[id]);assert.equal(model.canRetry,true);const original=structuredClone(model.pending);
 api.send=async value=>{const persisted=JSON.parse(store.get(key));assert.deepEqual(persisted.pending,value);assert.equal(persisted.operationId,id);calls.push(structuredClone(value));throw new HttpError(503,'temporarily_unavailable');};
 await model.transmit(model.pending);await render();assert.equal(calls.length,1);assert.deepEqual(calls[0],original);assert.equal(model.pending.operationId,id);assert.deepEqual(JSON.parse(store.get(key)).pending,original);report.results.push({name:'explicit retry persists the same immutable submission before dispatch and lost response retains it',passed:true});
 hooks.reset();await render();assert.equal(model.pending.operationId,id);assert.equal(calls.length,1);await tick();await render();assert.equal(calls.length,1);failStore=true;await model.recover();await render();assert.equal(model.canRetry,true);await model.transmit(model.pending);await render();
 assert.equal(calls.length,1);assert.equal(model.pending.operationId,id);assert.equal(model.canRetry,true);assert.deepEqual(JSON.parse(store.get(key)).pending,original);report.results.push({name:'restored unknown edit is not auto-retried and a failed same-ID retry preserves the original journal',passed:true});
 reset({operationId:'',record,draft:{displayName:'Before',active:true,permissions:[]},pending:null,setupPending:setup});await render();const before=JSON.parse(store.get(key));await model.transmit(submission);await render();
 assert.equal(calls.length,0);assert.deepEqual(JSON.parse(store.get(key)).setupPending,setup);assert.equal(JSON.parse(store.get(key)).pending,null);assert.deepEqual(model.setupPending,setup);assert.equal(model.setupLock,true);assert.equal(model.operationId,before.operationId);report.results.push({name:'held setup operation is preserved and blocks an incompatible ordinary edit',passed:true});
 await editable();let release;api.send=value=>{assert.deepEqual(JSON.parse(store.get(key)).pending,value);calls.push(structuredClone(value));return new Promise(resolve=>{release=()=>resolve(changed);});};
 const fixed=structuredClone(submission),first=model.transmit(fixed);await model.transmit(fixed);fixed.operationId='MUTATED_CALLER';fixed.draft.displayName='MUTATED_CALLER';assert.equal(calls.length,1);assert.equal(calls[0].operationId,submission.operationId);release();await first;await render();assert.equal(model.pending,null);assert.equal(calls[0].draft.displayName,'After');report.results.push({name:'one in-flight dispatch uses its captured submission even if caller input later changes',passed:true});
 report.passed=true;
}catch(error){report.passed=false;report.failure=error.message;if(!negative)throw error;report.defectDetected=true;}
finally{hooks.reset();await writeFile('.local/evidence/management-persistence'+(negative?'-negative':'')+'.json',JSON.stringify(report,null,2)+'\n');}
if(negative)assert.equal(report.defectDetected,true,'missing pre-dispatch persistence must fail the contract');
console.log(JSON.stringify(report,null,2));
