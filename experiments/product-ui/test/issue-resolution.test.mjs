// One focused real-query -> existing UI adapter -> rendering check; no Chromium claim.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'vite';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createAppAuth,createPairing} from '../src/app-auth.mjs';
import {validateContentIssue} from '../vendor/client/issue-content.mjs';
const core=resolve(process.env.PROJEKTOR_CORE_SOURCE??resolve(import.meta.dirname,'../../atomic-command-poc'));
const {startAppAuthHarness}=await import(pathToFileURL(resolve(core,'browser-test/app-auth-server.mjs')));
test('actual Issue query retains its resolution timestamp through the adapter; UI shows clock/zone and preserves unknown',async t=>{
 const h=await startAppAuthHarness();t.after(()=>h.close());const vite=await createServer({server:{middlewareMode:true,hmr:false},appType:'custom'});t.after(()=>vite.close());
 const {IssueResolution}=await vite.ssrLoadModule('/src/components.tsx'),{createProductPorts}=await vite.ssrLoadModule('/src/product-ports.ts'),jar=new Map();
 const fetchImpl=async(url,init)=>{const response=await h.fetch(url.toString(),{...init,headers:{...init.headers,cookie:[...jar].map(([name,value])=>name+'='+value).join(';'),...(init.method==='POST'?{origin:h.base,'sec-fetch-site':'same-origin'}:{})}});for(const line of response.headers.getSetCookie()){const[name,...parts]=line.split(';')[0].split('=');jar.set(name,parts.join('='));}return response;};
 const auth=createAppAuth({baseUrl:h.base,fetchImpl}),pair=await createPairing('enroll');await h.approveGrant({grantId:pair.grantId,fingerprint:pair.fingerprint,purpose:pair.purpose});await auth.completeGrant(pair,'synthetic timestamp fixture password',randomUUID());await auth.login('synthetic timestamp fixture password');
 const ports=createProductPorts({baseUrl:h.base,fetchImpl}),bootstrap=await ports.bootstrap({signal:new AbortController().signal}),workspace=bootstrap.workspaces[0],selected={workspace,principal:workspace.principal??bootstrap.principal},session=await ports.session(selected),issueId=randomUUID();
 const send=async(commandType,expectedVersion,payload)=>{const operationId=randomUUID(),response=await fetchImpl(h.base+'/v1/workspaces/'+workspace.id+'/commands',{method:'POST',headers:{'content-type':'application/json','x-projektor-csrf':'same-origin','idempotency-key':operationId},body:JSON.stringify({schemaVersion:1,workspaceId:workspace.id,workspaceEpoch:workspace.epoch,operationId,commandType,entityId:issueId,expectedVersion,payload})});assert.equal(response.status,200);const body=await response.json();assert.equal(body.data.outcome,'committed');};
 await send('Issue.Create',0,{projectId:h.ids.project,title:'Synthetic resolution display',description:'Synthetic body',assigneeId:null,priority:'P1',parentId:null,initialStatus:'ready'});
 await send('Issue.Transition',1,{payloadVersion:2,entryId:randomUUID(),toStatus:'done',result:{summary:'Synthetic completed work',artifactIds:[]}});
 const body=await ports.contentAPI(selected).issue({session,issueId}),issue=validateContentIssue(body,session,issueId);assert.equal(issue.resolutionKind,'done');assert.ok(Number.isSafeInteger(issue.resolvedAt));
 const render=props=>renderToStaticMarkup(createElement(IssueResolution,props)),known=render(issue);assert.match(known,/Recorded resolution \(done\)/);assert.ok(known.includes(new Date(issue.resolvedAt).toISOString()));assert.match(known,/\d{1,2}:\d{2}/);assert.ok(known.includes(new Date(issue.resolvedAt).toLocaleString(undefined,{timeZoneName:'short'})));assert.doesNotMatch(known,/Time unknown/);
 const unknown=render({...issue,resolvedAt:null,compatibility:{completionReportAt:issue.resolvedAt}});assert.match(unknown,/Time unknown/);assert.doesNotMatch(unknown,/<time\b/);assert.ok(!unknown.includes(String(issue.resolvedAt)));assert.equal(render({resolutionKind:null,resolvedAt:null}),'');
});
