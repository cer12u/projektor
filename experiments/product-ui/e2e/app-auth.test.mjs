// Prepared real-browser acceptance for the new app-auth entry + Store fixture.
// NOT_RUN in the local environment: Chromium socket EPERM is an established
// blocker and must not be retried here. No synthetic Access credential is used.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
import {build} from 'vite';
const root=resolve(import.meta.dirname,'..');
const core=resolve(process.env.PROJEKTOR_CORE_SOURCE??resolve(root,'../atomic-command-poc'));
const {startAppAuthHarness}=await import(pathToFileURL(resolve(core,'browser-test/app-auth-server.mjs')));
let browser;
before(async()=>{await build({root,configFile:resolve(root,'vite.config.mjs')});browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true,args:['--no-sandbox']});});
after(async()=>{await browser?.close();});
const password='synthetic browser password 日本語';
async function setup(t,options={}){
 const h=await startAppAuthHarness(options),context=await browser.newContext();t.after(async()=>{await context.close();await h.close();});context.setDefaultTimeout(15000);
 const requests=[],dialogs=[],errors=[];
 await context.route(h.base+'/**',async route=>{const request=route.request(),url=new URL(request.url());if(url.pathname==='/'||url.pathname==='/setup'||url.pathname.startsWith('/assets/')){const file=url.pathname.startsWith('/assets/')?url.pathname.slice(1):'index.html';await route.fulfill({body:await readFile(resolve(root,'dist',file)),contentType:extname(file)==='.html'?'text/html':extname(file)==='.css'?'text/css':'text/javascript'});return;}requests.push(request.method()+' '+url.pathname);const response=await h.fetch(request.url(),{method:request.method(),headers:request.headers(),...(request.postDataBuffer()?{body:request.postDataBuffer()}:{})});const headers=Object.fromEntries(response.headers);const cookies=response.headers.getSetCookie();if(cookies.length)headers['set-cookie']=cookies.join('\n');await route.fulfill({status:response.status,headers,body:Buffer.from(await response.arrayBuffer())});});
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('dialog',async dialog=>{dialogs.push(dialog.type());await dialog.dismiss();});return {h,context,page,requests,dialogs,errors};
}
async function enroll(f,{loseReply=false}={}){
 await f.page.goto(f.h.base+'/setup');await f.page.getByRole('button',{name:'Create browser pairing',exact:true}).click();
 const grantId=await f.page.locator('[data-pairing-id]').textContent(),fingerprint=await f.page.locator('[data-pairing-fingerprint]').textContent();
 await f.h.approveGrant({grantId,fingerprint,purpose:'enroll'});await f.page.getByRole('button',{name:'Check owner approval',exact:true}).click();
 await f.page.getByRole('checkbox').check();await f.page.getByLabel('New password',{exact:true}).fill(password);await f.page.getByLabel('Confirm new password',{exact:true}).fill(password);
 if(loseReply)await f.page.route('**/v1/auth/grants/complete',async route=>{const request=route.request();f.requests.push(request.method()+' '+new URL(request.url()).pathname);await f.h.fetch(request.url(),{method:request.method(),headers:request.headers(),body:request.postDataBuffer()});await route.abort('failed');});
 await f.page.getByRole('button',{name:'Set password once',exact:true}).click();
 if(loseReply){await f.page.getByText('Setup result is unknown.',{exact:false}).waitFor();await f.page.getByRole('button',{name:'Check setup receipt',exact:true}).click();assert.equal(f.requests.filter(x=>x==='POST /v1/auth/grants/complete').length,1);assert.equal(f.requests.filter(x=>x==='POST /v1/auth/grants/receipt').length,1);}
 await f.page.getByRole('button',{name:'Continue to sign in',exact:true}).click();await login(f.page);
}
async function login(page){await page.getByLabel('Password',{exact:true}).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('heading',{name:'My Issues',exact:true}).waitFor();}
async function issue(f){await f.page.goto(f.h.base+'/?view=issue&workspaceId='+f.h.ids.workspace+'&issueId='+f.h.ids.issue);const body=f.page.getByLabel('Markdown body',{exact:true});await body.waitFor();return body;}
test('enroll → password login → Issue record → reload/new tab → refresh → sign out/login keeps protected draft',async t=>{
 const f=await setup(t,{accessLeaseMs:4000});await enroll(f);let body=await issue(f);await body.fill('Recorded through the app-owned session');await f.page.getByRole('button',{name:'Save',exact:true}).click();await f.page.getByText('Saved snapshot confirmed.',{exact:false}).waitFor();
 await body.fill('protected latest draft 日本語');await f.page.getByText('Unsaved changes · protected',{exact:false}).waitFor();const route=f.page.url(),posts=f.requests.filter(x=>x.endsWith('/commands')).length;
 await f.page.reload();await body.waitFor();assert.equal(await body.inputValue(),'protected latest draft 日本語');assert.deepEqual(f.dialogs,[]);
 const tab=await f.context.newPage();tab.on('pageerror',error=>f.errors.push(error.message));await tab.goto(route);await tab.getByLabel('Markdown body',{exact:true}).waitFor();assert.equal(await tab.getByLabel('Markdown body',{exact:true}).inputValue(),'protected latest draft 日本語');
 // A deliberate sign-out/login in the second tab establishes a new family.
 // The original editor must reauthorize and restore, without another password.
 await tab.getByRole('button',{name:'Sign out',exact:true}).click();await tab.getByLabel('Password',{exact:true}).fill(password);await tab.getByRole('button',{name:'Sign in',exact:true}).click();await tab.getByLabel('Markdown body',{exact:true}).waitFor();const passwordSubmissions=f.requests.filter(x=>x==='POST /v1/auth/login').length;
 await f.page.bringToFront();await body.waitFor();assert.equal(await body.inputValue(),'protected latest draft 日本語');assert.equal(await f.page.getByLabel('Password',{exact:true}).count(),0);assert.equal(f.requests.filter(x=>x==='POST /v1/auth/login').length,passwordSubmissions);
 await f.page.close();f.page=tab;await tab.bringToFront();body=tab.getByLabel('Markdown body',{exact:true});
 await tab.waitForResponse(response=>new URL(response.url()).pathname==='/v1/auth/refresh'&&response.status()===200);await body.waitFor();assert.equal(await body.inputValue(),'protected latest draft 日本語');assert.equal(tab.url(),route);assert.ok(f.requests.includes('POST /v1/auth/refresh'));assert.equal(f.requests.filter(x=>x.endsWith('/commands')).length,posts);
 await tab.getByRole('button',{name:'Sign out',exact:true}).click();await tab.getByLabel('Password',{exact:true}).waitFor();await tab.getByLabel('Password',{exact:true}).fill(password);await tab.getByRole('button',{name:'Sign in',exact:true}).click();await body.waitFor();assert.equal(await body.inputValue(),'protected latest draft 日本語');assert.equal(tab.url(),route);assert.equal(f.requests.filter(x=>x.endsWith('/commands')).length,posts);assert.deepEqual(f.errors,[]);
 const storage=await tab.evaluate(()=>({local:Object.values(localStorage),session:Object.values(sessionStorage),cookies:document.cookie}));assert.ok(!JSON.stringify(storage).includes(password));assert.ok(!JSON.stringify(storage).includes('protected latest draft'));assert.ok(!storage.cookies.includes('projektor_session'));
});
test('lost enrollment response stays receipt-only and expired authority requests login without draft loss',async t=>{
 const f=await setup(t);await enroll(f,{loseReply:true});const body=await issue(f);await body.fill('protected across absolute expiry');await f.page.getByText('Unsaved changes · protected',{exact:false}).waitFor();const posts=f.requests.filter(x=>x.endsWith('/commands')).length;
 await f.h.control('expireSessionAbsolute');await f.page.getByRole('button',{name:'Verify session and reload current data',exact:true}).click();await f.page.getByLabel('Password',{exact:true}).waitFor();assert.equal(await body.count(),0);assert.equal(f.requests.filter(x=>x.endsWith('/commands')).length,posts);
 await f.page.getByLabel('Password',{exact:true}).fill(password);await f.page.getByRole('button',{name:'Sign in',exact:true}).click();await body.waitFor();assert.equal(await body.inputValue(),'protected across absolute expiry');
 await f.h.control('revokeSession');await f.page.getByRole('button',{name:'Verify session and reload current data',exact:true}).click();await f.page.getByLabel('Password',{exact:true}).waitFor();assert.equal(await body.count(),0);assert.equal(f.requests.filter(x=>x.endsWith('/commands')).length,posts);
});
test('latest unprotected input blocks sign-out; repeated 401 does not loop refresh or resend',async t=>{
 const f=await setup(t);await enroll(f);const body=await issue(f);
 await f.page.evaluate(()=>{window.fixtureTransaction=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(){throw new DOMException('Synthetic storage failure','QuotaExceededError');};});await body.fill('must stay in memory');await f.page.getByText('protection-failed',{exact:false}).waitFor();await f.page.getByRole('button',{name:'Sign out',exact:true}).click();await f.page.getByText('Sign-out stopped:',{exact:false}).waitFor();assert.equal(await body.inputValue(),'must stay in memory');assert.ok(!f.requests.includes('POST /v1/auth/logout'));
 await f.page.evaluate(()=>{IDBDatabase.prototype.transaction=window.fixtureTransaction;delete window.fixtureTransaction;});await body.fill('protected before repeated denial');await f.page.getByText('Unsaved changes · protected',{exact:false}).waitFor();
 let denied=0;await f.page.route('**/v1/session?*',route=>{denied++;return route.fulfill({status:401,json:{error:{code:'AUTH_REQUIRED'}}});});const refreshes=f.requests.filter(x=>x==='POST /v1/auth/refresh').length,posts=f.requests.filter(x=>x.endsWith('/commands')).length;await f.page.getByRole('button',{name:'Verify session and reload current data',exact:true}).click();await f.page.getByLabel('Password',{exact:true}).waitFor();await f.page.waitForTimeout(1000);assert.ok(denied<=3);assert.equal(f.requests.filter(x=>x==='POST /v1/auth/refresh').length,refreshes+1);assert.equal(f.requests.filter(x=>x.endsWith('/commands')).length,posts);
});
