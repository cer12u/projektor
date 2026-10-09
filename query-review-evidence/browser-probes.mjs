// Independent actual-Chromium probes. Real signed-cookie/HTTP/workerd fixture.
// Local Chromium is known blocked; execute on approved exact-head CI, never mock.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {startHarness} from '../experiments/atomic-command-poc/browser-test/server.mjs';
const {chromium}=createRequire(new URL('../experiments/atomic-command-poc/package.json',import.meta.url))('playwright');
let browser;
before(async()=>{browser=await chromium.launch({...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),headless:true,args:['--no-sandbox']});});
after(async()=>{await browser?.close();});
const wait=async(page,phase)=>page.waitForFunction(p=>window.myIssues?.snapshot().phase===p&&!window.myIssues.snapshot().busy,phase,{timeout:15000});
const snap=page=>page.evaluate(()=>myIssues.snapshot());
async function setup(t,{rows=2,title='review item'}={}) {
 const h=await startHarness(),context=await browser.newContext();
 t.after(async()=>{await context.close();await h.close();});
 const issues=[];
 for(let n=0;n<rows;n++){const issue=randomUUID();issues.push(issue);await h.control('sql','INSERT INTO issue VALUES(?,?,?,1,0)',[issue,h.ids.project,`${title} ${n}`]);await h.control('sql','INSERT INTO issue_queue VALUES(?,?,?,?,?,0)',[issue,h.ids.actorA,'ready',n,100+n]);}
 await h.login(context,'A');const page=await context.newPage();
 await page.goto(h.base+'/browser/my-issues.html');
 await wait(page,rows?'ready':'empty');
 return {h,context,page,issues};
}
async function partial(f){assert.equal((await f.page.evaluate(()=>myIssues.setFilters({limit:1}))).kind,'partial');await wait(f.page,'partial');}
const queuePattern='**/my-issues?*';

test('real authenticated empty queue renders explicit zero without error',async t=>{const f=await setup(t,{rows:0});const response=await f.page.evaluate(async()=>{const s=await fetch('/v1/session').then(r=>r.json());const r=await fetch(`/v1/workspaces/${s.workspaceId}/my-issues?workspaceEpoch=${s.workspaceEpoch}`);return {status:r.status,body:await r.json()};});assert.equal(response.status,200);assert.equal(response.body.data.total,0);assert.equal((await snap(f.page)).complete,true);assert.match(await f.page.locator('[data-status]').innerText(),/No issues/);assert.equal(await f.page.locator('[data-issues] li').count(),0);});

test('actual page-two HTTP failure stays partial and Retry completes the same queue',async t=>{const f=await setup(t);await partial(f);await f.page.route(queuePattern,route=>route.request().url().includes('cursor=')?route.fulfill({status:503,body:'unavailable'}):route.continue());await f.page.getByRole('button',{name:'Load more',exact:true}).click();await f.page.waitForFunction(()=>myIssues.snapshot().code==='SERVER_UNAVAILABLE');const s=await snap(f.page);assert.equal(s.phase,'partial');assert.equal(s.complete,false);assert.equal(s.items.length,1);assert.match(await f.page.locator('[data-status]').innerText(),/next page failed/);await f.page.unroute(queuePattern);await f.page.getByRole('button',{name:'Retry',exact:true}).click();await wait(f.page,'ready');assert.equal((await snap(f.page)).items.length,2);});

test('current resource revocation clears already displayed rows before append',async t=>{const f=await setup(t);await partial(f);await f.h.control('sql','UPDATE issue_queue SET restricted_read=1 WHERE issue_id=?',[f.issues[0]]);await f.page.getByRole('button',{name:'Load more',exact:true}).click();await wait(f.page,'locked');assert.equal(await f.page.locator('[data-issues] li').count(),0);assert.equal((await snap(f.page)).total,null);await f.page.getByRole('button',{name:'Retry',exact:true}).click();await wait(f.page,'ready');assert.equal((await snap(f.page)).items.length,1);assert.equal((await snap(f.page)).items[0].id,f.issues[1]);});

