import {test} from 'node:test';
import assert from 'node:assert/strict';
import {UIRouter,parseRoute,nextRoute,isLegacyLocation} from '../src/router.ts';
import {boundLegacyTarget,legacyNativePath,resolveLegacyNavigation} from '../src/legacy-navigation.ts';

const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const selected={principal:{id:id(1),kind:'human',displayName:'Synthetic human'},workspace:{id:id(2),epoch:id(3),title:'Synthetic workspace'}};
const target={kind:'issue',id:id(4),canonicalPath:`/?view=issue&workspaceId=${id(2)}&issueId=${id(4)}`};
function mockWindow(initial){
  const w=new EventTarget(),stack=[{url:initial,state:null}];let i=0;
  const apply=()=>{const u=new URL(stack[i].url,'https://ui.invalid');w.location={pathname:u.pathname,search:u.search,hash:u.hash};};apply();
  w.history={get state(){return stack[i].state;},replaceState(state,_unused,url){stack[i]={state,url};apply();},pushState(state,_unused,url){stack.splice(i+1);stack.push({state,url});i++;apply();},go(delta){if(!stack[i+delta])return;i+=delta;apply();queueMicrotask(()=>{const e=new Event('popstate');e.state=stack[i].state;w.dispatchEvent(e);});}};
  return w;
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,30));

test('direct legacy paths survive constructor and workspace choice; no resolution before selection',async()=>{
  for(const path of ['/projects/CURRENT/issues/12/old-title','/projects/CURRENT/issues/12/','/wiki/'+encodeURIComponent('日本語'),'/projects/view/current-project']){
    const w=mockWindow(path),r=new UIRouter(w);let reads=0;
    const ports={legacyURL:async()=>{reads++;return target;}};
    assert.equal(r.legacyPath,path);assert.equal(w.location.pathname,path);assert.equal(r.pendingLocation,true);
    assert.equal(await resolveLegacyNavigation(r,ports,selected,{signal:new AbortController().signal}),'stale');assert.equal(reads,0);
    r.bindWorkspace(selected.workspace.id);assert.equal(w.location.pathname,path);
    assert.equal(await resolveLegacyNavigation(r,ports,selected,{signal:new AbortController().signal}),'resolved');
    assert.equal(r.route.issueId,target.id);assert.equal(r.route.workspaceId,selected.workspace.id);assert.equal(r.index,0);assert.equal(r.pendingLocation,false);r.dispose();
  }
});

test('unsupported locations stay unavailable without constructor exceptions or home rewrites',()=>{
  for(const path of ['/unknown','/wiki/','/wiki/bad%2Fslug','/wiki/%ZZ','/projects/CURRENT/issues/0/name','/projects/CURRENT/issues/1/name?token=x','/?view=unknown','/?view=list#fragment']){
    const w=mockWindow(path),r=new UIRouter(w);assert.equal(r.unavailable,true,path);assert.equal(r.legacyPath,null);assert.equal(w.location.pathname+w.location.search+w.location.hash,path);r.bindWorkspace(selected.workspace.id);assert.equal(w.location.pathname+w.location.search+w.location.hash,path);r.dispose();
  }
  for(const path of ['https://elsewhere.invalid/wiki/a','//elsewhere.invalid/wiki/a','/wiki/..','/wiki/%2e%2e','/wiki/a\\b'])assert.equal(isLegacyLocation(path),false,path);
  assert.throws(()=>parseRoute('/unknown/../'),/ROUTE_INVALID/);
});

test('unknown and denied targets share unavailable result and retain the original address',async()=>{
  for(const code of ['NOT_FOUND','FORBIDDEN','EPOCH_MISMATCH','SELECTION_BINDING_MISMATCH','NETWORK_ERROR']){
    const path='/wiki/missing',w=mockWindow(path),r=new UIRouter(w);r.bindWorkspace(selected.workspace.id);
    const result=await resolveLegacyNavigation(r,{legacyURL:async()=>{throw Error(code);}},selected,{signal:new AbortController().signal});
    assert.equal(result,'unavailable');assert.equal(w.location.pathname,path);assert.equal(w.location.search,'');assert.equal(r.route.pageId,null);r.dispose();
  }
});

