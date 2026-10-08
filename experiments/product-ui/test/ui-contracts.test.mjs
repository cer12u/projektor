import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {checkBootstrap,chooseWorkspace,missingProductPorts} from '../src/contracts.ts';
import {parseRoute,routeURL,nextRoute,UIRouter} from '../src/router.ts';
let vite,components,fixtures;
before(async()=>{vite=await createServer({server:{middlewareMode:true},appType:'custom'});components=await vite.ssrLoadModule('/src/components.tsx');fixtures=(await vite.ssrLoadModule('/fixtures/pages.ts')).pageFixtures;});
after(async()=>vite?.close());
const uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const workspace=n=>({id:uuid(n),epoch:uuid(n+100),title:'Workspace '+n});
const data=items=>({principal:{id:uuid(1),kind:'human',displayName:'Current human'},expiresAt:Date.now()+60000,workspaces:items});
test('bootstrap: zero, sole workspace, multiple choice, deep-link not authorized',()=>{
  const zero=checkBootstrap(data([]));assert.equal(chooseWorkspace(zero,null),null);
  const one=checkBootstrap(data([workspace(2)]));assert.equal(chooseWorkspace(one,null).id,uuid(2));
  const multi=checkBootstrap(data([workspace(2),workspace(3)]));assert.equal(chooseWorkspace(multi,null),null);assert.equal(chooseWorkspace(multi,uuid(3)).id,uuid(3));
  assert.throws(()=>chooseWorkspace(multi,uuid(4)),/UNAVAILABLE/);
  assert.throws(()=>checkBootstrap(data([workspace(2),workspace(2)])),/INVALID/);
  assert.throws(()=>checkBootstrap({...one,expiresAt:1}),/INVALID/);
});
test('product entry is explicitly unconnected and never simulates bootstrap success',async()=>{await assert.rejects(missingProductPorts.bootstrap({signal:new AbortController().signal}),/UNCONNECTED/);});
test('URL roundtrip stores only validated identifiers and filters',()=>{
  const route=parseRoute('/?view=issue&issueId='+uuid(9)+'&workspaceId='+uuid(2));
  const next=nextRoute(route,{draftId:uuid(10),projectAtProtection:uuid(4),status:'all'});
  assert.deepEqual(parseRoute(routeURL(next)),next);
  for(const url of ['//evil.invalid/','https://evil.invalid/','/?token=secret','/?view=issue','/?workspaceId=email','/?status=all&status=unresolved','/?view=list#secret','/\\evil.invalid','/?view=unknown'])assert.throws(()=>parseRoute(url),/INVALID/);
});
test('all fixture states preserve separate empty, partial, error, expired and denied semantics',()=>{
  const messages=Object.values(fixtures).map(components.listMessage);assert.equal(new Set(messages).size,messages.length);
  for(const [name,state]of Object.entries(fixtures)){
    const html=renderToStaticMarkup(createElement(components.IssueRows,{state,board:true,onOpen(){}}));
    if(['loading','error','forbidden','expired','stale'].includes(name))assert.equal(html,'');
    else assert.ok(html.includes('My issues board'));
    assert.ok(!html.includes('<script>'));
  }
});
test('board and list render the exact same loaded issue titles, without a second query/filter',()=>{
  for(const board of [false,true]){
    const html=renderToStaticMarkup(createElement(components.IssueRows,{state:fixtures.ready,board,onOpen(){}}));
    assert.equal((html.match(/never execute/g)||[]).length,3);assert.ok(html.includes('&lt;script&gt;'));
  }
});
test('history states unknown original time and incomplete coverage without fabricating it',()=>{
  const html=renderToStaticMarkup(createElement(components.History,{state:{history:[{id:uuid(1),contentKind:'issue_body',contentMarkdown:'raw\r\n日本語',resourceVersionAtCommit:2,originalAuthorRef:{sourceAuthorId:'deleted-source-author'}}],historyCode:null}}));
  assert.match(html,/Time unknown/);assert.match(html,/deleted-source-author/);assert.match(html,/not established/);
});
test('comment and history content is escaped, never unsanitized HTML',()=>{
  const html=renderToStaticMarkup(createElement(components.EntryList,{entries:[{id:uuid(1),kind:'comment',bodyMarkdown:'<img src=x onerror=alert(1)>',version:1,authorRef:{kind:'machine',sourceAuthorId:'agent'}}],onEdit(){}}));
  assert.ok(!html.includes('<img'));assert.match(html,/Agent/);assert.match(html,/Edit comment/);
});
test('late save message distinguishes confirmed snapshot from newer draft',()=>assert.match(components.editorMessage({phase:'committed',record:{journal:{effectApplied:true}}}),/Newer input/));
function mockWindow(){
  const w=new EventTarget();const stack=[{url:'/',state:null}];let i=0;
  w.location={pathname:'/',search:''};
  function apply(){const url=new URL(stack[i].url,'https://ui.invalid');w.location={pathname:url.pathname,search:url.search};}
  w.history={get state(){return stack[i].state;},replaceState(state,_unused,url){stack[i]={state,url};apply();},pushState(state,_unused,url){stack.splice(i+1);stack.push({state,url});i++;apply();},go(delta){if(!stack[i+delta])return;i+=delta;apply();queueMicrotask(()=>{const e=new Event('popstate');e.state=stack[i].state;w.dispatchEvent(e);});}};
  return w;
}
test('navigation checks protected latest revision before URL mutation and preserves canceled history',async()=>{
  const win=mockWindow(),r=new UIRouter(win);r.prepare=async()=>false;
  assert.equal(await r.go(nextRoute(r.route,{view:'board'})),false);assert.equal(r.route.view,'list');assert.match(r.error,/stopped/);
  r.prepare=async()=>true;assert.equal(await r.go(nextRoute(r.route,{view:'board'})),true);
  r.prepare=async()=>false;win.history.go(-1);await new Promise(r=>setTimeout(r,30));assert.equal(r.route.view,'board');assert.match(win.location.search,/view=board/);
  r.prepare=async()=>true;win.history.go(-1);await new Promise(r=>setTimeout(r,30));assert.equal(r.route.view,'list');
  r.dispose();
});
test('zero membership may have no application principal; selected stores may bind different principals',()=>{
  const zero=checkBootstrap({...data([]),principal:null});assert.equal(zero.principal,null);
  const a={...workspace(2),principal:{id:uuid(5),kind:'human',displayName:uuid(5)}};
  const b={...workspace(3),principal:{id:uuid(6),kind:'human',displayName:uuid(6)}};
  const multi=checkBootstrap({...data([a,b]),principal:null});assert.equal(chooseWorkspace(multi,uuid(3)).principal.id,uuid(6));
  assert.throws(()=>checkBootstrap({...data([workspace(2)]),principal:null}),/INVALID/);
});
test('Markdown input preserves untouched CRLF, Unicode, unknown syntax and frontmatter',async()=>{
  const {preserveMarkdownInput}=await import('../src/markdown.ts');
  const raw='---\r\ncustom: 日本語\r\n---\r\n<unrecognized>\r\n';
  assert.equal(preserveMarkdownInput(raw,raw.replaceAll('\r\n','\n')),raw);
  assert.equal(preserveMarkdownInput(raw,raw.replaceAll('\r\n','\n')+'more\n'),raw+'more\r\n');
});
test('product adapter maps per-workspace identity and calls selected session without falling back',async()=>{
  const {createProductPorts}=await vite.ssrLoadModule('/src/product-ports.ts');
  const wire={principalId:null,actorKind:'human',expiresAt:Date.now()+60000,workspaces:[{workspaceId:uuid(2),workspaceEpoch:uuid(3),principalId:uuid(4),name:'Selected store'}]};
  const calls=[];
  const ports=createProductPorts({baseUrl:'https://product.test',fetchImpl:async url=>{
    calls.push(new URL(url));if(calls.length===1)return Response.json(wire);
    return Response.json({principalId:uuid(4),workspaceId:uuid(2),workspaceEpoch:uuid(3),sessionId:uuid(9),actorKind:'human',authzVersion:1,expiresAt:Date.now()+60000,scopes:[]});
  }});
  const b=checkBootstrap(await ports.bootstrap({signal:new AbortController().signal}));assert.equal(b.principal,null);
  const selected={principal:b.workspaces[0].principal,workspace:b.workspaces[0]};
  assert.equal((await ports.session(selected)).principalId,uuid(4));assert.equal(calls[1].searchParams.get('workspaceId'),uuid(2));
  assert.ok(calls.every(url=>url.origin==='https://product.test'));
  await assert.rejects(ports.session({...selected,principal:{...selected.principal,id:uuid(99)}}),/BINDING_MISMATCH/);
});
test('history storage exceptions cannot change the current route or index',async()=>{
  const win=mockWindow(),r=new UIRouter(win),before=routeURL(r.route),index=r.index;
  win.history.pushState=()=>{throw new DOMException('synthetic history failure','SecurityError');};
  assert.equal(await r.go(nextRoute(r.route,{view:'board'})),false);
  assert.equal(routeURL(r.route),before);assert.equal(r.index,index);assert.match(r.error,/stopped/);
  win.history.replaceState=()=>{throw new DOMException('synthetic metadata failure','SecurityError');};
  r.replace(nextRoute(r.route,{view:'board'}));assert.equal(routeURL(r.route),before);assert.equal(r.index,index);
  assert.match(r.error,/metadata/);r.dispose();
});
test('initial bootstrap registry is bounded to ten workspaces, never silently widened',()=>{
  assert.equal(checkBootstrap(data(Array.from({length:10},(_,i)=>workspace(i+2)))).workspaces.length,10);
  assert.throws(()=>checkBootstrap(data(Array.from({length:11},(_,i)=>workspace(i+2)))),/INVALID/);
});
test('original source author name, unresolved identity and unknown time stay explicit',()=>{
  const author={sourceDisplayNameRaw:'元作者 山田',sourceAuthorId:'legacy-17',resolution:'deleted'};
  const html=renderToStaticMarkup(createElement(components.EntryList,{entries:[{id:uuid(1),kind:'comment',bodyMarkdown:'source text',version:1,authorRef:author,createdAt:null}],onEdit(){}}));
  assert.match(html,/元作者 山田/);assert.match(html,/legacy-17/);assert.match(html,/deleted/);assert.match(html,/Time unknown/);assert.ok(!html.includes('Original time null'));
  const history=renderToStaticMarkup(createElement(components.History,{state:{history:[{id:uuid(9),originalAuthorRef:author,contentMarkdown:'source',timeQuality:'estimated',sourceEditedAtRaw:'legacy-clock-raw',recordedBy:'importer-id',recordedAt:123,origin:'legacy'}]}}));
  assert.match(history,/Time quality: estimated/);assert.match(history,/Source edited time: legacy-clock-raw/);assert.match(history,/Recorded by: importer-id/);
});
test('manual/automatic receipt budgets and protection failures are visible and distinct',()=>{
  for(const kind of ['budget-exhausted','manual-budget-exhausted','retry-floor','protection-failed','pending','stopped'])assert.equal(typeof components.actionResultText({kind}),'string');
  assert.match(components.actionResultText({kind:'budget-exhausted'}),/receipt-only/);
  assert.match(components.actionResultText({kind:'manual-budget-exhausted'}),/no resend/);
  assert.notEqual(components.actionResultText({kind:'budget-exhausted'}),components.actionResultText({kind:'manual-budget-exhausted'}));
  assert.equal(components.actionResultText({kind:'committed'}),null);
});
test('absent then restored exact membership retains the controller binding object; other principal or epoch replaces it',async()=>{
  const {retainViewSelection}=await import('../src/contracts.ts');
  const selected={principal:{id:uuid(1),kind:'human',displayName:'A'},workspace:workspace(2)};
  const absent=retainViewSelection(selected,null);assert.equal(absent,selected);
  const restored=retainViewSelection(absent,structuredClone(selected));assert.equal(restored,selected);
  const other={...selected,principal:{...selected.principal,id:uuid(9)}};
  assert.equal(retainViewSelection(restored,other),other);
  const epoch={...selected,workspace:{...selected.workspace,epoch:uuid(99)}};
  assert.equal(retainViewSelection(restored,epoch),epoch);
});
