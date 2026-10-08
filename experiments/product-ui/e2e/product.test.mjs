// Run only in the same approved PR CI Chromium environment. Synthetic I2 service,
// HTTP-only loopback fixture cookie and encrypted DraftVault. No real Access login.
import {test as nodeTest,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
import {build} from 'vite';
import {createBarrier,safePageLocation,gateFailureMessage} from './barrier.mjs';
import {selectedFixtureSession} from './session-fixture.mjs';
import {phase,resourcePhase,trace} from './trace.mjs';
import {enterFixtureRoot} from './fixture-root.mjs';
import {issueBodyReady} from './issue-ready.mjs';
function test(name,run){return nodeTest(name,t=>phase(t,'scenario_body',()=>run(t),70000));}
function reportBarrierTimeout(label){
  trace('S00',label==='POST /v1/workspaces/:id/commands'?'gate_command':'gate_projects','timeout');
}
const root=resolve(import.meta.dirname,'..');
const core=resolve(process.env.PROJEKTOR_CORE_SOURCE??resolve(root,'../projektor_agent_workflow_20261008/experiments/atomic-command-poc'));
const {startHarness}=await phase(null,'suite_import',()=>import(pathToFileURL(resolve(core,'browser-test/server.mjs'))),15000);
let browser,restoreFixtureRoot=()=>{};
before(async()=>{
  await phase(null,'fixture_build',()=>build({root,configFile:resolve(root,'fixture.config.mjs')}),30000);
  restoreFixtureRoot=enterFixtureRoot(core);
  browser=await resourcePhase(null,'browser_launch',()=>chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true,args:['--no-sandbox']}),'browser_close',value=>value.close(),20000);
});
after(async()=>{try{if(browser)await phase(null,'browser_close',()=>browser.close(),10000);}finally{restoreFixtureRoot();}});
async function setup(t,{bootstrapMode='one'}={}){
  let h,context;const requests=[],errors=[],cleanupGates=[];
  t.after(async()=>{
    for(const release of cleanupGates)release();let failure;
    try{if(context)await phase(t,'context_close',()=>context.close(),10000);}catch(error){failure=error;}
    try{if(h)await phase(t,'fixture_close',()=>h.close(),10000);}catch(error){failure??=error;}
    if(failure)throw failure;
  });
  h=await resourcePhase(t,'fixture_start',()=>startHarness(),'fixture_close',value=>value.close(),20000);
  context=await resourcePhase(t,'context_open',()=>browser.newContext(),'context_close',value=>value.close(),10000);
  context.setDefaultTimeout(10000);context.setDefaultNavigationTimeout(20000);
  await phase(t,'fixture_login',()=>h.login(context,'A'),10000);
  await phase(t,'fixture_seed',async()=>{
    await h.control('sql','UPDATE project SET title=? WHERE id=?',['Primary UI fixture project',h.ids.project]);
    await h.control('sql','UPDATE project SET title=? WHERE id=?',['Secondary UI fixture project',h.ids.otherProject]);
  },10000);
  await context.route(h.base+'/**',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname==='/v1/session'){
      // Fixture compatibility only. Product client keeps its strict selected
      // workspace contract; no production route is changed by this test.
      try{
        const result=await selectedFixtureSession({url:url.href,method:route.request().method(),workspaceId:h.ids.workspace,readVerifiedSession:async()=>{
          const response=await context.request.get(h.base+'/v1/session',{timeout:10000,maxRedirects:0});
          if(response.headers()['content-type']?.split(';')[0].trim()!=='application/json')throw Error('FIXTURE_SESSION_PROTOCOL_ERROR');
          return {status:response.status(),body:await response.json()};
        }});
        await route.fulfill({status:result.status,json:result.body,headers:{'cache-control':'no-store'}});
      }catch{await route.fulfill({status:502,json:{error:{code:'FIXTURE_SESSION_UNAVAILABLE'}}});}
      return;
    }
    if(url.pathname==='/v1/bootstrap'){
      try{
      const sourceSession=await context.request.get(h.base+'/v1/session',{timeout:10000,maxRedirects:0});
      if(sourceSession.status()!==200||sourceSession.headers()['content-type']?.split(';')[0].trim()!=='application/json'){await route.fulfill({status:sourceSession.status()===200?502:sourceSession.status(),json:{error:{code:'FIXTURE_BOOTSTRAP_UNAVAILABLE'}}});return;}
      const session=await sourceSession.json();
      let workspaces=[{workspaceId:session.workspaceId,workspaceEpoch:session.workspaceEpoch,principalId:session.principalId,name:'Fixture workspace'}];
      if(bootstrapMode==='zero')workspaces=[];
      if(bootstrapMode==='multi')workspaces.push({workspaceId:'00000000-0000-4000-8000-000000000099',workspaceEpoch:'00000000-0000-4000-8000-000000000098',principalId:session.principalId,name:'Second fixture workspace'});
      await route.fulfill({json:{principalId:bootstrapMode==='zero'?null:session.principalId,actorKind:'human',workspaces,expiresAt:session.expiresAt,serverTime:Date.now(),renewalMode:'not-connected'}});
      }catch{await route.fulfill({status:502,json:{error:{code:'FIXTURE_BOOTSTRAP_UNAVAILABLE'}}});}
      return;
    }
    if(url.pathname==='/'||url.pathname.startsWith('/assets/')){
      const file=url.pathname==='/'?'fixture.html':url.pathname.slice(1);
      const contentType=extname(file)==='.html'?'text/html':extname(file)==='.css'?'text/css':'text/javascript';
      await route.fulfill({body:await readFile(resolve(root,'dist-fixture',file)),contentType});return;
    }
    if(url.pathname.startsWith('/v1/workspaces/'))requests.push(route.request().method()+' '+url.pathname);
    await route.continue();
  });
  const page=await phase(t,'page_open',()=>context.newPage(),10000);page.on('pageerror',e=>errors.push(e.message));
  return {t,h,context,page,requests,errors,cleanupGates,setBootstrapMode:mode=>{bootstrapMode=mode;}};
}
async function createIssue(f){
  await phase(f.t,'create_navigate',()=>f.page.goto(f.h.base+'/'),25000);
  await phase(f.t,'create_project',()=>f.page.getByRole('button',{name:'Create issue in Primary UI fixture project',exact:true}).click(),15000);
  await phase(f.t,'create_fields',async()=>{
    await f.page.getByRole('textbox',{name:'Title',exact:true}).fill('UI acceptance issue');
    await f.page.getByRole('textbox',{name:'Markdown body',exact:true}).fill('original 日本語');
    await f.page.getByRole('textbox',{name:'Assignee principal ID',exact:true}).fill(f.h.ids.actorA);
  },35000);
  await phase(f.t,'create_save',async()=>{
    await f.page.getByRole('button',{name:'Save',exact:true}).click();
    await f.page.getByText('Saved snapshot confirmed.',{exact:false}).waitFor();
    assert.equal(await f.page.getByRole('button',{name:'Save',exact:true}).isDisabled(),true);
  },25000);
  await phase(f.t,'create_open',async()=>{
    await f.page.getByRole('button',{name:'Open created issue',exact:true}).click();
    await f.page.waitForFunction(issueBodyReady,undefined,{timeout:10000});
    await f.page.getByRole('textbox',{name:'Markdown body',exact:true}).waitFor();
  },25000);
}
test('zero and multi bootstrap send no workspace-scoped query before valid selection',async t=>{
  for(const mode of ['zero','multi']){
    const f=await setup(t,{bootstrapMode:mode});await f.page.goto(f.h.base+'/');
    await f.page.getByRole('heading',{name:mode==='zero'?'No workspace access':'Choose a workspace',exact:true}).waitFor();
    assert.equal(f.requests.length,0);
    if(mode==='multi'){await f.page.getByRole('button',{name:'Fixture workspace',exact:true}).click();await f.page.getByRole('heading',{name:'My Issues',exact:true}).waitFor();}
    assert.deepEqual(f.errors,[]);
  }
});
test('create, detail, comment, priority and shared list/board keyboard routes',async t=>{
  const f=await setup(t);await createIssue(f);
  await f.page.getByLabel('Editor',{exact:true}).selectOption('add-comment');
  await f.page.getByRole('textbox',{name:'Comment Markdown',exact:true}).fill('comment without reason');
  await f.page.getByRole('button',{name:'Save',exact:true}).click();await f.page.getByText('Saved snapshot confirmed.',{exact:false}).waitFor();
  await f.page.getByLabel('Editor',{exact:true}).selectOption('priority');await f.page.getByLabel('Priority',{exact:true}).selectOption('P0');
  await f.page.getByRole('button',{name:'Save',exact:true}).click();await f.page.getByText('Saved snapshot confirmed.',{exact:false}).waitFor();
  await f.page.getByRole('button',{name:'Board',exact:true}).click();
  await f.page.getByRole('button',{name:'UI acceptance issue',exact:true}).waitFor();
  const title=f.page.getByRole('button',{name:'UI acceptance issue',exact:true});await title.focus();await f.page.keyboard.press('Enter');
  await f.page.getByRole('textbox',{name:'Markdown body',exact:true}).waitFor();
  await f.page.getByRole('button',{name:'Load authorized history',exact:true}).click();
  await f.page.locator('details').first().waitFor();assert.ok((await f.page.locator('details').count())>0);
  assert.deepEqual(f.errors,[]);
});
test('protected latest text survives reload and old commit acknowledgement cannot erase newer input',async t=>{
  const f=await setup(t);await createIssue(f);
  const body=f.page.getByRole('textbox',{name:'Markdown body',exact:true});
  await phase(f.t,'draft_protect',async()=>{await body.fill('protected draft 日本語');await f.page.getByText('Unsaved changes · protected',{exact:false}).waitFor();});
  f.page.on('dialog',dialog=>dialog.accept());await phase(f.t,'draft_reload',()=>f.page.reload(),25000);
  await phase(f.t,'draft_verify',async()=>{await body.waitFor();assert.equal(await body.inputValue(),'protected draft 日本語');});
  let commandRouteMatched=false,commandResponseReady=false;
  const gate=createBarrier({label:'POST /v1/workspaces/:id/commands',onTimeout:reportBarrierTimeout,diagnostics:()=>({location:safePageLocation(f.page.url()),routeMatched:commandRouteMatched,upstreamResponseReady:commandResponseReady,observedWorkspaceRequests:f.requests.length})});
  f.cleanupGates.push(()=>gate.release());
  await f.page.route('**/v1/workspaces/*/commands',async route=>{
    try{commandRouteMatched=true;const response=await route.fetch({timeout:10000});commandResponseReady=true;gate.enter();await gate.holdResponse();await route.fulfill({response});}
    catch(error){f.errors.push(gateFailureMessage(error));await route.abort('failed').catch(()=>{});}finally{gate.release();}
  });
  try{
    await phase(f.t,'late_send',async()=>{await f.page.getByRole('button',{name:'Save',exact:true}).click();await gate.waitForRequest();},25000);
    await phase(f.t,'late_edit',async()=>{await body.fill('newer unsent input');gate.release();await f.page.getByText('Saved snapshot confirmed.',{exact:false}).waitFor();});
    await phase(f.t,'late_verify',async()=>{assert.equal(await body.inputValue(),'newer unsent input');assert.deepEqual(f.errors,[]);});
  }finally{gate.release();}
});
test('principal change and resource revocation never restore former plaintext',async t=>{
  const f=await setup(t);await createIssue(f);const body=f.page.getByRole('textbox',{name:'Markdown body',exact:true});
  await phase(f.t,'draft_protect',async()=>{await body.fill('private retained draft');await f.page.getByText('Unsaved changes · protected',{exact:false}).waitFor();});
  await phase(f.t,'revoke_access',async()=>{await f.h.control('revokeCurrentProject');await f.page.getByRole('button',{name:'Verify session and reload current data',exact:true}).click();});
  await phase(f.t,'revoke_lock',async()=>{await f.page.getByText('Editor locked',{exact:false}).waitFor();assert.equal(await body.count(),0);assert.ok(!(await f.page.locator('main').textContent()).includes('private retained draft'));});
  await phase(f.t,'other_identity',async()=>{await f.h.login(f.context,'B');f.page.on('dialog',dialog=>dialog.accept());await f.page.reload();},25000);
  await phase(f.t,'other_identity_verify',async()=>{await body.waitFor();assert.equal(await body.inputValue(),'original 日本語');assert.ok(!(await f.page.locator('main').textContent()).includes('private retained draft'));assert.deepEqual(f.errors,[]);});
});
test('320px layout has no document overflow and controls have names',async t=>{
  const f=await setup(t);await createIssue(f);await f.page.setViewportSize({width:320,height:800});
  assert.ok(await f.page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  assert.equal(await f.page.locator('button').evaluateAll(buttons=>buttons.filter(b=>!b.textContent.trim()&&!b.getAttribute('aria-label')).length),0);
  assert.deepEqual(f.errors,[]);
});
test('human done/reopen and unassignment agree with the board query',async t=>{
  const f=await setup(t);await createIssue(f);
  await f.page.getByLabel('Editor',{exact:true}).selectOption('transition');
  await f.page.getByLabel('New status',{exact:true}).selectOption('done');
  await f.page.getByRole('textbox',{name:'Result summary',exact:true}).fill('Verified UI result');
  await f.page.getByRole('button',{name:'Save',exact:true}).click();await f.page.getByText('Saved snapshot confirmed.',{exact:false}).waitFor();
  await f.page.getByRole('button',{name:'Board',exact:true}).click();
  await f.page.getByText('No issues match this filter',{exact:true}).waitFor();
  await f.page.getByLabel('Show',{exact:false}).selectOption('all');
  await f.page.getByRole('button',{name:'UI acceptance issue',exact:true}).click();
  await f.page.getByLabel('Editor',{exact:true}).selectOption('transition');
  await f.page.getByLabel('New status',{exact:true}).selectOption('ready');await f.page.getByRole('textbox',{name:'Reason',exact:true}).fill('Reopen for next check');
  await f.page.getByRole('button',{name:'Save',exact:true}).click();await f.page.getByText('Saved snapshot confirmed.',{exact:false}).waitFor();
  await f.page.getByLabel('Editor',{exact:true}).selectOption('assign');await f.page.getByRole('textbox',{name:'Assignee principal ID',exact:true}).fill('');
  await f.page.getByRole('button',{name:'Save',exact:true}).click();await f.page.getByText('Saved snapshot confirmed.',{exact:false}).waitFor();
  await f.page.getByRole('button',{name:'Board',exact:true}).click();await f.page.getByText('No issues match this filter',{exact:true}).waitFor();
  assert.deepEqual(f.errors,[]);
});
test('storage failure blocks internal navigation and keeps the latest in-memory text',async t=>{
  const f=await setup(t);await createIssue(f);
  const before=f.page.url();
  await f.page.evaluate(()=>{window.fixtureTransaction=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(){throw new DOMException('Synthetic quota failure','QuotaExceededError');};});
  const body=f.page.getByRole('textbox',{name:'Markdown body',exact:true});await body.fill('must remain on this page');
  await f.page.getByText('protection-failed',{exact:false}).waitFor();
  await f.page.getByRole('button',{name:'Board',exact:true}).click();await f.page.getByText('Navigation stopped:',{exact:false}).waitFor();
  assert.equal(f.page.url(),before);assert.equal(await body.inputValue(),'must remain on this page');
  await f.page.evaluate(()=>{IDBDatabase.prototype.transaction=window.fixtureTransaction;delete window.fixtureTransaction;});
  assert.deepEqual(f.errors,[]);
});
test('IME Enter never triggers an implicit save',async t=>{
  const f=await setup(t);await createIssue(f);
  const body=f.page.getByRole('textbox',{name:'Markdown body',exact:true});const posts=f.requests.filter(x=>x.startsWith('POST ')).length;
  await body.focus();await body.dispatchEvent('compositionstart');await body.dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true});await body.dispatchEvent('compositionend',{data:'日本語'});
  assert.equal(f.requests.filter(x=>x.startsWith('POST ')).length,posts);assert.deepEqual(f.errors,[]);
});
test('delayed project titles cannot reappear after same-principal grant revocation and resume',async t=>{
  const f=await setup(t);let projectReads=0,firstProjectResponseReady=false;
  const gate=createBarrier({label:'GET /v1/workspaces/:id/projects',onTimeout:reportBarrierTimeout,diagnostics:()=>({location:safePageLocation(f.page.url()),routeMatched:projectReads>0,upstreamResponseReady:firstProjectResponseReady,observedProjectRequests:projectReads})});
  f.cleanupGates.push(()=>gate.release());
  await f.page.route('**/v1/workspaces/*/projects?*',async route=>{
    projectReads++;
    if(projectReads!==1){await route.continue();return;}
    try{
      const response=await route.fetch({timeout:10000});firstProjectResponseReady=true;gate.enter();await gate.holdResponse();
      try{await route.fulfill({response});}catch{/* Expected when the obsolete request was aborted. */}
    }catch(error){f.errors.push(gateFailureMessage(error));await route.abort('failed').catch(()=>{});}finally{gate.release();}
  });
  try{
    await f.page.goto(f.h.base+'/');await gate.waitForRequest();
    await f.h.control('revokeCurrentProject');
    await f.page.evaluate(()=>{const c=new BroadcastChannel('projektor-session');c.postMessage({changed:true});c.close();});
    await f.page.getByRole('button',{name:'Create issue in Secondary UI fixture project',exact:true}).waitFor();
    gate.release();await new Promise(r=>setTimeout(r,50));
    assert.equal(await f.page.getByRole('button',{name:'Create issue in Primary UI fixture project',exact:true}).count(),0);
    assert.equal(await f.page.getByRole('button',{name:'Create issue in Secondary UI fixture project',exact:true}).count(),1);
    assert.ok(projectReads>=2);assert.deepEqual(f.errors,[]);
  }finally{gate.release();}
});
test('canceling workspace selection preserves route, latest draft and keyboard focus',async t=>{
  const f=await setup(t);await createIssue(f);
  const body=f.page.getByRole('textbox',{name:'Markdown body',exact:true});await body.fill('retained while choosing workspace');
  const url=f.page.url();await f.page.getByRole('button',{name:'Choose workspace',exact:true}).click();
  await f.page.getByRole('button',{name:'Cancel workspace selection',exact:true}).click();
  assert.equal(f.page.url(),url);assert.equal(await body.inputValue(),'retained while choosing workspace');
  assert.equal(await f.page.evaluate(()=>document.activeElement?.textContent),'Choose workspace');
  assert.deepEqual(f.errors,[]);
});