test('late results cannot replace newer navigation, workspace selection, hidden view or aborted identity/epoch',async()=>{
  for(const change of ['navigation','workspace','hidden','abort']){
    const r=new UIRouter(mockWindow('/wiki/delayed'));r.bindWorkspace(selected.workspace.id);let finish,visible=true;const abort=new AbortController();
    const result=resolveLegacyNavigation(r,{legacyURL:()=>new Promise(resolve=>{finish=resolve;})},selected,{signal:abort.signal,visible:()=>visible});
    if(change==='navigation')await r.go(nextRoute(r.route,{view:'board'}));
    if(change==='workspace')r.bindWorkspace(id(9));
    if(change==='hidden')visible=false;
    if(change==='abort')abort.abort();
    finish(target);assert.equal(await result,'stale',change);assert.notEqual(r.route.view,'issue');r.dispose();
  }
});

test('response binding and exact computed native destination reject mismatches and redirect payloads',()=>{
  const body={data:target,meta:{workspaceId:id(2),workspaceEpoch:id(3),actorId:id(1)}};
  assert.deepEqual(boundLegacyTarget(body,selected),target);
  for(const key of ['workspaceId','workspaceEpoch','actorId'])assert.throws(()=>boundLegacyTarget({...body,meta:{...body.meta,[key]:id(99)}},selected),/UNAVAILABLE/);
  for(const patch of [{id:id(99)},{kind:'unknown'},{canonicalPath:'https://elsewhere.invalid/'},{canonicalPath:target.canonicalPath+'&draftId='+id(9)},{canonicalPath:'/wiki/untrusted'}])assert.throws(()=>boundLegacyTarget({...body,data:{...target,...patch}},selected),/UNAVAILABLE/);
  for(const kind of ['issue','wiki','project'])assert.equal(parseRoute(legacyNativePath({kind,id:id(4)},id(2))).view,kind==='wiki'?'wiki-page':kind);
});

test('canceled history interrupts an in-flight lookup, then permits fresh resolution of the retained legacy entry',async()=>{
  const w=mockWindow('/?workspaceId='+id(2)),r=new UIRouter(w);await r.goLegacy('/wiki/delayed');let finish,release;
  const pending=resolveLegacyNavigation(r,{legacyURL:()=>new Promise(resolve=>{finish=resolve;})},selected,{signal:new AbortController().signal});
  const generation=r.navigationGeneration;r.prepare=()=>new Promise(resolve=>{release=resolve;});w.history.go(-1);await tick();
  assert.equal(r.busy,true);assert.ok(r.navigationGeneration>generation);finish(target);assert.equal(await pending,'stale');
  release(false);await tick();assert.equal(r.busy,false);assert.equal(r.legacyPath,'/wiki/delayed');
  assert.equal(await resolveLegacyNavigation(r,{legacyURL:async()=>target},selected,{signal:new AbortController().signal}),'resolved');assert.equal(r.route.issueId,target.id);r.dispose();
});

test('legacy navigation and Back/Forward preserve canceled drafts and resolve only the intended entry',async()=>{
  const original=`/?view=issue&workspaceId=${id(2)}&issueId=${id(8)}&draftId=${id(9)}&projectAtProtection=${id(10)}`;
  const w=mockWindow(original),r=new UIRouter(w);r.prepare=async()=>false;
  assert.equal(await r.goLegacy('/wiki/missing'),false);assert.equal(r.route.issueId,id(8));assert.equal(r.route.draftId,id(9));assert.equal(r.pendingLocation,false);
  r.prepare=async()=>true;assert.equal(await r.goLegacy('/wiki/missing'),true);assert.equal(r.route.workspaceId,id(2));assert.equal(r.legacyPath,'/wiki/missing');
  w.history.go(-1);await tick();assert.equal(r.route.issueId,id(8));assert.equal(r.route.draftId,id(9));
  r.prepare=async()=>false;w.history.go(1);await tick();assert.equal(r.route.issueId,id(8));assert.equal(r.pendingLocation,false);
  r.prepare=async()=>true;w.history.go(1);await tick();assert.equal(r.legacyPath,'/wiki/missing');assert.equal(r.error,null);
  assert.equal(await resolveLegacyNavigation(r,{legacyURL:async()=>target},selected,{signal:new AbortController().signal}),'resolved');assert.equal(r.index,1);
  w.history.go(-1);await tick();assert.equal(r.route.draftId,id(9));w.history.go(1);await tick();assert.equal(r.route.issueId,id(4));assert.equal(r.pendingLocation,false);r.dispose();
});
