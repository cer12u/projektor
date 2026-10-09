// Run only in the approved PR CI Chromium environment. Actual I5 service with synthetic provider,
// HTTP-only loopback fixture cookie and encrypted DraftVault. No real Access login.
import {test as nodeTest,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
import {build} from 'vite';
import {createBarrier,safePageLocation,gateFailureMessage} from './barrier.mjs';
import {phase,resourcePhase,trace,caseID} from './trace.mjs';
import {enterFixtureRoot} from './fixture-root.mjs';
import {issueBodyReady} from './issue-ready.mjs';
function test(name,run){return nodeTest(name,t=>phase(t,'scenario_body',()=>run(t),70000));}
function reportBarrierTimeout(label){
  trace('S00',label==='POST /v1/workspaces/:id/commands'?'gate_command':'gate_projects','timeout');
}
const root=resolve(import.meta.dirname,'..');
const core=resolve(process.env.PROJEKTOR_CORE_SOURCE??resolve(root,'../experiments/atomic-command-poc'));
const {startHarness}=await phase(null,'suite_import',()=>import(pathToFileURL(resolve(core,'browser-test/session-server.mjs'))),15000);
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
  h=await resourcePhase(t,'fixture_start',()=>startHarness({bootstrapMode}),'fixture_close',value=>value.close(),20000);
  context=await resourcePhase(t,'context_open',()=>browser.newContext(),'context_close',value=>value.close(),10000);
  context.setDefaultTimeout(10000);context.setDefaultNavigationTimeout(20000);
  await phase(t,'fixture_login',()=>h.login(context,'A'),10000);
  await phase(t,'fixture_seed',async()=>{
    await h.control('sql','UPDATE project SET title=? WHERE id=?',['Primary UI fixture project',h.ids.project]);
    await h.control('sql','UPDATE project SET title=? WHERE id=?',['Secondary UI fixture project',h.ids.otherProject]);
  },10000);
  await context.route(h.base+'/**',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname==='/'||url.pathname.startsWith('/assets/')){
      const file=url.pathname==='/'?'fixture.html':url.pathname.slice(1);
      const contentType=extname(file)==='.html'?'text/html':extname(file)==='.css'?'text/css':'text/javascript';
      await route.fulfill({body:await readFile(resolve(root,'dist-fixture',file)),contentType});return;
    }
    if(url.pathname.startsWith('/v1/workspaces/'))requests.push(route.request().method()+' '+url.pathname);
    await route.continue();
  });
  const page=await phase(t,'page_open',()=>context.newPage(),10000);page.on('pageerror',e=>errors.push(e.message));
  return {t,h,context,page,requests,errors,cleanupGates,setBootstrapMode:mode=>h.setBootstrapMode(mode)};
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
    if(mode==='multi'){
      await f.page.getByRole('button',{name:f.h.ids.workspace,exact:true}).click();await f.page.getByRole('heading',{name:'My Issues',exact:true}).waitFor();
      const first=await (await f.context.request.get(f.h.base+'/v1/session?workspaceId='+f.h.ids.workspace)).json();assert.equal(first.principalId,f.h.ids.actorA);
      await f.page.getByRole('button',{name:'Choose workspace',exact:true}).click();await f.page.getByRole('button',{name:f.h.ids.secondWorkspace,exact:true}).click();await f.page.getByRole('heading',{name:'My Issues',exact:true}).waitFor();
      const second=await (await f.context.request.get(f.h.base+'/v1/session?workspaceId='+f.h.ids.secondWorkspace)).json();assert.equal(second.principalId,f.h.ids.secondActorA);assert.notEqual(second.principalId,first.principalId);await f.page.locator('header').getByText(f.h.ids.secondActorA+' · Human',{exact:true}).waitFor();assert.ok(f.page.url().includes(f.h.ids.secondWorkspace));
    }
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
  await phase(f.t,'membership_remove',async()=>{await f.setBootstrapMode('zero');await f.page.evaluate(()=>{const c=new BroadcastChannel('projektor-session');c.postMessage({changed:true});c.close();});});
  await phase(f.t,'membership_locked',async()=>{await f.page.getByRole('heading',{name:'No workspace access',exact:true}).waitFor();assert.equal(await body.count(),0);assert.ok(!(await f.page.locator('main').textContent()).includes('latest unpersisted revision'));});
  await phase(f.t,'membership_restore',async()=>{await f.page.evaluate(()=>{IDBDatabase.prototype.transaction=window.fixtureTransaction;delete window.fixtureTransaction;});await f.setBootstrapMode('one');await f.page.getByRole('button',{name:'Recheck workspace access',exact:true}).click();});
  await phase(f.t,'membership_verify',async()=>{await body.waitFor();assert.equal(await body.inputValue(),'latest unpersisted revision');assert.deepEqual(f.errors,[]);});
});
test('native Back is canceled when protection fails, then Back/Forward restores the same protected draft',async t=>{
  const f=await setup(t);await createIssue(f);
  const body=f.page.getByRole('textbox',{name:'Markdown body',exact:true});
  await phase(f.t,'history_locator_ready',()=>f.page.waitForURL(url=>url.searchParams.get('view')==='issue'&&url.searchParams.has('draftId')&&url.searchParams.has('projectAtProtection'),{timeout:10000}));
  const detailURL=f.page.url();
  await phase(f.t,'history_fault',async()=>{
    await f.page.evaluate(()=>{window.fixtureTransaction=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(){throw new DOMException('Synthetic storage failure','QuotaExceededError');};});
    await body.fill('native history retained draft');await f.page.getByText('protection-failed',{exact:false}).waitFor();
  });
  await phase(f.t,'history_cancel',async()=>{
    await f.page.evaluate(()=>history.back());await f.page.getByText('Navigation stopped:',{exact:false}).waitFor();
    await f.page.waitForURL(detailURL,{timeout:10000});
  });
  await phase(f.t,'history_cancel_verify',async()=>{assert.equal(f.page.url(),detailURL);assert.equal(await body.inputValue(),'native history retained draft');});
  await phase(f.t,'history_back_ready',async()=>{
    await f.page.evaluate(()=>{IDBDatabase.prototype.transaction=window.fixtureTransaction;delete window.fixtureTransaction;history.back();});
    await f.page.getByRole('heading',{name:'Create issue',exact:true}).waitFor();
    // The heading is present while locked; this action appears only after the
    // committed create draft and current resource have been freshly verified.
    await f.page.getByRole('button',{name:'Open created issue',exact:true}).waitFor();
    assert.equal(await f.page.getByText('Navigation stopped:',{exact:false}).count(),0);
  });
  await phase(f.t,'history_forward_ready',async()=>{
    await f.page.evaluate(()=>history.forward());
    await f.page.waitForFunction(issueBodyReady,undefined,{timeout:10000});
    await body.waitFor();
  });
  await phase(f.t,'history_verify',async()=>{assert.equal(f.page.url(),detailURL);assert.equal(await body.inputValue(),'native history retained draft');assert.deepEqual(f.errors,[]);});
});

