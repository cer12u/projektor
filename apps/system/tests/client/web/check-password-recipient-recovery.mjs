// @module verification
// @role browser-regression
// Prevent losing the completion ID across reload, interchanging two bearer grants,
// and dispatching after failed durable reservation. No actual browser/provider I/O.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import * as hooks from "../../support/management-recovery-fixture/parent-hooks.mjs";
const negative=process.argv.includes('--negative-control'),outfile='.local/password-recipient'+(negative?'-negative':'')+'.mjs';
await mkdir('.local/evidence',{recursive:true});
await build({stdin:{contents:"export {usePasswordSetupController} from './src/web/administration/password-setup-controller';export {recipientKey} from './src/web/administration/password-setup-storage';",resolveDir:process.cwd(),loader:'ts'},outfile,bundle:true,platform:'node',format:'esm',plugins:[{name:'controlled-hooks',setup(b){b.onResolve({filter:/^react$/},()=>({path:new URL("../../support/management-recovery-fixture/parent-hooks.mjs",import.meta.url).pathname,external:true}));if(negative)b.onLoad({filter:/password-setup-storage\.ts$/},async args=>{const source=await readFile(args.path,'utf8');assert(source.includes('localStorage.setItem(key,JSON.stringify(operation));'));return {contents:source.replace('localStorage.setItem(key,JSON.stringify(operation));',"try{localStorage.setItem(key,JSON.stringify(operation));}catch{return {operation,fresh:true};}"),loader:'ts'};});}}]});
const {usePasswordSetupController,recipientKey}=await import('../../../'+outfile);
const root='/api/auth/password-setup/',right='A'.repeat(43),other='B'.repeat(43),password='Synthetic-Only-Password!';
const target={principalId:'synthetic-target',loginId:'synthetic-login',displayName:'Synthetic',purpose:'reset',expiresAt:1999999999};
const receipt=id=>({operationId:id,snapshot:{principalId:target.principalId,configured:true}});
let storage,calls,failStorage,handler,model;
function setup(saved){hooks.reset();storage=new Map(saved??[]);calls=[];failStorage=false;
 globalThis.window=new EventTarget();globalThis.localStorage={getItem:key=>storage.get(key)??null,setItem(key,value){if(failStorage)throw Error('quota');storage.set(key,value);}};
 Object.defineProperty(globalThis,'navigator',{value:{locks:{request:async(_name,options,fn)=>{options.signal?.throwIfAborted();return fn();}}},configurable:true});
 handler=async(path,body)=>path==='context'?Response.json(target):path==='result'?Response.json({error:'setup_result_unavailable'},{status:403}):Response.json(receipt(body.operationId));
 globalThis.fetch=async(path,init={})=>{if(path==='/api/auth/context')return Response.json({csrfToken:'synthetic-csrf'});assert(path.startsWith(root));assert.equal(init.redirect,'error','recipient secret-bearing requests must not follow redirects');const action=path.slice(root.length),body=JSON.parse(init.body);calls.push({action,body});return handler(action,body);};
}
function render(){for(let n=0;n<12;n++){hooks.begin();model=usePasswordSetupController();hooks.flush();if(!hooks.changed())return;}throw Error('render failed');}
async function settle(){for(let n=0;n<5;n++){await new Promise(resolve=>setImmediate(resolve));render();}}
async function open(proof=right){render();await settle();model.setRight(proof);render();await model.open({preventDefault(){}});render();}
async function save(){const Original=globalThis.FormData;globalThis.FormData=class{get(name){return ['password','confirm'].includes(name)?password:null;}};try{await model.save({preventDefault(){},currentTarget:{reset(){}}});}finally{globalThis.FormData=Original;}render();}
const posts=()=>calls.filter(c=>c.action==='complete');
const paths=['src/web/administration/password-setup-controller.ts','src/web/administration/password-setup-storage.ts','src/web/administration/password-setup-view.tsx'];
const hashes={};for(const path of paths)hashes[path]=createHash('sha256').update(await readFile(path)).digest('hex');
const report={scope:'actual compiled admin-issued recipient controller/client with controlled hooks, HTTP and localStorage; no browser or D1',hashes,negativeControl:negative,results:[]};const pass=name=>report.results.push({name,passed:true});
try{
 setup();await open();failStorage=true;await save();assert.equal(posts().length,0,'storage failure must prevent recipient completion');assert.equal(storage.size,0);assert.match(model.message,/送信していません/);pass('storage failure stops completion before password dispatch');
 setup();await open();handler=async(path,body)=>{assert.equal(path,'complete');const saved=JSON.parse(storage.get(await recipientKey(right)));assert.equal(saved.operationId,body.operationId);assert.equal(saved.principalId,target.principalId);throw Error('lost completion response');};await save();const id=model.operation,saved=[...storage];assert.equal(posts().length,1);assert.equal(model.unknown,true);assert.equal(model.retry,false);assert(saved.length===1);assert(!JSON.stringify(saved).includes(right));assert(!JSON.stringify(saved).includes(password));pass('exact operation and verified target persist before dispatch without raw right/password');
 setup(saved);handler=async(path,body)=>{assert.equal(path,'result','completed recovery must not require unconsumed context');assert.equal(body.operationId,id);assert.equal(body.setupRight,right);return Response.json(receipt(id));};await open();assert.equal(model.completed,true);assert.equal(posts().length,0);assert.equal(model.right,'');assert.deepEqual(calls.map(c=>c.action),['result']);pass('reload plus original right recovers result first despite consumed context');
 setup(saved);await open(other);assert.equal(calls[0].action,'context');assert.equal(model.operation,'');await save();assert.equal(posts().length,1);assert.notEqual(posts()[0].body.operationId,id);assert.equal(storage.size,2);pass('different grant for same target receives a different marker and operation ID');
 setup(saved);await open();assert.deepEqual(calls.map(c=>c.action),['result','context']);assert.equal(posts().length,0);assert.equal(model.retry,true);assert.equal(model.unknown,true);await save();assert.equal(posts().length,1);assert.equal(posts()[0].body.operationId,id);assert.equal(model.completed,true);pass('missing result requires fresh unconsumed context and explicit original-ID retry');
 setup(saved);handler=async()=>Response.json({error:'forbidden'},{status:403});await open();assert.equal(model.target,null);assert.equal(model.retry,false);assert.equal(model.unknown,true);assert.equal(posts().length,0);assert.deepEqual([...storage],saved);pass('revoked or unavailable right retains marker but blocks completion');
 setup(saved);handler=async(path)=>path==='result'?Response.json({error:'missing'},{status:403}):Response.json({...target,principalId:'other-target'});await open();assert.equal(model.target,null);assert.equal(model.retry,false);assert.equal(posts().length,0);pass('mismatched verified target cannot unlock a saved completion');
 setup(saved);await open();model.setRight(other);render();const before=calls.length;await model.recover();render();assert.equal(calls.length,before);assert.equal(posts().length,0);pass('changing bearer input cannot query an older grants operation');
 setup(saved);render();await settle();assert.equal(calls.length,0);assert.equal(model.right,'');assert.equal(model.target,null);pass('restart never restores or invents the missing bearer');
 setup();await open();for(const [key,value] of saved)storage.set(key,value);await save();assert.equal(posts().length,0);assert.equal(model.operation,id);assert.equal(model.retry,true);assert.deepEqual(calls.map(c=>c.action),['context','result','context']);pass('concurrent reserved marker forces result recovery before any completion');
 setup(saved);handler=async()=>Response.json({operationId:id,snapshot:{principalId:'other-target',configured:true}});await open();assert.equal(model.completed,false);assert.equal(model.retry,false);assert.equal(model.target,null);assert.equal(posts().length,0);pass('wrong-target receipt cannot confirm completion');
 setup();await open();let release,arrive;const arrived=new Promise(resolve=>{arrive=resolve;});handler=async(path,body)=>{assert.equal(path,'complete');return new Promise(resolve=>{release=()=>resolve(Response.json(receipt(body.operationId)));arrive();});};const pendingSave=save();let timer;try{await Promise.race([arrived,new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('expected completion dispatch')),3000);})]);}finally{clearTimeout(timer);}assert.equal(posts().length,1);hooks.reset();render();release();await pendingSave;render();assert.equal(model.completed,false);assert.equal(model.right,'');pass('late completion cannot repaint an unmounted recipient form');
 report.passed=true;
}catch(error){report.passed=false;report.failure=error.message;if(!negative)throw error;report.defectDetected=true;}
finally{hooks.reset();await writeFile('.local/evidence/password-recipient'+(negative?'-negative':'')+'.json',JSON.stringify(report,null,2)+'\n');}
if(negative)assert.equal(report.defectDetected,true,'unsafe persistence bypass must be detected');
console.log(JSON.stringify(report,null,2));
