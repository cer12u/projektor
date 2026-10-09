// One focused owner UI case for CI. NOT_RUN locally: known Chromium OS blocker.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {chromium} from 'playwright';
import {build} from 'vite';
import {startNativeDeviceFixture} from './native-device-fixture.mjs';
const root=resolve(import.meta.dirname,'..');let browser;
before(async()=>{await build({root,configFile:resolve(root,'vite.config.mjs')});browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true,args:['--no-sandbox']});});
after(async()=>{await browser?.close();});
test('320px owner approves a public pairing, explicitly enables until revoked, and revokes the same device',async t=>{
 const h=await startNativeDeviceFixture(),context=await browser.newContext({viewport:{width:320,height:800}});t.after(async()=>{await context.close();await h.close();});context.setDefaultTimeout(15000);await context.addCookies([h.browserCookie()]);
 const calls=[],errors=[];
 await context.route(h.origin+'/**',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.pathname==='/'||url.pathname.startsWith('/assets/')){const file=url.pathname==='/'?'index.html':url.pathname.slice(1);await route.fulfill({body:await readFile(resolve(root,'dist',file)),contentType:extname(file)==='.html'?'text/html':extname(file)==='.css'?'text/css':'text/javascript'});return;}
  if(url.pathname.startsWith('/v1/auth/machine-credentials/'))calls.push({path:url.pathname,body:request.postDataJSON()});
  const response=await h.fetch(request.url(),{method:request.method(),headers:request.headers(),...(request.postDataBuffer()?{body:request.postDataBuffer()}:{})}),headers=Object.fromEntries(response.headers),cookies=response.headers.getSetCookie();if(cookies.length)headers['set-cookie']=cookies.join('\n');await route.fulfill({status:response.status,headers,body:Buffer.from(await response.arrayBuffer())});
 });
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(h.origin);await page.getByRole('button',{name:'Machine devices',exact:true}).click();await page.getByLabel('Public pairing proposal',{exact:true}).fill(JSON.stringify(h.proposal));await page.getByRole('button',{name:'Review pairing approval',exact:true}).click();
 const review=page.getByRole('region',{name:'Review owner action'});await review.getByText(h.proposal.approval.secretDigest,{exact:true}).waitFor();assert.equal(await review.getByRole('button',{name:'Approve pairing',exact:true}).isDisabled(),true);assert.equal(calls.filter(call=>call.path.endsWith('/pairing/approve')).length,0);await review.getByRole('checkbox').check();await review.getByRole('button',{name:'Approve pairing',exact:true}).click();await page.getByText('Pairing approval is recorded.',{exact:false}).waitFor();
 await h.redeem();await page.getByRole('button',{name:'Check current devices',exact:true}).click();await page.getByRole('button',{name:'Review device duration',exact:true}).click();await page.getByLabel('Access duration',{exact:true}).selectOption('until-revoked');await page.getByRole('button',{name:'Review exact device approval',exact:true}).click();await review.getByText('Until you revoke it; no idle or fixed expiry',{exact:true}).waitFor();assert.equal(await review.getByRole('button',{name:'Apply device approval',exact:true}).isDisabled(),true);assert.equal(calls.filter(call=>call.path.endsWith('/device/enable')).length,0);await review.getByRole('checkbox').check();await review.getByRole('button',{name:'Apply device approval',exact:true}).click();await page.getByText('Device approval is recorded.',{exact:true}).waitFor();
 const enable=calls.find(call=>call.path.endsWith('/device/enable'));assert.equal(enable.body.credentialId,h.ids.machineCredential);assert.equal(enable.body.expectedVersion,0);assert.equal(enable.body.untilRevoked,true);assert.equal(enable.body.idleTimeoutMs,null);assert.equal(enable.body.absoluteExpiresAt,null);
 await page.getByRole('button',{name:'Review device revocation',exact:true}).click();await review.getByRole('checkbox').check();await review.getByRole('button',{name:'Revoke access',exact:true}).click();await page.getByText('Device access is revoked.',{exact:true}).waitFor();assert.equal(calls.filter(call=>call.path.endsWith('/device/revoke')).length,1);assert.equal(calls.find(call=>call.path.endsWith('/device/revoke')).body.credentialId,h.ids.machineCredential);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);const publicState=await page.evaluate(()=>({text:document.body.innerText,local:Object.values(localStorage),session:Object.values(sessionStorage),cookies:document.cookie}));h.assertPublic({publicState,calls});assert.equal(publicState.cookies.includes('__Host-projektor_session'),false);assert.deepEqual(errors,[]);
});
