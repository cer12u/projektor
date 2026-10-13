// @module verification
// @role browser-regression
// Real registration controller with controlled hook/storage/API boundaries; no network.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import * as hooks from "../../support/management-recovery-fixture/parent-hooks.mjs";
const negative=process.argv.includes('--negative-control'),source='src/web/administration/principal-registration-controller.ts';
const sourceText=await readFile(source,'utf8'),sourceSha256=createHash('sha256').update(sourceText).digest('hex');
const failClosed="catch{writing.current=false;setBusy(false);onLock(unknown);setRetry(retry);setMessage('操作IDと登録内容を端末に保持できないため送信していません。保存先を確認し、同じ操作で明示的に再試行してください。');return;}";
assert(sourceText.includes(failClosed),'specific persist-before-dispatch guard exists');
await mkdir('.local/evidence',{recursive:true});
const outfile='.local/registration-persistence'+(negative?'-negative':'')+'.mjs';
await build({stdin:{contents:"export {usePrincipalRegistrationFormController as useController} from './src/web/administration/principal-registration-controller';export {HttpError} from './src/web/platform/index';",resolveDir:process.cwd(),sourcefile:'registration-persistence-entry.ts'},outfile,bundle:true,platform:'node',format:'esm',plugins:[{name:'controlled-hooks',setup(b){b.onResolve({filter:/^react$/},()=>({path:new URL("../../support/management-recovery-fixture/parent-hooks.mjs",import.meta.url).pathname,external:true}));if(negative)b.onLoad({filter:/principal-registration-controller\.ts$/},()=>({contents:sourceText.replace(failClosed,"catch{setMessage('storage failed, legacy unsafe continuation');}"),loader:'ts'}));}}]});
const {useController,HttpError}=await import('../../../'+outfile);
const report={scope:'local real registration controller; controlled storage/API and existing hook harness',productionActions:0,sourceSha256,negativeControl:negative,results:[]};
const savedKey='projektor-management-registration:OWNER';
let storage,failStorage,events,props,model,calls,resultCalls;
const input={operationId:'REGISTER_ORIGINAL',principalId:'NEW_PERSON',kind:'human',displayName:'Synthetic registration',loginId:'synthetic-registration',projects:[{projectId:'P',permissions:['view']}]};
const receipt={kind:'principal',snapshot:{principalId:input.principalId,kind:input.kind}};
function setup(saved=false){
 hooks.reset();storage=new Map(saved?[[savedKey,JSON.stringify(input)]]:[]);failStorage=false;events=[];calls=[];resultCalls=[];
 globalThis.window=new EventTarget();window.confirm=()=>true;
 globalThis.sessionStorage={getItem:k=>storage.get(k)??null,setItem(k,v){events.push(['persist',k]);if(failStorage)throw Error('quota');storage.set(k,v);},removeItem:k=>storage.delete(k)};
 props={api:{owner:'OWNER',async register(value){assert.deepEqual(JSON.parse(storage.get(savedKey)),value,'exact command persisted before dispatch');events.push(['dispatch',value.operationId]);calls.push(structuredClone(value));return receipt;},async result(id){resultCalls.push(id);throw new HttpError(404,'not_found');}},projects:['P'],onSaved:r=>events.push(['saved',r.snapshot.principalId]),onError:e=>events.push(['error',e.status]),onLock:locked=>events.push(['lock',locked])};
}
function render(){for(let n=0;n<12;n++){hooks.begin();model=useController(props);hooks.flush();if(!hooks.changed())return model;}throw Error('hook render did not settle');}
function lastLock(){return events.filter(e=>e[0]==='lock').at(-1)?.[1];}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
try{
 setup();render();model.setInput(structuredClone(input));render();failStorage=true;
 // If the unsafe continuation returns, record the side effect without needing a stored command.
 props.api.register=async value=>{calls.push(structuredClone(value));return receipt;};
 await model.transmit();render();
 assert.equal(calls.length,0,'storage failure must prevent principal registration dispatch');
 assert.equal(model.input.operationId,input.operationId);assert.deepEqual(model.input,input);assert.equal(model.unknown,false);assert.equal(model.busy,false);assert.equal(lastLock(),false);assert.match(model.message,/送信していません/);
 await tick();render();assert.equal(calls.length,0);report.results.push({name:'new registration storage failure keeps exact input/ID and dispatches zero times',passed:true});
 failStorage=false;props.api.register=async value=>{assert.deepEqual(JSON.parse(storage.get(savedKey)),input);calls.push(structuredClone(value));return receipt;};
 await model.transmit();render();assert.equal(calls.length,1);assert.deepEqual(calls[0],input);assert.equal(storage.has(savedKey),false);assert.equal(lastLock(),false);report.results.push({name:'storage recovery requires an explicit same-ID attempt and persists before dispatch',passed:true});
 setup(true);render();assert.equal(model.unknown,true);await model.recover();render();assert.equal(model.retry,true);failStorage=true;await model.transmit();render();
 assert.equal(calls.length,0);assert.equal(model.unknown,true);assert.equal(model.retry,true);assert.equal(model.busy,false);assert.equal(lastLock(),true);assert.deepEqual(JSON.parse(storage.get(savedKey)),input);assert.deepEqual(resultCalls,[input.operationId]);report.results.push({name:'failed persistence during explicit unknown-operation retry keeps the original operation locked',passed:true});
 setup();render();model.setInput(structuredClone(input));render();let reject;
 props.api.register=value=>{assert.deepEqual(JSON.parse(storage.get(savedKey)),input);calls.push(structuredClone(value));return new Promise((_resolve,r)=>{reject=r;});};
 const first=model.transmit();await model.transmit();assert.equal(calls.length,1);reject(new HttpError(503,'temporarily_unavailable'));await first;render();await tick();render();
 assert.equal(calls.length,1);assert.equal(model.unknown,true);assert.equal(model.input.operationId,input.operationId);assert.equal(storage.has(savedKey),true);assert.equal(lastLock(),true);assert.equal(resultCalls.length,0);report.results.push({name:'double submission dispatches once and an uncertain result preserves its journal without auto retry',passed:true});
 report.passed=true;
}catch(error){report.passed=false;report.failure=error.message;if(!negative)throw error;report.defectDetected=true;}
finally{hooks.reset();await writeFile('.local/evidence/registration-persistence'+(negative?'-negative':'')+'.json',JSON.stringify(report,null,2)+'\n');}
if(negative)assert.equal(report.defectDetected,true,'unsafe legacy continuation must fail the contract');
console.log(JSON.stringify(report,null,2));
