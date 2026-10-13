// @module verification
// @role browser-regression
// Hypothesis: recipient or legacy entry mounts owner recovery and invokes an Access-bound API.
// Actual main routing, setup composition/views/controllers; controlled hooks and HTTP, not a live Access test.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import * as hooks from '../../support/management-recovery-fixture/parent-hooks.mjs';
const directory=await mkdtemp(join(tmpdir(),'setup-entry-routing-')),ownerRoot='/api/auth/password-setup/owner-initial',operationId='11111111-1111-4111-8111-111111111111';
let calls=[],anchors=[];const results=[];
function render(element){if(element==null||typeof element!=='object')return;if(Array.isArray(element)){element.forEach(render);return;}if(typeof element.type==='function'){render(element.type(element.props));return;}if(element.type==='a')anchors.push(element.props);render(element.props?.children);}
try{
 for(const negative of [false,true]){
  const outfile=join(directory,negative?'negative.mjs':'actual.mjs');
  await build({entryPoints:['src/web/main.tsx'],outfile,bundle:true,format:'esm',platform:'node',loader:{'.css':'empty'},plugins:[{name:'controlled-host',setup(b){
   b.onResolve({filter:/^react$/},()=>({path:new URL('../../support/management-recovery-fixture/parent-hooks.mjs',import.meta.url).pathname,external:true}));
   b.onResolve({filter:/^react\/jsx-runtime$/},()=>({path:'jsx',namespace:'jsx'}));
   b.onLoad({filter:/.*/,namespace:'jsx'},()=>({contents:'export const Fragment=Symbol();export function jsx(type,props){return{type,props};}export const jsxs=jsx;',loader:'js'}));
   b.onResolve({filter:/^react-dom\/client$/},()=>({path:'renderer',namespace:'host'}));
   b.onLoad({filter:/.*/,namespace:'host'},()=>({contents:'export function createRoot(){return {render:globalThis.__setupRouteRender}};',loader:'js'}));
   b.onLoad({filter:/app-shell\.tsx$/},()=>({contents:'export function App(){return null;}',loader:'tsx'}));
   if(negative)b.onLoad({filter:/administration\/password-setup\.tsx$/},async args=>{const text=await readFile(args.path,'utf8'),needle='<RecipientSetupView model={useRecipientSetupController()}/>';assert(text.includes(needle));return{contents:text.replace(needle,needle+'<OwnerSetupView model={useOwnerSetupController()}/>'),loader:'tsx'};});
  }}]});
  const route=async pathname=>{
   hooks.reset();hooks.begin();calls=[];anchors=[];globalThis.__setupRouteRender=render;globalThis.window=new EventTarget();globalThis.document={getElementById:()=>({})};globalThis.location={pathname};
   const storage=new Map([['projektor-owner-initial-operation-v1',operationId]]);globalThis.localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)};
   Object.defineProperty(globalThis,'navigator',{value:{locks:{request:async(_name,_options,fn)=>fn()}},configurable:true});
   globalThis.fetch=async(path,init={})=>{calls.push({path,method:init.method??'GET'});if(path==='/api/auth/context')return Response.json({csrfToken:'synthetic-csrf'});assert.equal(init.redirect,'error');if(path===ownerRoot+'/context')return Response.json({expiresAt:1999999999});if(path===ownerRoot+'/status')return Response.json({principalId:'synthetic-owner',operationId,state:'ready',expiresAt:1999999999});throw Error('unexpected setup request '+path);};
   await import(pathToFileURL(outfile).href+'?route='+encodeURIComponent(pathname));hooks.flush();for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));
   if(pathname!=='/password/setup/owner'){
    assert.equal(calls.filter(c=>c.path.startsWith(ownerRoot)).length,0,'ordinary setup must not invoke owner API, even with a saved owner operation');
    const link=anchors.find(a=>a.href==='/password/setup/owner');assert(link,'explicit owner navigation exists');assert.equal(link.onClick,undefined,'owner admission starts by top-level navigation, not API fetch');assert.equal(link.target,undefined);
   }else{assert(calls.some(c=>c.path===ownerRoot+'/context'));assert(calls.some(c=>c.path===ownerRoot+'/status'));assert(!calls.some(c=>c.path.includes('/recipient/')));assert(anchors.some(a=>a.href==='/password/setup'));}
  };
  if(negative){await assert.rejects(route('/password/setup'),e=>e instanceof assert.AssertionError&&e.message.includes('ordinary setup must not invoke owner API'));results.push({name:'negative control detects owner controller accidentally remounted on recipient route',passed:true});}
  else for(const path of ['/password/setup','/password/setup/legacy','/password/setup/owner']){await route(path);results.push({name:path,passed:true});}
 }
 const files=['src/web/main.tsx','src/web/administration/index.ts','src/web/administration/password-setup.tsx','src/web/administration/password-setup-view.tsx','tests/client/web/check-setup-entry-routing.mjs'];const report={passed:true,scope:'actual routing and controllers with controlled browser host; no external Access or production checks',results,sourceHashes:Object.fromEntries(await Promise.all(files.map(async p=>[p,createHash('sha256').update(await readFile(p)).digest('hex')])))};await mkdir('.local/evidence',{recursive:true});await writeFile('.local/evidence/setup-entry-routing.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:true,groups:results.length}));
}finally{hooks.reset();delete globalThis.__setupRouteRender;await rm(directory,{recursive:true,force:true});}
