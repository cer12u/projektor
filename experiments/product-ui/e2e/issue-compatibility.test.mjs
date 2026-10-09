// Synthetic-only browser boundary: actual product ports, protected controller,
// authenticated local service, SQLite importer, and durable-store readback.
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
import {enterFixtureRoot} from './fixture-root.mjs';
import {phase,resourcePhase} from './trace.mjs';
function test(name,options,run){return nodeTest(name,options,t=>phase(t,'scenario_body',()=>run(t),70000));}
const root=resolve(import.meta.dirname,'..');
const core=resolve(process.env.PROJEKTOR_CORE_SOURCE??resolve(root,'../atomic-command-poc'));
const {startHarness}=await import(pathToFileURL(resolve(core,'browser-test/session-server.mjs')));
const {migrate}=await import(pathToFileURL(resolve(core,'src/core.mjs')));
const {importIssueCompatibility}=await import(pathToFileURL(resolve(core,'src/issue-compat.mjs')));
const uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const statuses=[
 {id:'a'.repeat(32),key:'review',name:'Synthetic review',toStatus:'in_progress',isReviewStep:true,position:0},
 {id:uuid(90),key:'active',name:'Synthetic active',toStatus:'in_progress',isReviewStep:false,position:1},
 {id:'b'.repeat(32),key:'ready',name:'Synthetic ready',toStatus:'ready',isReviewStep:false,position:2},
 {id:'c'.repeat(32),key:'blocked',name:'Synthetic blocked',toStatus:'blocked',isReviewStep:false,position:3},
 {id:'d'.repeat(32),key:'done',name:'Synthetic done',toStatus:'done',isReviewStep:false,position:4},
];
let browser,fixtureDir,restoreRoot=()=>{};
before(async()=>{
 // Node runs test files concurrently. Do not clear the other suite's assets.
 fixtureDir=await mkdtemp(join(tmpdir(),'projektor-compat-ui-'));
 await phase(null,'fixture_build',()=>build({root,configFile:resolve(root,'fixture.config.mjs'),build:{outDir:fixtureDir}}),30000);restoreRoot=enterFixtureRoot(core);
 browser=await resourcePhase(null,'browser_launch',()=>chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true,args:['--no-sandbox']}),'browser_close',value=>value.close(),20000);
});
after(async()=>{try{if(browser)await phase(null,'browser_close',()=>browser.close(),10000);}finally{restoreRoot();if(fixtureDir)await rm(fixtureDir,{recursive:true,force:true});}});
async function setup(t){
 let h,context;const errors=[],commands=[];
 t.after(async()=>{try{if(context)await phase(t,'context_close',()=>context.close(),10000);}finally{if(h)await phase(t,'fixture_close',()=>h.close(),10000);}});
 h=await resourcePhase(t,'fixture_start',()=>startHarness(),'fixture_close',value=>value.close(),20000);
 context=await resourcePhase(t,'context_open',()=>browser.newContext(),'context_close',value=>value.close(),10000);
 context.setDefaultTimeout(10000);context.setDefaultNavigationTimeout(20000);await phase(t,'fixture_login',()=>h.login(context,'A'),10000);
 const issueId=randomUUID();
 const command=async(commandType,payload,expectedVersion)=>{
  const body={schemaVersion:1,workspaceId:h.ids.workspace,workspaceEpoch:h.ids.epoch,operationId:randomUUID(),commandType,entityId:issueId,expectedVersion,payload};
  const response=await context.request.post(h.base+'/v1/workspaces/'+h.ids.workspace+'/commands',{data:body,headers:{Origin:h.base,'Idempotency-Key':body.operationId,'X-Projektor-CSRF':'same-origin','X-Requested-With':'XMLHttpRequest'}});
  assert.equal(response.ok(),true,`Synthetic fixture command ${commandType} failed`);const result=await response.json();assert.equal(result.data?.outcome,'committed');return result;
 };
 await phase(t,'fixture_seed',async()=>{
 await command('Issue.Create',{projectId:h.ids.project,title:'Synthetic imported issue',description:'Synthetic imported body\r\n二行目',assigneeId:h.ids.actorA,priority:null,parentId:null,initialStatus:'ready'},0);
 await command('Issue.Transition',{payloadVersion:2,entryId:randomUUID(),toStatus:'in_progress'},1);
 const [content]=await h.control('sql','SELECT * FROM issue_content WHERE issue_id=?',[issueId]);
 // Mirror only synthetic records using the real schema/importer. Copy its output
 // into host-controlled ephemeral storage; never add an HTTP import/SQL route.
 const db=new DatabaseSync(':memory:');
 try{
  migrate(db);
  for(const table of ['workspace','membership','project','issue','access_snapshot','source_mapping','content_revision','issue_content','issue_queue']){
   for(const row of await h.control('sql',`SELECT * FROM ${table}`))db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
  }
  importIssueCompatibility(db,{statuses,issues:[{issueId,statusId:statuses[0].id,typeId:'e'.repeat(32),typeName:'Synthetic task type',completionReportAt:1800000000000,dorReady:false,dorMissingRaw:'["Acceptance criteria"]',dorRevisionId:content.body_revision_id}]});
  for(const table of ['issue_compat_status','issue_compat_state'])for(const row of db.prepare(`SELECT * FROM ${table}`).all())await h.control('sql',`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(()=>'?').join(',')})`,Object.values(row));
 }finally{db.close();}
 },15000);
 await context.route(h.base+'/**',async route=>{
  const url=new URL(route.request().url());
  if(url.pathname==='/'||url.pathname.startsWith('/assets/')){
   const file=url.pathname==='/'?'fixture.html':url.pathname.slice(1);
   await route.fulfill({body:await readFile(resolve(fixtureDir,file)),contentType:extname(file)==='.html'?'text/html':extname(file)==='.css'?'text/css':'text/javascript'});return;
  }
  if(url.pathname.endsWith('/commands')&&route.request().method()==='POST')commands.push(route.request().postDataJSON());
  await route.continue();
 });
 const page=await resourcePhase(t,'page_open',()=>context.newPage(),'context_close',value=>value.close(),10000);page.on('pageerror',e=>errors.push(e.message));
 const read=async()=>{const r=await context.request.get(`${h.base}/v1/workspaces/${h.ids.workspace}/issues/${issueId}?workspaceEpoch=${h.ids.epoch}`);assert.equal(r.ok(),true);return (await r.json()).data;};
 await phase(t,'create_navigate',()=>page.goto(`${h.base}/?view=issue&workspaceId=${h.ids.workspace}&issueId=${issueId}`),25000);await phase(t,'create_open',()=>page.getByRole('textbox',{name:'Markdown body',exact:true}).waitFor(),15000);
 return {h,context,page,issueId,read,command,commands,errors};
}
async function save(page){await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Saved snapshot confirmed.',{exact:false}).waitFor();}

test('imported review/type/DoR survives native body edits and explicit same-category transitions',{timeout:70000},async t=>{
 const f=await setup(t),{page}=f;
 const before=await f.read();assert.equal(before.compatibility.dor.evidenceState,'current');
 const state=page.getByRole('region',{name:'Imported issue state'});
 await state.getByText('Status: Synthetic review · Review step · Type: Synthetic task type',{exact:true}).waitFor();
 await state.getByText('Recorded DoR readiness: Not ready',{exact:true}).waitFor();
 await state.getByText('Acceptance criteria',{exact:true}).waitFor();
 await state.getByText('Completion report time: 1800000000000',{exact:true}).waitFor();
 await phase(t,'compat_body_edit',async()=>{await page.getByRole('textbox',{name:'Markdown body',exact:true}).fill('Native edit keeps imported metadata\n日本語');await save(page);});
 await state.getByText('DoR evidence is stale after a body edit. Readiness has not been re-evaluated.',{exact:true}).waitFor();
 const edited=await f.read();assert.equal(edited.description,'Native edit keeps imported metadata\r\n日本語');
 assert.deepEqual({...edited.compatibility,dor:{...edited.compatibility.dor,evidenceState:'current'}},before.compatibility);
 await page.getByLabel('Editor',{exact:true}).selectOption('transition');
 await phase(t,'compat_review_exit',async()=>{await page.getByLabel('New status',{exact:true}).selectOption(statuses[1].id);await save(page);});
 const active=await f.read();assert.equal(active.status,'in_progress');assert.equal(active.compatibility.statusId,statuses[1].id);assert.equal(active.version,edited.version+1);
 assert.equal(f.commands.at(-1).payload.statusId,statuses[1].id);assert.equal(f.commands.at(-1).payload.toStatus,'in_progress');
 await state.getByText('Status: Synthetic active · Type: Synthetic task type',{exact:true}).waitFor();
 await phase(t,'compat_review_enter',async()=>{await page.getByLabel('New status',{exact:true}).selectOption(statuses[0].id);await save(page);});
 const review=await f.read();assert.equal(review.version,active.version+1);assert.equal(review.compatibility.statusId,statuses[0].id);
 await page.getByRole('button',{name:'Board',exact:true}).click();
 const row=page.getByRole('button',{name:'Synthetic imported issue',exact:true}).locator('..');await row.getByText(/Synthetic review · Review step · Type: Synthetic task type/).waitFor();
 await page.getByRole('button',{name:'Synthetic imported issue',exact:true}).click();
 await page.getByLabel('Editor',{exact:true}).selectOption('transition');await page.getByLabel('New status',{exact:true}).selectOption(statuses[2].id);
 await page.getByRole('textbox',{name:'Reason',exact:true}).fill('Synthetic next queue');await save(page);
 const ready=await f.read();assert.equal(ready.status,'ready');assert.equal(ready.compatibility.dor.ready,false);assert.equal(ready.compatibility.dor.evidenceState,'stale_after_edit');
 await page.getByText('Workflow status and recorded DoR are separate. A Ready queue label does not certify DoR readiness.',{exact:true}).waitFor();
 assert.deepEqual(f.errors,[]);
});

test('compatibility transition service rejection and CAS retain the protected explicit choice and text',{timeout:70000},async t=>{
 const f=await setup(t),{page}=f;const original=await f.read();
 await page.getByLabel('Editor',{exact:true}).selectOption('transition');await page.getByLabel('New status',{exact:true}).selectOption(statuses[4].id);
 const reason=page.getByRole('textbox',{name:'Reason',exact:true});await reason.fill('Keep this protected explanation');
 await phase(t,'compat_rejected',async()=>{await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Save rejected · RESULT_REQUIRED · Your draft is retained',{exact:false}).waitFor();});
 assert.equal(await reason.inputValue(),'Keep this protected explanation');assert.equal(await page.getByLabel('New status',{exact:true}).inputValue(),statuses[4].id);
 assert.equal((await f.read()).version,original.version);
 await page.getByLabel('New status',{exact:true}).selectOption(statuses[1].id);
 await f.command('Issue.UpdateTitle',{title:'Synthetic concurrent title'},original.version);
 await phase(t,'compat_conflict',async()=>{await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Version conflict. Your draft is retained; compare before using the current version',{exact:false}).waitFor();});
 assert.equal(await reason.inputValue(),'Keep this protected explanation');assert.equal(await page.getByLabel('New status',{exact:true}).inputValue(),statuses[1].id);
 assert.equal((await f.read()).compatibility.statusId,statuses[0].id);
 await phase(t,'compat_rebase',async()=>{await page.getByRole('button',{name:'Keep my draft and use current version',exact:true}).click();await save(page);});
 const final=await f.read();assert.equal(final.title,'Synthetic concurrent title');assert.equal(final.compatibility.statusId,statuses[1].id);assert.equal(final.version,original.version+2);
 assert.equal(f.commands.at(-1).expectedVersion,original.version+1);assert.equal(f.commands.at(-1).payload.reason.text,'Keep this protected explanation');
 assert.deepEqual(f.errors,[]);
});