for(const [label,mutate] of [
 ['impossible total',b=>{b.data.total=0;}],
 ['missing continuation',b=>{b.data.nextCursor=null;b.data.items=[];}],
 ['duplicate earlier issue',()=>{}],
 ['out-of-order priority',b=>{b.data.items[0].priority=0;b.data.items[0].created_at=0;}],
 ['malformed fingerprint',b=>{b.meta.queryFingerprint='invalid';}]
])test(`actual browser rejects ${label} without silent complete`,async t=>{const f=await setup(t);await partial(f);const firstId=(await snap(f.page)).items[0].id;await f.page.route(queuePattern,async route=>{if(!route.request().url().includes('cursor='))return route.continue();const response=await route.fetch();const body=await response.json();if(label==='duplicate earlier issue')body.data.items[0].id=firstId;else mutate(body);return route.fulfill({response,json:body});});await f.page.getByRole('button',{name:'Load more',exact:true}).click();await f.page.waitForFunction(()=>['error','stale','locked'].includes(myIssues.snapshot().phase));assert.equal((await snap(f.page)).complete,false);assert.equal(await f.page.locator('[data-issues] li').count(),0);});

test('actual HTML 200 response cannot turn into empty queue',async t=>{const f=await setup(t);await f.page.route(queuePattern,route=>route.fulfill({status:200,contentType:'text/html',body:'<html>Sign in</html>'}));await f.page.getByRole('button',{name:'Refresh',exact:true}).click();await wait(f.page,'error');assert.equal((await snap(f.page)).code,'PROTOCOL_ERROR');assert.equal((await snap(f.page)).complete,false);assert.equal(await f.page.locator('[data-issues] li').count(),0);});

test('filter change discards delayed successful old query',async t=>{const f=await setup(t);let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);let first=true;await f.page.route(queuePattern,async route=>{if(!first)return route.continue();first=false;const response=await route.fetch();entered();await gate;try{await route.fulfill({response});}catch{}});await f.page.evaluate(()=>{window.reviewOld=myIssues.refresh();});await ready;await f.page.selectOption('[data-status-filter]','all');await wait(f.page,'ready');release();assert.equal((await f.page.evaluate(()=>window.reviewOld)).kind,'discarded');assert.equal((await snap(f.page)).filters.status,'all');assert.equal((await snap(f.page)).items.length,2);});

test('observed new principal fences delayed old-principal response',async t=>{const f=await setup(t);let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);let first=true;await f.page.route(queuePattern,async route=>{if(!first)return route.continue();first=false;const response=await route.fetch();entered();await gate;try{await route.fulfill({response});}catch{}});await f.page.evaluate(()=>{window.reviewOld=myIssues.refresh();});await ready;await f.h.login(f.context,'B');await f.page.evaluate(()=>myIssues.sessionChanged());await wait(f.page,'empty');release();assert.equal((await f.page.evaluate(()=>window.reviewOld)).kind,'discarded');assert.equal((await snap(f.page)).items.length,0);assert.equal(await f.page.locator('[data-issues] li').count(),0);});

test('literal issue markup is rendered as text with no executable element',async t=>{const f=await setup(t,{rows:1,title:'<img src=x onerror="window.reviewXSS=true">'});assert.equal(await f.page.locator('[data-issues] img').count(),0);assert.match(await f.page.locator('[data-issues]').innerText(),/<img/);assert.equal(await f.page.evaluate(()=>window.reviewXSS),undefined);});

test('synthetic pagehide locks DOM and pageshow reauthorizes before display',async t=>{const f=await setup(t);await f.page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')));assert.equal((await snap(f.page)).locked,true);assert.equal(await f.page.locator('[data-issues] li').count(),0);await f.h.control('revokeMembership');await f.page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow')));await wait(f.page,'locked');assert.equal(await f.page.locator('[data-issues] li').count(),0);assert.equal((await snap(f.page)).complete,false);});
