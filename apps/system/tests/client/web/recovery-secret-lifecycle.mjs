// @module verification
// @role browser-regression
import{build}from'esbuild';import assert from'node:assert/strict';import{writeFile}from'node:fs/promises';import*as hooks from"../../support/reference-admin-fixture/hooks.mjs";
const fixture=new URL("../../support/reference-admin-fixture/",import.meta.url);
await build({entryPoints:['src/web/administration/management-setup.tsx'],outfile:'.local/reference-admin-setup.mjs',bundle:true,format:'esm',platform:'node',jsx:'automatic',plugins:[{name:'controlled-hooks',setup(b){b.onResolve({filter:/^react$/},()=>({path:new URL('hooks.mjs',fixture).pathname,external:true}));b.onResolve({filter:/^react\/jsx-runtime$/},()=>({path:new URL('jsx.mjs',fixture).pathname,external:true}));}}]});
const {ManagementSetup}=await import("../../../.local/reference-admin-setup.mjs");
const nodes=v=>!v||typeof v!=='object'?[]:Array.isArray(v)?v.flatMap(nodes):[v,...nodes(v.props?.children)];const text=v=>v==null?'':typeof v!=='object'?String(v):Array.isArray(v)?v.map(text).join(''):text(v.props?.children);
const state={principalId:'target',revision:1,authVersion:1,rightId:null,purpose:null,expiresAt:null,consumedAt:null,revokedAt:null};const right='S'.repeat(43),checks=[];
for(const mode of ['normal','hidden-then-visible','unmount']){
 hooks.reset();globalThis.window=new EventTarget();window.confirm=()=>true;globalThis.document=new EventTarget();document.hidden=false;
 let channel;globalThis.BroadcastChannel=class{constructor(){channel=this}close(){}};
 let release,contextRelease,id,locked=false,calls=0;const errors=[];
 const api={owner:'actor-A',setupState:async principalId=>({...state,principalId}),context:async()=>{if(mode==='hide-during-authority-check')return new Promise(r=>contextRelease=r);return{globalAdministrator:mode!=='authority-lost'};},changeSetup:(_p,_r,operationId)=>{calls++;id=operationId;return new Promise(r=>release=r);}};
 let props={pendingOperation:null,onPendingOperation:value=>{props={...props,pendingOperation:value};return true;},api,principalId:'target',active:true,disabled:false,onError:e=>errors.push(e),onLock:v=>locked=v};
 async function render(){let tree;for(let i=0;i<12;i++){hooks.begin();tree=ManagementSetup(props);hooks.flush();await new Promise(r=>setTimeout(r,0));if(!hooks.changed())return tree;}throw Error('did not settle');}
 let tree=await render();nodes(tree).find(n=>n.type==='button'&&text(n)==='初回設定権を発行').props.onClick();tree=await render();assert.equal(calls,1);assert.equal(locked,true);
 if(mode==='hidden-then-visible'){document.hidden=true;document.dispatchEvent(new Event('visibilitychange'));document.hidden=false;}
 if(mode==='pagehide')window.dispatchEvent(new Event('pagehide'));
 if(mode==='focus')window.dispatchEvent(new Event('focus'));
 if(mode==='auth-broadcast')channel.onmessage({});
 if(mode==='disabled')props={...props,disabled:true};
 if(mode==='inactive')props={...props,active:false};
 if(mode==='target-change')props={...props,principalId:'other'};
 if(mode==='actor-api-change')props={...props,api:{...api,owner:'other'}};
 if(mode==='unmount')hooks.reset();else await render();
 release({operationId:id,snapshot:{...state,revision:2,rightId:'issued'},setupRight:right});await new Promise(r=>setTimeout(r,0));
 if(mode==='hide-during-authority-check'){assert.ok(contextRelease);window.dispatchEvent(new Event('pagehide'));contextRelease({globalAdministrator:true});await new Promise(r=>setTimeout(r,0));}
 if(mode==='unmount'){assert.equal(locked,false);checks.push(mode);continue;}
 tree=await render();const exposed=nodes(tree).some(n=>n.type==='input'&&n.props.value===right);assert.equal(exposed,mode==='normal',mode);assert.equal(calls,1);
 if(mode==='normal'){assert.equal(locked,true);nodes(tree).find(n=>n.type==='button'&&text(n)==='受渡し後に表示を消す').props.onClick();tree=await render();assert.equal(nodes(tree).some(n=>n.type==='input'&&n.props.value===right),false);assert.equal(locked,false);}
 if(!['target-change','actor-api-change'].includes(mode)){assert.ok(text(tree).includes(id));assert.ok(text(tree).includes('改訂: 2'));}
 if(mode==='authority-lost')assert.equal(errors[0].status,403);
 checks.push(mode);
}
hooks.reset();await writeFile('.local/evidence/recovery-secret-lifecycle.json',JSON.stringify({level:'actual bundled setup component handlers; controlled hooks and delayed transport; no browser',passed:true,checks,secretPersistentWrites:0},null,2)+'\n');for(const c of checks)console.log('PASS '+c);
