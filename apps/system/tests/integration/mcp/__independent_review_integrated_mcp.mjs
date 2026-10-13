// @module verification
// @role review-integrated-mcp
// Protocol/domain integration: real official client, product router, workerd, canonical D1.
// Synthetic signing keys only. No deployment, live configuration or OAuth grant.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {CfWorkerJsonSchemaValidator} from '@modelcontextprotocol/client/validators/cf-worker';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,basename} from 'node:path';
import {prepareLocalD1,verifyCanonicalLedger} from "../../support/local-d1-fixture.mjs";
const root=await mkdtemp(join(tmpdir(),'projektor-mcp-transport-'));
await mkdir('.local/evidence',{recursive:true});
const report={scope:'official MCP client + product router + real isolated workerd/D1; synthetic assertions; no OAuth grant',productionActions:0,results:[]};
const origin='https://projektor.example.invalid',issuer='https://synthetic-owner.cloudflareaccess.com',aud='a'.repeat(64),subject='transport-agent';
const pair=await generateKeyPair('RS256',{extractable:true});
const jwk={...await exportJWK(pair.publicKey),kid:'transport-test',alg:'RS256',use:'sig'};
let dropExecuteResponse=false;
let mf,db,fixture,client,token,worker;let wireCatalogues=0,dropPreparationResponse=false;
const sign=(lifetime=600)=>{const now=Math.floor(Date.now()/1000);return new SignJWT({iss:issuer,aud:[aud],sub:subject,type:'app',iat:now,nbf:now,exp:now+lifetime}).setProtectedHeader({alg:'RS256',kid:jwk.kid}).sign(pair.privateKey);};
async function start(overrides={}) {
  if(client){await client.close();client=undefined;}
  if(mf)await mf.dispose();
  mf=new Miniflare(convertV4MiniflareOptions({name:'mcp-transport-isolated',modules:[{type:'ESModule',path:root+'/worker.mjs',contents:await readFile(root+'/worker.mjs','utf8')},...await Promise.all(['argon2.wasm','blake2b.wasm'].map(async name=>({type:'CompiledWasm',path:root+'/'+name,contents:await readFile('src/adapters/crypto/generated/'+name)})))],modulesRoot:root,compatibilityDate:'2026-10-09',compatibilityFlags:['nodejs_compat'],...fixture,
    bindings:{AUTH_ORIGIN:origin,MCP_ENABLED:'true',MCP_ACCESS_ISSUER:issuer,MCP_ACCESS_AUDIENCE:aud,MCP_RESOURCE_METADATA_URL:origin+'/.well-known/cloudflare-access-protected-resource/',...overrides},
    serviceBindings:{ASSETS:()=>new Response('SPA fallback')},outboundService:request=>{assert.equal(request.url,issuer+'/cdn-cgi/access/certs');for(const key of ['Authorization','Cookie','Cf-Access-Jwt-Assertion'])assert.equal(request.headers.get(key),null);return Response.json({keys:[jwk]});},host:'127.0.0.1',port:0,cf:false,logRequests:false}));
  await mf.ready;db=await mf.getD1Database('DB');worker=await mf.getWorker();token=await sign();
}
const request=(path,options={})=>worker.fetch(origin+path,{...options,headers:{Host:new URL(origin).host,...options.headers}});
async function connect(extraHeaders={}){if(client)await client.close();client=new Client({name:'projektor-isolated-client',version:'1.0.0'},{jsonSchemaValidator:new CfWorkerJsonSchemaValidator()});const transport=new StreamableHTTPClientTransport(new URL(origin+'/mcp'),{requestInit:{headers:{Host:new URL(origin).host,'Cf-Access-Jwt-Assertion':token,...extraHeaders},redirect:'error'},fetch:async(url,init)=>{const r=await worker.fetch(String(url),init);if(dropExecuteResponse&&typeof init?.body==='string'&&JSON.parse(init.body).params?.name==='operation_execute'){dropExecuteResponse=false;await r.arrayBuffer();throw new TypeError('Synthetic loss of committed business response');}if(dropPreparationResponse&&typeof init?.body==='string'&&JSON.parse(init.body).params?.name==='issue_create_prepare'){dropPreparationResponse=false;await r.arrayBuffer();throw new TypeError('Simulated loss of acknowledged preparation response');}assert.equal(r.headers.get('mcp-session-id'),null);assert.equal(r.headers.get('Cache-Control'),'no-store');if(r.headers.get('Content-Type')?.includes('application/json')){const body=await r.clone().json();if(body.result?.tools){wireCatalogues++;for(const t of body.result.tools){assert.deepEqual(t.securitySchemes,[{type:'oauth2',scopes:[]}]);assert.deepEqual(t._meta.securitySchemes,t.securitySchemes);}}}return r;}});await client.connect(transport);}
const preparedMutations=new Set(['issue_create','issue_update','wiki_create','wiki_update','comment_create','comment_update','execution_change','execution_report']);
async function call(name,args={}){if(preparedMutations.has(name)){const prepared=await client.callTool({name:name+'_prepare',arguments:args});if(prepared.isError)return prepared;assert.equal(prepared.structuredContent.recorded,true);return client.callTool({name:'operation_execute',arguments:{operationId:args.input.operationId}});}return client.callTool({name,arguments:args});}
async function success(name,args={}){const r=await call(name,args);assert.equal(r.isError,undefined,JSON.stringify(r));assert.deepEqual(JSON.parse(r.content[0].text),r.structuredContent);return r.structuredContent;}
async function test(name,fn){await fn();report.results.push({name,passed:true});}
try {
 await build({entryPoints:['tests/integration/mcp/__independent_mcp_fixture.ts'],outfile:root+'/worker.mjs',bundle:true,format:'esm',platform:'neutral',conditions:['workerd','worker','browser'],mainFields:['module','main'],external:['node:*','cloudflare:*'],plugins:[{name:'wasm',setup(b){b.onResolve({filter:/\.wasm$/},a=>({path:'./'+basename(a.path),external:true}));}}]});
 fixture=await prepareLocalD1(root);await start({MCP_ENABLED:'false'});await verifyCanonicalLedger(db);
 await test('disabled and all reserved paths avoid SPA fallback',async()=>{for(const path of ['/mcp','/mcp/extra','/.well-known/cloudflare-access-protected-resource/','/.well-known/unknown'])assert.equal((await request(path)).status,404);assert.equal(await (await request('/ordinary')).text(),'SPA fallback');});
 await start();
 await test('unauthenticated requests give a metadata challenge and no HTML/cookie/API fallback',async()=>{for(const headers of [{},{Cookie:'__Host-projektor_session='+'a'.repeat(43)},{Authorization:'Bearer '+'a'.repeat(43)}]){const r=await request('/mcp',{method:'POST',headers});assert.equal(r.status,401,await r.text());assert.equal(r.headers.get('WWW-Authenticate'),'Bearer resource_metadata="'+origin+'/.well-known/cloudflare-access-protected-resource/"');}});
 await test('valid unbound assertion cannot initialize',async()=>{assert.equal((await request('/mcp',{method:'POST',headers:{'Cf-Access-Jwt-Assertion':token}})).status,403);});
 await db.prepare("INSERT INTO principals VALUES('A','agent','Transport Agent',NULL,1,1)").run();
 for(const p of ['view','edit','assign','transition','execute','manage'])await db.prepare("INSERT INTO memberships VALUES('A','P',?)").bind(p).run();
 await db.prepare("INSERT INTO workspaces VALUES('W','Shared workspace','{}')").run();
 await db.prepare("INSERT INTO projects VALUES('P','W','PK','project-p','Project P','','{}'),('OTHER','W','OTHER','other-project','Private other project','','{}')").run();
 await db.prepare("INSERT INTO memberships VALUES('A','OTHER','view'),('A','workspace:W','view')").run();
 for(const [kind,id,scopeId,value] of [['projects','P','P',{title:'Preserved project'}],['task_types','shared-definition','workspace:W',{name:'Shared definition'}],['task_types','private-definition','OTHER',{name:'PRIVATE OTHER'}],['workspace_members','private-member','workspace:W',{name:'PRIVATE WORKSPACE'}]])await db.prepare('INSERT INTO imported_entities VALUES(?,?,?,?,?,?)').bind(kind,id,'W',scopeId,JSON.stringify(value),'fixture').run();
 for(let n=0;n<12;n++)await db.prepare('INSERT INTO imported_entities VALUES(?,?,?,?,?,?)').bind('activity','source-history-'+n,'W','P',JSON.stringify({entity_id:'P',created_at:'2026-10-01T00:00:'+String(n).padStart(2,'0')+'Z'}),'fixture').run();
 await db.prepare('INSERT INTO federated_bindings VALUES(?,?,?,?,?,unixepoch())').bind('transport-binding','A',issuer,aud,subject).run();
 await db.prepare("INSERT INTO federated_credentials(id,binding_id,principal_auth_version,created_at,expires_at) VALUES('transport-credential','transport-binding',1,unixepoch()-100,unixepoch()+3600)").run();
 for(const p of ['view','edit','assign','transition','execute'])await db.prepare("INSERT INTO federated_grants VALUES('transport-credential','P',?)").bind(p).run();
 await test('origin host query and non-POST contract are enforced',async()=>{const headers={'Cf-Access-Jwt-Assertion':token};for(const extra of [{Origin:'https://wrong.invalid'},{'X-Test-Host':'wrong.invalid'}])assert.equal((await request('/mcp',{method:'POST',headers:{...headers,...extra}})).status,403);assert.equal((await request('/mcp?access_token=x',{method:'POST',headers})).status,400);for(const method of ['GET','DELETE'])assert.equal((await request('/mcp',{method,headers})).status,405);assert.equal((await request('/mcp/extra',{headers})).status,404);});
 await test('official initialize notification list and closure-bound identity succeed statelessly',async()=>{await connect();const listed=await client.listTools();assert.equal(listed.tools.length,29);assert(!listed.tools.some(t=>preparedMutations.has(t.name)));assert(wireCatalogues>0);for(const t of listed.tools){assert.equal(t.inputSchema.additionalProperties,false,t.name);assert(t.outputSchema,t.name);assert.deepEqual(t._meta.securitySchemes,[{type:'oauth2',scopes:[]}]);for(const k of ['readOnlyHint','destructiveHint','idempotentHint','openWorldHint'])assert.equal(typeof t.annotations[k],'boolean');}assert(!listed.tools.some(t=>/credential|browser|admin|http|shell/.test(t.name)));const me=await success('identity_current');assert.equal(me.principal.id,'A');assert.equal(me.authentication,'federated');assert.deepEqual(me.projects,[{id:'P',permissions:['assign','edit','execute','transition','view']}]);const directory=await success('directory_get');assert.deepEqual(directory.projects.map(p=>p.id),['P']);assert.deepEqual(directory.workspaces,[]);assert.deepEqual(directory.definitions.map(d=>d.record.name),['Shared definition']);const source=await success('source_get',{scopeId:'P',kind:'projects',id:'P',page:2});assert.equal(source.historyTotal,12);assert.equal(source.history.length,2);assert.equal((await success('legacy_resolve',{path:'/projects/view/project-p'})).id,'P');});
 await test('oversized body and unknown authority fields never dispatch',async()=>{const r=await request('/mcp',{method:'POST',headers:{'Cf-Access-Jwt-Assertion':token,Accept:'application/json, text/event-stream','Content-Type':'application/json'},body:'x'.repeat(96*1024+1)});assert.equal(r.status,413);const bad=await call('issue_create',{projectId:'P',actor:'OWNER',input:{operationId:'bad',body:'injected'}});assert.equal(bad.isError,true);assert.equal(await db.prepare('SELECT count(*) FROM issues').first('count(*)'),0);});
 await db.prepare("UPDATE write_gate SET mode='stopped' WHERE id=1").run();
 await test('stopped mutations reject but authorized reads continue',async()=>{await success('issue_list',{projectId:'P'});const r=await call('issue_create',{projectId:'P',input:{operationId:'stopped',body:'blocked'}});assert.equal(r.isError,true);assert.equal(r.structuredContent.status,503);assert.equal(r.structuredContent.operationId,'stopped');assert.equal(await db.prepare('SELECT count(*) FROM operation_results').first('count(*)'),0);});
 await db.prepare("UPDATE write_gate SET mode='open' WHERE id=1").run();
 const created=await success('issue_create',{projectId:'P',input:{operationId:'issue-create',title:'Transport task',body:'Work'}}),id=created.snapshot.id;
 await test('strict schemas preserve issue content revision and same-ID receipt across fresh Worker',async()=>{await success('issue_get',{projectId:'P',issueId:id});assert.equal((await success('legacy_resolve',{path:'/projects/PK/issues/1/transport-task'})).id,id);await success('issue_history',{projectId:'P',issueId:id});await start();await connect();const receipt=await success('operation_result',{scopeId:'P',operationId:'issue-create',resource:{kind:'issue'}});assert.equal(receipt.snapshot.id,id);const replay=await success('issue_create',{projectId:'P',input:{operationId:'issue-create',title:'Transport task',body:'Work'}});assert.equal(replay.source,'recovered');assert.equal(await db.prepare('SELECT count(*) FROM issues').first('count(*)'),1);assert.equal(await db.prepare('SELECT count(*) FROM issue_history').first('count(*)'),1);});
 await test('lost prepare acknowledgement survives fresh runtime and never autoexecutes',async()=>{
  const beforeIssues=await db.prepare('SELECT count(*) FROM issues').first('count(*)'),beforeResults=await db.prepare('SELECT count(*) FROM operation_results').first('count(*)');
  dropPreparationResponse=true;
  await assert.rejects(client.callTool({name:'issue_create_prepare',arguments:{projectId:'P',input:{operationId:'lost-prepare',body:'Durable retained input'}}}));
  await start();await connect();
  const page=await success('operation_list'),saved=page.operations.find(o=>o.operationId==='lost-prepare');assert(saved);assert.equal(saved.input.body,'Durable retained input');assert.equal(saved.result.status,'unknown');
  const recovered=await success('operation_get',{operationId:'lost-prepare'});assert.equal(recovered.recorded,true);assert.equal(recovered.inputHash,saved.inputHash);
  // A later same-ID preparation remains preparation only, including after a lost response.
  await success('issue_create_prepare',{projectId:'P',input:{operationId:'lost-prepare',body:'Durable retained input'}});
  assert.equal(await db.prepare('SELECT count(*) FROM issues').first('count(*)'),beforeIssues);assert.equal(await db.prepare('SELECT count(*) FROM operation_results').first('count(*)'),beforeResults);
  const executed=await success('operation_execute',{operationId:'lost-prepare'});assert.equal(executed.source,'committed');
  await start();await connect();const original=await success('operation_result',{scopeId:'P',operationId:'lost-prepare',resource:{kind:'issue'}});assert.equal(original.snapshot.id,executed.snapshot.id);
  assert.equal((await success('operation_get',{operationId:'lost-prepare'})).result.status,'confirmed');assert.equal((await success('operation_execute',{operationId:'lost-prepare'})).source,'recovered');
  for(const table of ['issues','issue_history','operation_results']){const column=table==='issues'?'id':table==='issue_history'?'issue_id':'operation_id',value=table==='operation_results'?'lost-prepare':executed.snapshot.id;assert.equal(await db.prepare(`SELECT count(*) FROM ${table} WHERE ${column}=?`).bind(value).first('count(*)'),1);}
 });
 await success('issue_update',{projectId:'P',issueId:id,input:{operationId:'assign',revision:1,assigneeId:'A'}});
 await test('official client completes assigned execution while issue resolution stays separate',async()=>{const acquired=await success('execution_change',{projectId:'P',issueId:id,input:{action:'acquire',operationId:'acquire'}}),attemptId=acquired.snapshot.attemptId;await success('execution_current',{projectId:'P',issueId:id});await success('execution_report',{projectId:'P',issueId:id,input:{action:'progress',operationId:'progress',attemptId,message:'Working'}});await success('execution_report',{projectId:'P',issueId:id,input:{action:'completed',operationId:'completed',attemptId,message:'Done'}});await success('execution_reports',{projectId:'P',issueId:id});await success('execution_report_history',{projectId:'P',issueId:id});assert.equal((await success('issue_get',{projectId:'P',issueId:id})).issue.state,'Backlog');await success('issue_update',{projectId:'P',issueId:id,input:{operationId:'resolve',revision:2,state:'Done'}});await success('issue_history',{projectId:'P',issueId:id});await success('assignee_list',{projectId:'P'});});
 await test('interrupted reconcile and explicit restart preserve closed snapshot unions',async()=>{
  const second=await success('issue_create',{projectId:'P',input:{operationId:'second-issue',body:'Recover interrupted work'}}),iid=second.snapshot.id;
  await success('issue_update',{projectId:'P',issueId:iid,input:{operationId:'second-assign',revision:1,assigneeId:'A'}});
  const acquired=await success('execution_change',{projectId:'P',issueId:iid,input:{action:'acquire',operationId:'second-acquire'}}),aid=acquired.snapshot.attemptId;
  const interrupted=await success('execution_change',{projectId:'P',issueId:iid,input:{action:'interrupt',operationId:'second-interrupt',attemptId:aid,leaseVersion:1}});
  const leaseVersion=interrupted.snapshot.leaseVersion;
  const unknown=await success('execution_report',{projectId:'P',issueId:iid,input:{action:'reconcile',operationId:'second-unknown',attemptId:aid,leaseVersion,outcome:'unknown',externalOperationId:'external-id',message:'Outcome requires investigation'}});
  assert.equal(unknown.snapshot.nextAction,'remain_interrupted');
  assert.equal((await call('execution_report',{projectId:'P',issueId:iid,input:{action:'restart',operationId:'must-not-restart',attemptId:aid,leaseVersion,confirmationOperationId:'second-unknown'}})).isError,true);
  await success('execution_report',{projectId:'P',issueId:iid,input:{action:'reconcile',operationId:'second-confirmed',attemptId:aid,leaseVersion,outcome:'not_performed',externalOperationId:'external-id',message:'Verified external operation did not run'}});
  const restarted=await success('execution_report',{projectId:'P',issueId:iid,input:{action:'restart',operationId:'second-restart',attemptId:aid,leaseVersion,confirmationOperationId:'second-confirmed'}});
  assert.equal(restarted.snapshot.nextAction,'execute_new_attempt');assert.notEqual(restarted.snapshot.attempt.attemptId,aid);
  await success('execution_reports',{projectId:'P',issueId:iid});await success('execution_report_history',{projectId:'P',issueId:iid});
 });
 await test('wiki comment read history and edits use same strict domain contracts',async()=>{const wiki=await success('wiki_create',{scopeId:'P',input:{operationId:'wiki-create',body:'',title:'Notes'}}),wid=wiki.snapshot.id;await success('wiki_update',{scopeId:'P',wikiId:wid,input:{operationId:'wiki-edit',revision:1,body:'Updated',references:[]}});await success('wiki_list',{scopeId:'P'});await success('wiki_get',{scopeId:'P',wikiId:wid});await success('wiki_history',{scopeId:'P',wikiId:wid});const comment=await success('comment_create',{scopeId:'P',parentKind:'wiki',parentId:wid,input:{operationId:'comment-create',body:'A comment'}}),cid=comment.snapshot.id;await success('comment_update',{scopeId:'P',parentKind:'wiki',parentId:wid,commentId:cid,input:{operationId:'comment-edit',revision:1,body:'Edited'}});await success('comment_get',{scopeId:'P',parentKind:'wiki',parentId:wid,commentId:cid});await success('comment_list',{scopeId:'P',parentKind:'wiki',parentId:wid});await success('comment_history',{scopeId:'P',parentKind:'wiki',parentId:wid,commentId:cid});});
 await test('grant ceiling cannot read workspace or other project and importing blocks business reads',async()=>{for(const scopeId of ['OTHER','workspace:OTHER'])assert.equal((await call('wiki_list',{scopeId})).isError,true);await db.prepare("UPDATE write_gate SET mode='importing' WHERE id=1").run();const r=await call('issue_list',{projectId:'P'});assert.equal(r.isError,true);assert.equal(r.structuredContent.error,'import_in_progress');assert.equal((await success('identity_current')).principal.id,'A');});
 await db.prepare("UPDATE write_gate SET mode='open' WHERE id=1").run();
 await test('independent federated prepare and execute recheck grant ceiling in actual D1 batch',async()=>{
  const op='independent-grant-race',input={operationId:op,body:'Recoverable grant race'};
  const before=await db.prepare('SELECT count(*) FROM operation_results').first('count(*)');
  token=await sign();await connect({'X-Test-Race':'grant-batch'});
  let r=await call('issue_create_prepare',{projectId:'P',input});assert.equal(r.isError,true);assert.equal(r.structuredContent.status,403);assert.equal(await db.prepare('SELECT count(*) FROM operation_intents WHERE operation_id=?').bind(op).first('count(*)'),0);
  await db.prepare("INSERT INTO federated_grants VALUES('transport-credential','P','edit')").run();await connect();
  const saved=await success('issue_create_prepare',{projectId:'P',input});assert.equal(saved.result.status,'unknown');
  await connect({'X-Test-Race':'grant-batch'});r=await call('operation_execute',{operationId:op});assert.equal(r.isError,true);assert.equal(r.structuredContent.status,403);assert.equal(r._meta?.['mcp/www_authenticate'],undefined);
  assert.equal(await db.prepare('SELECT count(*) FROM issues WHERE id=?').bind(saved.target.targetId).first('count(*)'),0);assert.equal(await db.prepare('SELECT count(*) FROM issue_history WHERE issue_id=?').bind(saved.target.targetId).first('count(*)'),0);assert.equal(await db.prepare('SELECT count(*) FROM operation_results').first('count(*)'),before);
  await db.prepare("INSERT INTO federated_grants VALUES('transport-credential','P','edit')").run();await start();await connect();
  const recovered=(await success('operation_list')).operations.find(o=>o.operationId===op);assert.equal(recovered.input.body,input.body);assert.equal(recovered.result.status,'unknown');
  dropExecuteResponse=true;await assert.rejects(client.callTool({name:'operation_execute',arguments:{operationId:op}}));
  await start();await connect();const result=await success('operation_get',{operationId:op});assert.equal(result.result.status,'confirmed');assert.equal(result.result.snapshot.body,input.body);
  assert.equal((await success('operation_execute',{operationId:op})).source,'recovered');
  for(const [table,column,value]of [['issues','id',saved.target.targetId],['issue_history','issue_id',saved.target.targetId],['operation_results','operation_id',op]])assert.equal(await db.prepare(`SELECT count(*) FROM ${table} WHERE ${column}=?`).bind(value).first('count(*)'),1);
 });
 await test('independent assertion expiration at business batch keeps intent unknown and emits reauthentication challenge',async()=>{
  const op='independent-expiry-batch';await success('issue_create_prepare',{projectId:'P',input:{operationId:op,body:'No write after expiry'}});
  token=await sign(2);await connect({'X-Test-Race':'expire-batch'});const r=await call('operation_execute',{operationId:op});assert.equal(r.isError,true);assert.equal(r.structuredContent.status,401);assert.match(r._meta['mcp/www_authenticate'][0],/error="invalid_token"/);
  assert.equal(await db.prepare('SELECT count(*) FROM operation_results WHERE operation_id=?').bind(op).first('count(*)'),0);
  token=await sign();await connect();assert.equal((await success('operation_get',{operationId:op})).result.status,'unknown');
 });
 await test('assertion expiry during callback challenges without dispatching or resending',async()=>{
  token=await sign(2);await connect({'X-Test-Race':'expire'});
  const before=await db.prepare('SELECT count(*) FROM operation_results').first('count(*)');
  const r=await call('issue_create',{projectId:'P',input:{operationId:'expired-midcall',body:'Must not dispatch'}});
  assert.equal(r.isError,true);assert.equal(r.structuredContent.status,401);
  assert.equal(r.structuredContent.operationId,'expired-midcall');
  assert.match(r._meta['mcp/www_authenticate'][0],/error="invalid_token"/);
  assert.match(r._meta['mcp/www_authenticate'][0],/error_description=/);
  assert(!JSON.stringify(r).includes(token));assert.equal(await db.prepare('SELECT count(*) FROM operation_results').first('count(*)'),before);
 });
 await test('application revocation during callback returns403 with no OAuth refresh loop',async()=>{
  token=await sign();await connect({'X-Test-Race':'revoke'});
  const r=await call('issue_get',{projectId:'P',issueId:id});assert.equal(r.isError,true);
  assert.equal(r.structuredContent.status,403);assert.equal(r.structuredContent.error,'federation_forbidden');assert.equal(r._meta?.['mcp/www_authenticate'],undefined);assert(!JSON.stringify(r).includes('Transport task'));
 });
 report.passed=true;
}catch(error){report.passed=false;report.failure=String(error);throw error;}
finally{if(client)await client.close();if(mf)await mf.dispose();await rm(root,{recursive:true,force:true});await writeFile('../../mcp-contract-review/independent-integrated-mcp.json',JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify(report));
