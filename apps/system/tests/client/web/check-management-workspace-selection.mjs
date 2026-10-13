// @module verification
// @role browser-regression
// Real controller with deterministic hook/transport fixture; not browser rendering proof.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import * as hooks from '../../support/management-recovery-fixture/parent-hooks.mjs';
const negative=process.argv.includes('--negative-control'),source='src/web/administration/management-controller.ts',original=await readFile(source,'utf8');
await mkdir('.local/evidence',{recursive:true});
const outfile='.local/management-workspace-selection'+(negative?'-negative':'')+'.mjs';
await build({entryPoints:[source],outfile,bundle:true,platform:'node',format:'esm',plugins:[{name:'controlled-management-boundaries',setup(b){b.onResolve({filter:/^react$/},()=>({path:new URL('../../support/management-recovery-fixture/parent-hooks.mjs',import.meta.url).pathname,external:true}));b.onResolve({filter:/\.\/management-client$/},()=>({path:new URL('../../support/management-recovery-fixture/client.mjs',import.meta.url).pathname,external:true}));if(negative)b.onLoad({filter:/management-controller\.ts$/},()=>({contents:original.replaceAll('managementScopeIdPattern','managementIdPattern'),loader:'ts'}));}}]});
const {useManagementController}=await import('../../../'+outfile),workspace='workspace:11111111-1111-4111-8111-111111111111';
const projects=[{id:workspace,permissions:['view','manage']},{id:'P',permissions:['view','manage']},{id:workspace+'/bad',permissions:['view','manage']},{id:'READONLY',permissions:['view']}];
const context={globalAdministrator:false,projects},lists=[];
globalThis.window=new EventTarget();globalThis.sessionStorage={getItem:()=>null,setItem(){},removeItem(){}};
globalThis.testApi=()=>({context:async()=>context,list:async(kind,scope)=>{lists.push({kind,scope});return{records:[],nextAfter:null};}});
const props={identity:{principal:{id:'OWNER',kind:'human',displayName:'Owner'},authentication:'session',projects},identityChanged(){}};
async function render(){let model;for(let n=0;n<30;n++){hooks.begin();model=useManagementController(props);hooks.flush();await new Promise(resolve=>setImmediate(resolve));if(!hooks.changed())return model;}throw Error('render did not settle');}
const report={scope:'actual management controller with existing hook and API fixture; synthetic only',negativeControl:negative,passed:false};
try{
 let model=await render();assert.deepEqual(model.projects.map(p=>p.id),[workspace,'P']);assert.equal(model.projectId,workspace);assert.deepEqual(lists,[{kind:'membership',scope:workspace}]);
 model.changeSelection('scope',workspace);model=await render();assert.equal(model.kind,'scope');assert.deepEqual(lists.at(-1),{kind:'scope',scope:workspace});
 model.changeSelection('membership','P');model=await render();assert.equal(model.projectId,'P');assert.deepEqual(lists.at(-1),{kind:'membership',scope:'P'});report.passed=true;
}catch(error){report.failure=error.message;if(!negative)throw error;report.defectDetected=true;}
finally{hooks.reset();await writeFile('.local/evidence/management-workspace-selection'+(negative?'-negative':'')+'.json',JSON.stringify(report,null,2)+'\n');}
if(negative)assert.equal(report.defectDetected,true,'old project-only selector must fail workspace selection');
console.log(JSON.stringify(report));
