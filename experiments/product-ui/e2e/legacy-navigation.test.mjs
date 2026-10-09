// Pending approved Chromium execution. Synthetic provider and actual service;
// HTML fallback below is a fixture, not evidence about deployed host routing.
import {test as nodeTest,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,extname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {chromium} from 'playwright';
import {build} from 'vite';
import {createBarrier} from './barrier.mjs';
import {phase,resourcePhase} from './trace.mjs';
function test(name,options,run){return nodeTest(name,options,t=>phase(t,'scenario_body',()=>run(t),65000));}
import {enterFixtureRoot} from './fixture-root.mjs';
const root=resolve(import.meta.dirname,'..'),core=resolve(process.env.PROJEKTOR_CORE_SOURCE??resolve(root,'../atomic-command-poc'));
const {startHarness}=await import(pathToFileURL(resolve(core,'browser-test/session-server.mjs')));
const {migrate}=await import(pathToFileURL(resolve(core,'src/core.mjs')));
const {importProjectUrls}=await import(pathToFileURL(resolve(core,'src/legacy-url.mjs')));
let browser,fixtureDir,restoreRoot=()=>{};
before(async()=>{fixtureDir=await mkdtemp(join(tmpdir(),'projektor-legacy-ui-'));await phase(null,'fixture_build',()=>build({root,configFile:resolve(root,'fixture.config.mjs'),build:{outDir:fixtureDir}}),30000);restoreRoot=enterFixtureRoot(core);browser=await resourcePhase(null,'browser_launch',()=>chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true,args:['--no-sandbox']}),'browser_close',value=>value.close(),20000);});
after(async()=>{try{if(browser)await phase(null,'browser_close',()=>browser.close(),10000);}finally{restoreRoot();if(fixtureDir)await rm(fixtureDir,{recursive:true,force:true});}});
async function setup(t,{bootstrapMode='one'}={}){
  let h,context;const errors=[],reads=[],cleanup=[];
  t.after(async()=>{for(const release of cleanup)release();try{if(context)await phase(t,'context_close',()=>context.close(),10000);}finally{if(h)await phase(t,'fixture_close',()=>h.close(),10000);}});
  h=await resourcePhase(t,'fixture_start',()=>startHarness({bootstrapMode}),'fixture_close',value=>value.close(),20000);context=await resourcePhase(t,'context_open',()=>browser.newContext(),'context_close',value=>value.close(),10000);context.setDefaultTimeout(10000);context.setDefaultNavigationTimeout(20000);await phase(t,'fixture_login',()=>h.login(context,'A'),10000);
  for(const scope of ['wiki:read','wiki:write']){
    await h.control('sql','INSERT OR IGNORE INTO principal_scope VALUES(?,?)',[h.ids.actorA,scope]);
    await h.control('sql','INSERT OR IGNORE INTO credential_scope SELECT id,? FROM credential WHERE principal_id=?',[scope,h.ids.actorA]);
  }
  const issueId=randomUUID(),pageId=randomUUID();
  async function command(entityId,commandType,payload){const c={schemaVersion:1,workspaceId:h.ids.workspace,workspaceEpoch:h.ids.epoch,operationId:randomUUID(),entityId,commandType,payload,expectedVersion:0};const r=await context.request.post(`${h.base}/v1/workspaces/${h.ids.workspace}/commands`,{data:c,headers:{Origin:h.base,'Idempotency-Key':c.operationId,'X-Projektor-CSRF':'same-origin'}});assert.equal(r.ok(),true);assert.equal((await r.json()).data?.outcome,'committed');}
  await command(issueId,'Issue.Create',{projectId:h.ids.project,title:'Legacy synthetic issue',description:'[raw source](/wiki/'+encodeURIComponent('日本語')+')',assigneeId:h.ids.actorA,priority:null,parentId:null,initialStatus:'ready'});
  await command(pageId,'Wiki.Create',{pageId,scope:{kind:'project',projectId:h.ids.project},parentId:null,title:'Legacy synthetic Wiki',slug:'日本語',contentMarkdown:'[raw source](/projects/CURRENT/issues/1/original)'});
  const db=new DatabaseSync(':memory:');try{migrate(db);for(const row of await h.control('sql','SELECT * FROM project'))db.prepare('INSERT INTO project VALUES(?,?,?,?)').run(row.id,row.title,row.version,row.deleted);importProjectUrls(db,{projects:[{projectId:h.ids.project,key:'CURRENT',slug:'synthetic-project'}]});for(const row of db.prepare('SELECT * FROM project_url').all())await h.control('sql','INSERT INTO project_url VALUES(?,?,?,?)',Object.values(row));}finally{db.close();}
  const [number]=await h.control('sql','SELECT number FROM issue_number WHERE issue_id=?',[issueId]);
  await context.route(h.base+'/**',async r=>{const u=new URL(r.request().url());
    if(u.pathname==='/'||u.pathname.startsWith('/projects/')||u.pathname.startsWith('/wiki/')||u.pathname.startsWith('/assets/')){const file=u.pathname.startsWith('/assets/')?u.pathname.slice(1):'fixture.html';await r.fulfill({body:await readFile(resolve(fixtureDir,file)),contentType:extname(file)==='.html'?'text/html':extname(file)==='.css'?'text/css':'text/javascript'});return;}
    reads.push(u.pathname);await r.continue();
  });
  const page=await resourcePhase(t,'page_open',()=>context.newPage(),'context_close',value=>value.close(),10000);page.on('pageerror',e=>errors.push(e.message));
  return {h,context,page,errors,reads,cleanup,issueId,pageId,issuePath:`/projects/CURRENT/issues/${number.number}/stale-title`,wikiPath:'/wiki/'+encodeURIComponent('日本語')};
}

