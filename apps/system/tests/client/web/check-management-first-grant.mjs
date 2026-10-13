// @module verification
// @role browser-regression
// Real controller, client, journal and authority checks with synthetic HTTP and hooks.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath,pathToFileURL} from 'node:url';
import * as hooks from '../../support/management-recovery-fixture/parent-hooks.mjs';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const bundled=await build({stdin:{contents:`export {useManagementController} from './src/web/administration/management-controller';export {ManagementClient} from './src/web/administration/management-client';export {managementRecord} from './src/web/administration/management-response-validation';export {recordIdentity,invalidateIdentityObservations} from './src/web/session/identity-observation';`,resolveDir:root,loader:'ts'},bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'hooks',setup(b){b.onResolve({filter:/^react$/},()=>({path:pathToFileURL(fileURLToPath(new URL('../../support/management-recovery-fixture/parent-hooks.mjs',import.meta.url))).href,external:true}));}}]});
const {useManagementController,ManagementClient,managementRecord,recordIdentity,invalidateIdentityObservations}=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'));
Object.defineProperty(globalThis,'navigator',{value:{locks:{request:async(_name,_options,fn)=>fn()}},configurable:true});
const scope='workspace:11111111-1111-4111-8111-111111111111',member={principalId:'TARGET',projectId:scope,permissions:[],revision:0,relationExists:false};
let identity,context,props,record,values,writes,receipts,mode;
function setup({retain=false}={}){
 hooks.reset();invalidateIdentityObservations();identity={principal:{id:'ADMIN',kind:'human',displayName:'Admin'},authentication:'session',csrfToken:'synthetic-csrf',projects:[]};recordIdentity(identity);context={globalAdministrator:true,projects:[]};props={identity,identityChanged(v){props.identity=v;}};record=structuredClone(member);writes=[];receipts=new Map();mode='normal';if(!retain)values=new Map();globalThis.window=new EventTarget();window.location={search:'?'+new URLSearchParams({scope})};window.confirm=()=>true;globalThis.sessionStorage={getItem:key=>values.get(key)??null,setItem:(key,v)=>values.set(key,v),removeItem:key=>values.delete(key)};
 globalThis.fetch=async(path,options={})=>{
  const url=new URL(path,'https://synthetic.invalid'),json=(v,status=200)=>Response.json(v,{status});
  if(url.pathname==='/api/auth/me')return json(identity);
  if(url.pathname==='/api/management/context')return json(context);
  if(url.pathname==='/api/management/records')return json({records:[],nextAfter:null});
  if(url.pathname.startsWith('/api/management/records/')){if(mode==='revokeOnRead')context={globalAdministrator:false,projects:[]};return json({snapshot:mode==='wrongTarget'?{...record,principalId:'OTHER'}:record});}
  if(url.pathname==='/api/management/history')return json({history:[],nextAfter:null});
  if(url.pathname.startsWith('/api/management/operations/')){const result=receipts.get(url.pathname.split('/').at(-1));return result?json({snapshot:result}):json({error:'not_found'},404);}
  if(options.method==='PUT'){
   const body=JSON.parse(options.body);const saved=[...values.values()].map(v=>JSON.parse(v)).find(v=>v.pending?.operationId===body.operationId);assert(saved,'exact operation journal precedes dispatch');assert.equal(saved.pending.record.snapshot.relationExists,false);assert.equal(body.createRelation,true);assert.equal(body.revision,record.revision);assert.equal(options.headers['X-CSRF-Token'],'synthetic-csrf');writes.push({path,body});const {relationExists,...existing}=record;record={...existing,revision:record.revision+1,permissions:body.permissions};receipts.set(body.operationId,record);if(mode==='lostAck')throw new TypeError('lost acknowledgement');return json({snapshot:record});
  }
  throw Error('Unexpected request '+path);
 };
}
async function render(){let model;for(let n=0;n<60;n++){hooks.begin();model=useManagementController(props);hooks.flush();await new Promise(r=>setImmediate(r));if(!hooks.changed())return model;}throw Error('controller did not settle');}
async function select(model,target='TARGET'){model.setLookupTarget(target);model=await render();await model.lookup({preventDefault(){}});return render();}
const results=[];
setup();let model=await render();assert.equal(model.kind,'membership');assert.equal(model.lookupScope,scope);assert.deepEqual(model.projects,[]);model=await select(model);assert.equal(model.record.snapshot.revision,0);assert.equal(model.editable,true);assert.equal(writes.length,0);model.setDraft({...model.draft,permissions:['view','manage']});model=await render();mode='lostAck';model.save({preventDefault(){}});model=await render();assert(model.pending);assert.equal(writes.length,1);const operationId=model.operationId;hooks.reset();model=await render();assert.equal(model.operationId,operationId);assert.equal(model.pending.record.snapshot.relationExists,false);await model.recover();model=await render();assert.equal(model.pending,null);assert.equal(model.record.snapshot.revision,1);assert.equal(writes.length,1);results.push('Global administrator with no membership loads explicit new Workspace target, journals create marker and recovers lost ACK after reload without duplicate PUT');
setup();model=await render();model.changeSelection('scope');model=await render();record={credentialId:'CREDENTIAL',principalId:'TARGET',projectId:scope,permissions:[],revision:7,expiresAt:2000000000,revokedAt:null,relationExists:false};model=await select(model,'CREDENTIAL');assert.equal(model.record.snapshot.revision,7);model.setDraft({...model.draft,permissions:['view']});model=await render();model.save({preventDefault(){}});model=await render();assert.equal(model.record.snapshot.revision,8);assert.equal(model.pending,null);assert.equal(writes[0].body.revision,7);results.push('First credential scope keeps credential-wide revision and explicit createRelation in ordinary command');
setup();model=await render();mode='revokeOnRead';model=await select(model);assert.equal(model.context,null);assert.equal(model.record,null);assert.equal(writes.length,0);results.push('Current global authority loss suppresses protected first-grant state');
setup();model=await render();mode='wrongTarget';model=await select(model);assert.equal(model.record,null);results.push('Unrelated current-state target cannot become an editable grant');
setup();model=await render();model.setLookupScope('workspace:bad/path');model=await render();model=await select(model);assert.equal(model.record,null);assert.equal(writes.length,0);results.push('Malformed scope input is rejected before read/write');
assert.throws(()=>managementRecord({...member,relationExists:undefined}));assert.throws(()=>managementRecord({...member,permissions:['view']}));assert.throws(()=>managementRecord({principalId:'TARGET',revision:0,kind:'human',displayName:'Target',active:1,authVersion:1,globalAdministrator:0}));
setup();identity={...identity,principal:{...identity.principal,id:'OTHER'}};await assert.rejects(()=>new ManagementClient('ADMIN',()=>{}).current('membership','TARGET',scope),e=>e.message==='subject_changed');results.push('Zero revision only permits explicitly absent membership; principal switch fences lookup');
hooks.reset();console.log(JSON.stringify({passed:true,level:'Real controller/client with deterministic hooks and synthetic HTTP, not browser/D1',results},null,2));