test('temporary missing membership keeps unpersisted input locked in memory until exact access revalidation',async t=>{
  const f=await setup(t);await createIssue(f);
  await f.page.evaluate(()=>{window.fixtureTransaction=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(){throw new DOMException('Synthetic storage failure','QuotaExceededError');};});
  const body=f.page.getByRole('textbox',{name:'Markdown body',exact:true});
  await phase(f.t,'storage_fault',async()=>{await body.fill('latest unpersisted revision');await f.page.getByText('protection-failed',{exact:false}).waitFor();});
  await phase(f.t,'membership_remove',async()=>{f.setBootstrapMode('zero');await f.page.evaluate(()=>{const c=new BroadcastChannel('projektor-session');c.postMessage({changed:true});c.close();});});
  await phase(f.t,'membership_locked',async()=>{await f.page.getByRole('heading',{name:'No workspace access',exact:true}).waitFor();assert.equal(await body.count(),0);assert.ok(!(await f.page.locator('main').textContent()).includes('latest unpersisted revision'));});
  await phase(f.t,'membership_restore',async()=>{await f.page.evaluate(()=>{IDBDatabase.prototype.transaction=window.fixtureTransaction;delete window.fixtureTransaction;});f.setBootstrapMode('one');await f.page.getByRole('button',{name:'Recheck workspace access',exact:true}).click();});
  await phase(f.t,'membership_verify',async()=>{await body.waitFor();assert.equal(await body.inputValue(),'latest unpersisted revision');assert.deepEqual(f.errors,[]);});
});
test('native Back is canceled when protection fails, then Back/Forward restores the same protected draft',async t=>{
  const f=await setup(t);await createIssue(f);
  const body=f.page.getByRole('textbox',{name:'Markdown body',exact:true});const detailURL=f.page.url();
  await f.page.evaluate(()=>{window.fixtureTransaction=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(){throw new DOMException('Synthetic storage failure','QuotaExceededError');};});
  await body.fill('native history retained draft');await f.page.getByText('protection-failed',{exact:false}).waitFor();
  await f.page.evaluate(()=>history.back());await f.page.getByText('Navigation stopped:',{exact:false}).waitFor();
  assert.equal(f.page.url(),detailURL);assert.equal(await body.inputValue(),'native history retained draft');
  await f.page.evaluate(()=>{IDBDatabase.prototype.transaction=window.fixtureTransaction;delete window.fixtureTransaction;history.back();});
  await f.page.getByRole('heading',{name:'Create issue',exact:true}).waitFor();
  await f.page.evaluate(()=>history.forward());await body.waitFor();
  assert.equal(f.page.url(),detailURL);assert.equal(await body.inputValue(),'native history retained draft');assert.deepEqual(f.errors,[]);
});