test('direct legacy issue waits for workspace choice, opens native protected detail and restores draft on Back',{timeout:70000},async t=>{
  const f=await setup(t,{bootstrapMode:'multi'});await f.page.goto(f.h.base+f.issuePath);
  await f.page.getByRole('heading',{name:'Choose a workspace',exact:true}).waitFor();assert.equal(f.reads.some(p=>p.startsWith('/v1/workspaces/')),false);assert.equal(new URL(f.page.url()).pathname,f.issuePath);
  await f.page.getByRole('button',{name:f.h.ids.workspace,exact:true}).click();const body=f.page.getByRole('textbox',{name:'Markdown body',exact:true});await body.waitFor();
  assert.equal(new URL(f.page.url()).searchParams.get('issueId'),f.issueId);assert.ok(f.reads.indexOf('/v1/session')<f.reads.indexOf(`/v1/workspaces/${f.h.ids.workspace}/legacy-url`));
  await body.fill('Protected legacy destination draft');await f.page.getByText('Unsaved changes · protected',{exact:false}).waitFor();const draftId=new URL(f.page.url()).searchParams.get('draftId');
  await f.page.getByRole('button',{name:'Board',exact:true}).click();await f.page.getByRole('heading',{name:'My issues board',exact:true}).waitFor();await f.page.goBack();await body.waitFor();assert.equal(await body.inputValue(),'Protected legacy destination draft');assert.equal(new URL(f.page.url()).searchParams.get('draftId'),draftId);assert.deepEqual(f.errors,[]);
});

test('Wiki and project pretty links open native identities and project-scoped Wiki',{timeout:70000},async t=>{
  const f=await setup(t);await f.page.goto(f.h.base+f.wikiPath);await f.page.getByRole('heading',{name:'Legacy synthetic Wiki',exact:true}).waitFor();assert.equal(new URL(f.page.url()).searchParams.get('pageId'),f.pageId);
  await f.page.goto(f.h.base+'/projects/view/synthetic-project');await f.page.getByRole('region',{name:'Project',exact:true}).waitFor();await f.page.getByText('Project key: CURRENT',{exact:true}).waitFor();await f.page.getByText('Project slug: synthetic-project',{exact:true}).waitFor();assert.equal(new URL(f.page.url()).searchParams.get('projectId'),f.h.ids.project);
  await f.page.getByRole('button',{name:'Open project Wiki',exact:true}).click();await f.page.getByRole('heading',{name:'Project Wiki',exact:true}).waitFor();await f.page.getByRole('button',{name:'Legacy synthetic Wiki',exact:true}).waitFor();assert.equal(new URL(f.page.url()).searchParams.get('projectId'),f.h.ids.project);assert.deepEqual(f.errors,[]);
});

test('unavailable and hidden legacy targets retain their URLs with the same notice',{timeout:70000},async t=>{
  const f=await setup(t);await f.h.control('revokeCurrentProject');
  for(const path of [f.issuePath,f.wikiPath,'/wiki/missing','/projects/view/synthetic-project']){await f.page.goto(f.h.base+path);await f.page.getByRole('heading',{name:'Link unavailable',exact:true}).waitFor();assert.equal(new URL(f.page.url()).pathname,path);await f.page.getByText('This link is unavailable in the selected workspace.',{exact:true}).waitFor();assert.equal(await f.page.getByRole('textbox').count(),0);assert.equal(await f.page.getByText('Legacy synthetic issue',{exact:true}).count(),0);}
  assert.deepEqual(f.errors,[]);
});

test('late resolver response cannot overwrite newer native navigation or reveal a previous principal target',{timeout:70000},async t=>{
  for(const change of ['navigation','principal']){
    const f=await setup(t),gate=createBarrier({label:'legacy resolver',timeoutMs:15000});f.cleanup.push(()=>gate.release());let held=false;
    await f.page.route('**/v1/workspaces/*/legacy-url?*',async r=>{if(held){await r.continue();return;}held=true;try{const response=await r.fetch();gate.enter();await gate.holdResponse();await r.fulfill({response});}catch{await r.abort().catch(()=>{});}});
    await f.page.goto(f.h.base+f.issuePath);await gate.waitForRequest();
    if(change==='navigation'){await f.page.getByRole('button',{name:'My Issues',exact:true}).click();await f.page.getByRole('heading',{name:'My Issues',exact:true}).waitFor();gate.release();await f.page.waitForLoadState('networkidle');assert.equal(new URL(f.page.url()).searchParams.get('view'),'list');}
    else{await f.h.control('revokeCurrentProject','B');await f.h.login(f.context,'B');await f.page.evaluate(()=>{const c=new BroadcastChannel('projektor-session');c.postMessage('changed');c.close();});await f.page.locator('header').getByText(f.h.ids.actorB+' · Human',{exact:true}).waitFor();gate.release();await f.page.getByRole('heading',{name:'Link unavailable',exact:true}).waitFor();assert.equal(new URL(f.page.url()).pathname,f.issuePath);assert.equal(await f.page.getByRole('textbox').count(),0);}
    assert.deepEqual(f.errors,[]);
  }
});