async function reportWikiFailure(f){
    const id=caseID(f.t.name);for(const status of f.wikiStatuses??[])trace(id,status,'fail');if(f.errors.length)trace(id,'wiki_page_error','fail');
    const state=await f.page.locator('[data-wiki-phase]').first().evaluate(el=>({phase:el.getAttribute('data-wiki-phase'),code:el.getAttribute('data-wiki-code')})).catch(()=>null);
    if(!state)trace(id,'wiki_no_editor','fail');else if(state.phase==='unconnected')trace(id,'wiki_no_controller','fail');else if(state.code){const group=typeof state.code==='string'&&state.code.includes('Illegal invocation')?'host_receiver':['DRAFT_BINDING_MISMATCH','WIKI_CREATE_BINDING_MISMATCH','BINDING_MISMATCH','KEY_SESSION_CHANGED'].includes(state.code)?'binding':['DRAFT_FORBIDDEN','FORBIDDEN','SCOPE_EXPANSION','DRAFT_ORIGINAL_SCOPE_MISMATCH'].includes(state.code)?'permission':['AUTH_REQUIRED','UNAUTHENTICATED','SESSION_EXPIRED'].includes(state.code)?'auth':['PROTECTION_FAILED','STORAGE_UNAVAILABLE','STORAGE_TIMEOUT','READBACK_MISMATCH','DRAFT_WRITE_CONFLICT'].includes(state.code)?'storage':'other';trace(id,'wiki_lock_'+group,'fail');}
}
async function wikiStep(f,name,run){try{return await phase(f.t,name,run);}catch(error){await reportWikiFailure(f);throw error;}}
async function startWikiDraft(f,{shared=false}={}){
  const statuses=new Set();f.wikiStatuses=statuses;const observe=response=>{const u=new URL(response.url());if(u.origin!==f.h.base||!u.pathname.startsWith('/v1/'))return;const status=response.status();const endpoint=u.pathname==='/v1/draft-keys'?'key':u.pathname.endsWith('/commands')?'command':['/v1/session','/v1/bootstrap'].includes(u.pathname)?'session':'read';if([400,401,403,404,409].includes(status))statuses.add('wiki_http_'+endpoint+'_'+status);else if(status>=500)statuses.add('wiki_http_'+endpoint+'_5xx');};f.page.on('response',observe);f.cleanupGates.push(()=>f.page.off('response',observe));
  try{
    await phase(f.t,'wiki_seed',async()=>{for(const scope of ['wiki:read','wiki:write','wiki:trash','wiki:restore','deleted:read']){
      await f.h.control('sql','INSERT OR IGNORE INTO principal_scope VALUES(?,?)',[f.h.ids.actorA,scope]);
      await f.h.control('sql','INSERT OR IGNORE INTO credential_scope SELECT id,? FROM credential WHERE principal_id=?',[scope,f.h.ids.actorA]);
    }await f.h.control('sql','INSERT OR IGNORE INTO shared_grant VALUES(?,1,1)',[f.h.ids.actorA]);for(const [kind,id]of [['project',f.h.ids.project],['workspace_shared',f.h.ids.workspace]])await f.h.control('sql','INSERT OR IGNORE INTO scope_manage_grant VALUES(?,?,?,1)',[f.h.ids.actorA,kind,id]);});
    await phase(f.t,'wiki_navigate',async()=>{await f.page.goto(f.h.base+'/');await f.page.getByRole('button',{name:'Wiki',exact:true}).click();});
    await phase(f.t,'wiki_select_scope',()=>f.page.getByRole('button',{name:shared?'Create shared Wiki page':'Create Wiki page in Primary UI fixture project',exact:true}).click());
    await phase(f.t,'wiki_editor_ready',()=>f.page.getByLabel('title',{exact:true}).waitFor());
    await phase(f.t,'wiki_fields',async()=>{await f.page.getByLabel('title',{exact:true}).fill(shared?'Shared Wiki acceptance':'Project Wiki acceptance');await f.page.getByLabel('slug',{exact:true}).fill(shared?'shared-wiki-acceptance':'project-wiki-acceptance');await f.page.getByLabel('contentMarkdown',{exact:true}).fill('Wiki exact 日本語\n<script>never execute</script>');});
    await phase(f.t,'wiki_draft_protect',()=>f.page.getByText('Unsaved changes · protected',{exact:false}).waitFor());
    return await phase(f.t,'wiki_draft_identity',()=>{const url=new URL(f.page.url());assert.equal(url.searchParams.get('pageId'),url.searchParams.get('draftId'));return url.searchParams.get('pageId');});
  }catch(error){
    await reportWikiFailure(f);
    throw error;
  }
}
for(const shared of [false,true])test(`Wiki ${shared?'shared':'project'} protected creation survives reload and opens a distinct existing-page binding`,async t=>{
 const f=await setup(t),id=await startWikiDraft(f,{shared});const before=f.page.url();f.page.on('dialog',d=>d.accept());await wikiStep(f,'wiki_reload',()=>f.page.reload());await wikiStep(f,'wiki_body_ready',()=>f.page.getByLabel('contentMarkdown',{exact:true}).waitFor());assert.equal(await f.page.getByLabel('contentMarkdown',{exact:true}).inputValue(),'Wiki exact 日本語\n<script>never execute</script>');
 await wikiStep(f,'wiki_save',()=>f.page.getByRole('button',{name:'Save Wiki change',exact:true}).click());await wikiStep(f,'wiki_commit_confirm',()=>f.page.getByText('Creation is confirmed.',{exact:false}).waitFor());assert.equal(await f.page.getByRole('button',{name:'Save Wiki change',exact:true}).isDisabled(),true);const created=(await wikiStep(f,'wiki_acl_change',()=>f.h.control('sql','SELECT count(*) n FROM wiki_page WHERE id=?',[id])))[0].n;assert.equal(created,1);
 await wikiStep(f,'wiki_open',()=>f.page.getByRole('button',{name:'Open created Wiki page',exact:true}).click());await wikiStep(f,'wiki_existing_ready',()=>f.page.getByRole('button',{name:'Load authorized history',exact:true}).waitFor());await wikiStep(f,'wiki_body_ready',()=>f.page.getByLabel('contentMarkdown',{exact:true}).waitFor());assert.equal(new URL(f.page.url()).searchParams.get('pageId'),id);assert.notEqual(new URL(f.page.url()).searchParams.get('draftId'),id);assert.notEqual(f.page.url(),before);
 await wikiStep(f,'wiki_fields',()=>f.page.getByLabel('contentMarkdown',{exact:true}).fill('existing-page edited body'));if(!shared){const session=await(await f.context.request.get(f.h.base+'/v1/session?workspaceId='+f.h.ids.workspace)).json(),operationId=crypto.randomUUID(),command={schemaVersion:1,workspaceId:f.h.ids.workspace,workspaceEpoch:session.workspaceEpoch,operationId,commandType:'Wiki.Edit',entityId:id,expectedVersion:1,payload:{title:'Concurrent Wiki title'}};const response=await wikiStep(f,'wiki_remote_edit',()=>f.context.request.post(f.h.base+'/v1/workspaces/'+f.h.ids.workspace+'/commands',{headers:{origin:f.h.base,'x-projektor-csrf':'same-origin','idempotency-key':operationId},data:command}));assert.equal(response.status(),200);}await wikiStep(f,'wiki_save',()=>f.page.getByRole('button',{name:'Save Wiki change',exact:true}).click());if(!shared){await wikiStep(f,'wiki_conflict_ready',()=>f.page.getByRole('button',{name:'Keep my draft and use current version',exact:true}).waitFor());assert.equal(await f.page.getByRole('button',{name:'Save Wiki change',exact:true}).isDisabled(),true);await wikiStep(f,'wiki_rebase',()=>f.page.getByRole('button',{name:'Keep my draft and use current version',exact:true}).click());await wikiStep(f,'wiki_save',()=>f.page.getByRole('button',{name:'Save Wiki change',exact:true}).click());}await wikiStep(f,'wiki_save_confirm',()=>f.page.getByText('Saved snapshot confirmed.',{exact:false}).waitFor());await wikiStep(f,'wiki_history',()=>f.page.getByRole('button',{name:'Load authorized history',exact:true}).click());await wikiStep(f,'wiki_history_ready',()=>f.page.locator('article pre').filter({hasText:'Wiki exact 日本語'}).first().waitFor());assert.equal(await f.page.locator('article pre').evaluateAll((nodes,text)=>nodes.filter(n=>n.textContent===text).length,'Wiki exact 日本語\n<script>never execute</script>'),shared?1:2);assert.deepEqual(f.errors,[]);
});
test('Wiki committed creation keeps late text through Back/reload and cannot issue a second Create',async t=>{
 const f=await setup(t),id=await startWikiDraft(f);const gate=createBarrier({label:'POST /v1/workspaces/:id/commands',onTimeout:reportBarrierTimeout});f.cleanupGates.push(()=>gate.release());await f.page.route('**/v1/workspaces/*/commands',async route=>{try{const response=await route.fetch({timeout:10000});gate.enter();await gate.holdResponse();await route.fulfill({response});}finally{gate.release();}});
 try{await wikiStep(f,'wiki_save',()=>f.page.getByRole('button',{name:'Save Wiki change',exact:true}).click());await wikiStep(f,'wiki_late_barrier',()=>gate.waitForRequest());await wikiStep(f,'wiki_fields',()=>f.page.getByLabel('contentMarkdown',{exact:true}).fill('late creation draft retained'));gate.release();await wikiStep(f,'wiki_commit_confirm',()=>f.page.getByText('Creation is confirmed.',{exact:false}).waitFor());await wikiStep(f,'wiki_open',()=>f.page.getByRole('button',{name:'Open created Wiki page',exact:true}).click());await wikiStep(f,'wiki_existing_ready',()=>f.page.getByRole('button',{name:'Load authorized history',exact:true}).waitFor());await wikiStep(f,'wiki_body_ready',()=>f.page.getByLabel('contentMarkdown',{exact:true}).waitFor());await wikiStep(f,'wiki_mode_select',()=>f.page.getByLabel('Wiki action',{exact:true}).selectOption('move'));await wikiStep(f,'wiki_raw_input',()=>f.page.getByLabel('targets',{exact:true}).fill('[ unfinished before blur'));await wikiStep(f,'wiki_back',()=>f.page.goBack());await wikiStep(f,'wiki_commit_confirm',()=>f.page.getByText('Creation is confirmed.',{exact:false}).waitFor());assert.equal(await f.page.getByLabel('contentMarkdown',{exact:true}).inputValue(),'late creation draft retained');await wikiStep(f,'wiki_forward',()=>f.page.goForward());await wikiStep(f,'wiki_existing_ready',()=>f.page.getByRole('button',{name:'Load authorized history',exact:true}).waitFor());assert.equal(await f.page.getByLabel('targets',{exact:true}).inputValue(),'[ unfinished before blur');assert.equal(await f.page.getByRole('button',{name:'Save Wiki change',exact:true}).isDisabled(),true);const retainedURL=f.page.url();await wikiStep(f,'wiki_raw_storage',()=>f.page.evaluate(()=>{window.wikiOriginalTransaction=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(){throw new DOMException('Synthetic quota failure','QuotaExceededError');};}));await wikiStep(f,'wiki_raw_input',()=>f.page.getByLabel('targets',{exact:true}).fill('[ exact unprotected raw'));await wikiStep(f,'wiki_protection_failed',()=>f.page.getByText('protection-failed',{exact:false}).waitFor());await wikiStep(f,'wiki_back',()=>f.page.goBack());await wikiStep(f,'wiki_back_cancel_confirm',()=>f.page.getByText('Navigation stopped:',{exact:false}).waitFor());assert.equal(f.page.url(),retainedURL);assert.equal(await f.page.getByLabel('targets',{exact:true}).inputValue(),'[ exact unprotected raw');let unloadSeen=false;f.page.once('dialog',async d=>{assert.equal(d.type(),'beforeunload');unloadSeen=true;await d.dismiss();});await wikiStep(f,'wiki_unload_cancel',()=>f.page.reload({timeout:5000}).catch(()=>{}));assert.equal(unloadSeen,true);assert.equal(await f.page.getByLabel('targets',{exact:true}).inputValue(),'[ exact unprotected raw');await wikiStep(f,'wiki_raw_storage',()=>f.page.evaluate(()=>{IDBDatabase.prototype.transaction=window.wikiOriginalTransaction;delete window.wikiOriginalTransaction;}));await wikiStep(f,'wiki_raw_input',()=>f.page.getByLabel('targets',{exact:true}).fill('[ unfinished before blur'));await wikiStep(f,'wiki_draft_protect',()=>f.page.getByText('Unsaved changes · protected',{exact:false}).waitFor());await wikiStep(f,'wiki_mode_select',()=>f.page.getByLabel('Wiki action',{exact:true}).selectOption('body'));await wikiStep(f,'wiki_mode_select',()=>f.page.getByLabel('Wiki action',{exact:true}).selectOption('move'));assert.equal(await f.page.getByLabel('targets',{exact:true}).inputValue(),'[ unfinished before blur');await wikiStep(f,'wiki_back',()=>f.page.goBack());await wikiStep(f,'wiki_commit_confirm',()=>f.page.getByText('Creation is confirmed.',{exact:false}).waitFor());f.page.on('dialog',d=>d.accept());await wikiStep(f,'wiki_reload',()=>f.page.reload());await wikiStep(f,'wiki_commit_confirm',()=>f.page.getByText('Creation is confirmed.',{exact:false}).waitFor());assert.equal(await f.page.getByLabel('contentMarkdown',{exact:true}).inputValue(),'late creation draft retained');assert.equal(await f.page.getByRole('button',{name:'Save Wiki change',exact:true}).isDisabled(),true);assert.equal((await wikiStep(f,'wiki_acl_change',()=>f.h.control('sql','SELECT count(*) n FROM wiki_page WHERE id=?',[id])))[0].n,1);assert.deepEqual(f.errors,[]);}finally{gate.release();}
});
test('Wiki old creation ciphertext is not revealed after resulting page ACL is revoked',async t=>{
 const f=await setup(t),id=await startWikiDraft(f,{shared:true});await wikiStep(f,'wiki_save',()=>f.page.getByRole('button',{name:'Save Wiki change',exact:true}).click());await wikiStep(f,'wiki_commit_confirm',()=>f.page.getByText('Creation is confirmed.',{exact:false}).waitFor());await wikiStep(f,'wiki_fields',()=>f.page.getByLabel('contentMarkdown',{exact:true}).fill('private late Wiki draft'));await wikiStep(f,'wiki_draft_protect',()=>f.page.getByText('Unsaved changes · protected',{exact:false}).waitFor());await wikiStep(f,'wiki_acl_change',()=>f.h.control('sql',"UPDATE resource_access SET mode='restricted',reader_principal_ids='[]',writer_principal_ids='[]' WHERE resource_type='wiki' AND resource_id=?",[id]));f.page.on('dialog',d=>d.accept());await wikiStep(f,'wiki_reload',()=>f.page.reload());await wikiStep(f,'wiki_locked_confirm',()=>f.page.getByText('Wiki editor locked',{exact:false}).waitFor());assert.equal(await f.page.getByLabel('contentMarkdown',{exact:true}).count(),0);assert.ok(!(await f.page.locator('main').textContent()).includes('private late Wiki draft'));assert.deepEqual(f.errors,[]);
});
test('Wiki trash reload restores only through authorized current and historic protection',async t=>{
 const f=await setup(t),id=await startWikiDraft(f);await wikiStep(f,'wiki_save',()=>f.page.getByRole('button',{name:'Save Wiki change',exact:true}).click());await wikiStep(f,'wiki_commit_confirm',()=>f.page.getByText('Creation is confirmed.',{exact:false}).waitFor());await wikiStep(f,'wiki_open',()=>f.page.getByRole('button',{name:'Open created Wiki page',exact:true}).click());await wikiStep(f,'wiki_existing_ready',()=>f.page.getByRole('button',{name:'Load authorized history',exact:true}).waitFor());await wikiStep(f,'wiki_trash_select',()=>f.page.getByLabel('Wiki action',{exact:true}).selectOption('trash'));await wikiStep(f,'wiki_fields',()=>f.page.getByLabel('reason',{exact:true}).fill('trash reload acceptance'));await wikiStep(f,'wiki_save',()=>f.page.getByRole('button',{name:'Save Wiki change',exact:true}).click());await wikiStep(f,'wiki_save_confirm',()=>f.page.getByText('Saved snapshot confirmed.',{exact:false}).waitFor());f.page.on('dialog',d=>d.accept());await wikiStep(f,'wiki_reload',()=>f.page.reload());await f.page.getByLabel('Wiki action',{exact:true}).waitFor();assert.equal(await f.page.getByLabel('Wiki action',{exact:true}).inputValue(),'restore');await wikiStep(f,'wiki_save',()=>f.page.getByRole('button',{name:'Save Wiki change',exact:true}).click());await wikiStep(f,'wiki_body_ready',()=>f.page.getByLabel('contentMarkdown',{exact:true}).waitFor());assert.equal((await wikiStep(f,'wiki_acl_change',()=>f.h.control('sql','SELECT deleted_at FROM wiki_page WHERE id=?',[id])))[0].deleted_at,null);assert.equal(await f.page.getByLabel('contentMarkdown',{exact:true}).inputValue(),'Wiki exact 日本語\n<script>never execute</script>');assert.deepEqual(f.errors,[]);
});
for(const shared of [false,true])test(`Wiki ${shared?'shared':'project'} access policy uses protected dual CAS and masks management after revoke`,async t=>{
 const f=await setup(t);
 await phase(t,'wiki_seed',async()=>{await f.h.control('sql','INSERT INTO principal_scope VALUES(?,?)',[f.h.ids.actorA,'resource:manage']);await f.h.control('sql','INSERT INTO credential_scope SELECT id,? FROM credential WHERE principal_id=?',['resource:manage',f.h.ids.actorA]);await f.h.control('sql','INSERT INTO scope_manage_grant VALUES(?,?,?,1)',[f.h.ids.actorA,shared?'workspace_shared':'project',shared?f.h.ids.workspace:f.h.ids.project]);});
 const id=await startWikiDraft(f,{shared});await wikiStep(f,'wiki_save',()=>f.page.getByRole('button',{name:'Save Wiki change',exact:true}).click());await wikiStep(f,'wiki_commit_confirm',()=>f.page.getByText('Creation is confirmed.',{exact:false}).waitFor());await wikiStep(f,'wiki_open',()=>f.page.getByRole('button',{name:'Open created Wiki page',exact:true}).click());await wikiStep(f,'wiki_existing_ready',()=>f.page.getByRole('button',{name:'Load authorized history',exact:true}).waitFor());
 await wikiStep(f,'wiki_mode_select',()=>f.page.getByLabel('Wiki action',{exact:true}).selectOption('access'));const policy={mode:'restricted',readerPrincipalIds:[f.h.ids.actorA],writerPrincipalIds:[f.h.ids.actorA]};await wikiStep(f,'wiki_raw_input',()=>f.page.getByLabel('policy',{exact:true}).fill('{ unfinished'));assert.equal(await f.page.getByRole('button',{name:'Save Wiki change',exact:true}).isDisabled(),true);await wikiStep(f,'wiki_raw_input',()=>f.page.getByLabel('policy',{exact:true}).fill(JSON.stringify(policy)));await wikiStep(f,'wiki_draft_protect',()=>f.page.getByText('Unsaved changes · protected',{exact:false}).waitFor());
 const session=await(await f.context.request.get(f.h.base+'/v1/session?workspaceId='+f.h.ids.workspace)).json(),operationId=crypto.randomUUID(),command={schemaVersion:1,workspaceId:f.h.ids.workspace,workspaceEpoch:session.workspaceEpoch,operationId,commandType:'SetResourceAccess',entityId:id,expectedVersion:1,payload:{resource:{type:'wiki',id},expectedPolicyVersion:1,policy}};
 const remote=await wikiStep(f,'wiki_remote_edit',()=>f.context.request.post(f.h.base+'/v1/workspaces/'+f.h.ids.workspace+'/commands',{headers:{origin:f.h.base,'x-projektor-csrf':'same-origin','idempotency-key':operationId},data:command}));assert.equal(remote.status(),200);await wikiStep(f,'wiki_save',()=>f.page.getByRole('button',{name:'Save Wiki change',exact:true}).click());await wikiStep(f,'wiki_conflict_ready',()=>f.page.getByRole('button',{name:'Keep my draft and use current version',exact:true}).waitFor());assert.deepEqual(JSON.parse(await f.page.getByLabel('policy',{exact:true}).inputValue()),policy);await wikiStep(f,'wiki_rebase',()=>f.page.getByRole('button',{name:'Keep my draft and use current version',exact:true}).click());await wikiStep(f,'wiki_save',()=>f.page.getByRole('button',{name:'Save Wiki change',exact:true}).click());await wikiStep(f,'wiki_save_confirm',()=>f.page.getByText('No change needed. Current data checked',{exact:true}).waitFor());
 const rows=await f.h.control('sql',"SELECT w.version,r.policy_version,(SELECT count(*) FROM content_revision WHERE resource_type='wiki' AND resource_id=w.id) revisions FROM wiki_page w JOIN resource_access r ON r.resource_type='wiki' AND r.resource_id=w.id WHERE w.id=?",[id]);assert.equal(rows[0].version,2);assert.equal(rows[0].policy_version,2);assert.equal(rows[0].revisions,1);
 await wikiStep(f,'wiki_acl_change',()=>f.h.control('sql','DELETE FROM scope_manage_grant WHERE principal_id=?',[f.h.ids.actorA]));f.page.on('dialog',d=>d.accept());await wikiStep(f,'wiki_reload',()=>f.page.reload());await wikiStep(f,'wiki_locked_confirm',()=>f.page.getByText('Wiki editor locked',{exact:false}).waitFor());assert.equal(await f.page.getByLabel('policy',{exact:true}).count(),0);assert.deepEqual(f.errors,[]);
});
for(const type of ['Wiki','Issue'])test(`${type} successful access change preserves late input and exposes policy-only rebase`,async t=>{
 const f=await setup(t);await phase(t,'wiki_seed',async()=>{await f.h.control('sql','INSERT INTO principal_scope VALUES(?,?)',[f.h.ids.actorA,'resource:manage']);await f.h.control('sql','INSERT INTO credential_scope SELECT id,? FROM credential WHERE principal_id=?',['resource:manage',f.h.ids.actorA]);await f.h.control('sql','INSERT INTO scope_manage_grant VALUES(?,?,?,1)',[f.h.ids.actorA,'project',f.h.ids.project]);});
 let id;if(type==='Wiki'){id=await startWikiDraft(f);await wikiStep(f,'wiki_save',()=>f.page.getByRole('button',{name:'Save Wiki change',exact:true}).click());await wikiStep(f,'wiki_commit_confirm',()=>f.page.getByText('Creation is confirmed.',{exact:false}).waitFor());await wikiStep(f,'wiki_open',()=>f.page.getByRole('button',{name:'Open created Wiki page',exact:true}).click());await wikiStep(f,'wiki_existing_ready',()=>f.page.getByRole('button',{name:'Load authorized history',exact:true}).waitFor());}else{await createIssue(f);id=new URL(f.page.url()).searchParams.get('issueId');}
 await phase(t,'wiki_mode_select',()=>f.page.getByLabel(type==='Wiki'?'Wiki action':'Editor',{exact:true}).selectOption('access'));const input=f.page.getByLabel(type==='Wiki'?'policy':'Access policy JSON',{exact:true}),save=f.page.getByRole('button',{name:type==='Wiki'?'Save Wiki change':'Save',exact:true}),first={mode:'restricted',readerPrincipalIds:[f.h.ids.actorA],writerPrincipalIds:[f.h.ids.actorA]},late={...first,readerPrincipalIds:[f.h.ids.actorA,f.h.ids.actorB]};await phase(t,'wiki_raw_input',()=>input.fill(JSON.stringify(first)));
 const gate=createBarrier({label:'POST /v1/workspaces/:id/commands',onTimeout:reportBarrierTimeout});f.cleanupGates.push(()=>gate.release());const handler=async route=>{try{const response=await route.fetch({timeout:10000});gate.enter();await gate.holdResponse();await route.fulfill({response});}finally{gate.release();}};await f.page.route('**/v1/workspaces/*/commands',handler);
 try{await phase(t,'wiki_save',()=>save.click());await phase(t,'wiki_late_barrier',()=>gate.waitForRequest());await phase(t,'wiki_raw_input',()=>input.fill(JSON.stringify(late)));gate.release();await phase(t,'wiki_conflict_ready',()=>f.page.getByRole('button',{name:'Keep my draft and use current version',exact:true}).waitFor());assert.deepEqual(JSON.parse(await input.inputValue()),late);await f.page.unroute('**/v1/workspaces/*/commands',handler);await phase(t,'wiki_rebase',()=>f.page.getByRole('button',{name:'Keep my draft and use current version',exact:true}).click());await phase(t,'wiki_save',()=>save.click());await phase(t,'wiki_save_confirm',()=>f.page.getByText('Saved snapshot confirmed.',{exact:false}).waitFor());const rows=await f.h.control('sql','SELECT policy_version,reader_principal_ids FROM resource_access WHERE resource_type=? AND resource_id=?',[type.toLowerCase(),id]);assert.equal(rows[0].policy_version,3);assert.deepEqual(JSON.parse(rows[0].reader_principal_ids),[...late.readerPrincipalIds].sort());assert.deepEqual(f.errors,[]);}finally{gate.release();}
});
