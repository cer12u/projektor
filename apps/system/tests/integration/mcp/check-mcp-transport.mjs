// @module verification
// @role mcp-transport
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
import {createHash} from 'node:crypto';
import {prepareLocalD1,verifyCanonicalLedger} from "../../support/local-d1-fixture.mjs";
const root=await mkdtemp(join(tmpdir(),'projektor-mcp-transport-'));
await mkdir('.local/evidence',{recursive:true});
const mode=process.env.MCP_TRANSPORT_MODE??'federated';
const report={mode,externalProviderRequests:0,scope:'official MCP client + product router + real isolated workerd/D1; synthetic assertions; no OAuth grant',productionActions:0,results:[]};
const origin='https://projektor.example.invalid',issuer='https://synthetic-owner.cloudflareaccess.com',aud='a'.repeat(64),subject='transport-agent';
const pair=await generateKeyPair('RS256',{extractable:true});
const jwk={...await exportJWK(pair.publicKey),kid:'transport-test',alg:'RS256',use:'sig'};
let mf,db,fixture,client,token,worker;let wireCatalogues=0,wireRequests=0,dropPreparationResponse=false;
const sign=(lifetime=600)=>{const now=Math.floor(Date.now()/1000);return new SignJWT({iss:issuer,aud:[aud],sub:subject,type:'app',iat:now,nbf:now,exp:now+lifetime}).setProtectedHeader({alg:'RS256',kid:jwk.kid}).sign(pair.privateKey);};
async function start(overrides={},federated=true) {
  if(client){await client.close();client=undefined;}
  if(mf)await mf.dispose();
  mf=new Miniflare(convertV4MiniflareOptions({name:'mcp-transport-isolated',modules:[{type:'ESModule',path:root+'/worker.mjs',contents:await readFile(root+'/worker.mjs','utf8')},...await Promise.all(['argon2.wasm','blake2b.wasm'].map(async name=>({type:'CompiledWasm',path:root+'/'+name,contents:await readFile('src/adapters/crypto/generated/'+name)})))],modulesRoot:root,compatibilityDate:'2026-10-09',compatibilityFlags:['nodejs_compat'],...fixture,
    bindings:{AUTH_ORIGIN:origin,MCP_ENABLED:'true',...(federated?{MCP_ACCESS_ISSUER:issuer,MCP_ACCESS_AUDIENCE:aud,MCP_RESOURCE_METADATA_URL:origin+'/.well-known/cloudflare-access-protected-resource/'}:{}),...overrides},
    serviceBindings:{ASSETS:()=>new Response('SPA fallback')},outboundService:request=>{report.externalProviderRequests++;assert(federated,'API-only mode must not call an external identity provider');assert.equal(request.url,issuer+'/cdn-cgi/access/certs');for(const key of ['Authorization','Cookie','Cf-Access-Jwt-Assertion'])assert.equal(request.headers.get(key),null);return Response.json({keys:[jwk]});},host:'127.0.0.1',port:0,cf:false,logRequests:false}));
  await mf.ready;db=await mf.getD1Database('DB');worker=await mf.getWorker();token=await sign();
}
const request=(path,options={})=>worker.fetch(origin+path,{...options,headers:{Host:new URL(origin).host,...options.headers}});
async function connect(extraHeaders={},appToken){if(client)await client.close();client=new Client({name:'projektor-isolated-client',version:'1.0.0'},{jsonSchemaValidator:new CfWorkerJsonSchemaValidator()});const transport=new StreamableHTTPClientTransport(new URL(origin+(appToken?'/mcp':'/mcp/federated')),{requestInit:{headers:{Host:new URL(origin).host,...(appToken?{Authorization:'Bearer '+appToken}:{'Cf-Access-Jwt-Assertion':token}),...extraHeaders},redirect:'error'},fetch:async(url,init)=>{wireRequests++;const r=await worker.fetch(String(url),init);if(dropPreparationResponse&&typeof init?.body==='string'&&JSON.parse(init.body).params?.name==='issue_create_prepare'){dropPreparationResponse=false;await r.arrayBuffer();throw new TypeError('Simulated loss of acknowledged preparation response');}assert.equal(r.headers.get('mcp-session-id'),null);assert.equal(r.headers.get('Cache-Control'),'no-store');if(r.headers.get('Content-Type')?.includes('application/json')){const body=await r.clone().json();if(body.result?.tools){wireCatalogues++;for(const t of body.result.tools){if(appToken){assert.equal(t.securitySchemes,undefined);assert.equal(t._meta?.securitySchemes,undefined);}else{assert.deepEqual(t.securitySchemes,[{type:'oauth2',scopes:[]}]);assert.deepEqual(t._meta.securitySchemes,t.securitySchemes);}}}}return r;}});await client.connect(transport);}
const preparedMutations=new Set(['issue_create','issue_update','wiki_create','wiki_update','comment_create','comment_update','execution_change','execution_report']);
async function call(name,args={}){if(preparedMutations.has(name)){const prepared=await client.callTool({name:name+'_prepare',arguments:args});if(prepared.isError)return prepared;assert.equal(prepared.structuredContent.recorded,true);return client.callTool({name:'operation_execute',arguments:{operationId:args.input.operationId}});}return client.callTool({name,arguments:args});}
async function success(name,args={}){const r=await call(name,args);assert.equal(r.isError,undefined,JSON.stringify(r));assert.deepEqual(JSON.parse(r.content[0].text),r.structuredContent);return r.structuredContent;}
async function test(name,fn){await fn();report.results.push({name,passed:true});}
async function runApplicationCredentialChecks(){
 await start({},false);await verifyCanonicalLedger(db);
 const appToken='k'.repeat(43),humanToken='h'.repeat(43),hash=value=>createHash('sha256').update(value).digest('hex');
 await db.prepare("INSERT INTO principals VALUES('API_A','agent','API Agent',NULL,1,1),('HUMAN','human','Human','human',1,1)").run();
 for(const [id,principal,value] of [['api-key','API_A',appToken],['human-key','HUMAN',humanToken]])await db.prepare('INSERT INTO api_credentials VALUES(?,?,?,unixepoch()+3600,NULL)').bind(id,principal,hash(value)).run();
 for(const permission of ['view','edit','assign','transition','execute']){
  await db.prepare("INSERT INTO memberships VALUES('API_A','P',?)").bind(permission).run();
  await db.prepare("INSERT INTO api_grants VALUES('api-key','P',?)").bind(permission).run();
 }
 await test('API-only configuration initializes official client without Cloudflare settings or provider requests',async()=>{
  await connect({},appToken);const tools=await client.listTools();assert.equal(tools.tools.length,29);
  assert(tools.tools.every(t=>!t._meta?.securitySchemes));
  const me=await success('identity_current');assert.equal(me.principal.id,'API_A');assert.equal(me.authentication,'api');assert.equal(report.externalProviderRequests,0);
 });
 await test('malformed unused external settings do not disable application MCP or contact the provider',async()=>{
  await start({MCP_ACCESS_ISSUER:'https://invalid-unused.example.invalid'},false);await connect({},appToken);
  assert.equal((await success('identity_current')).principal.id,'API_A');assert.equal(report.externalProviderRequests,0);
  const rejected=await request('/mcp/federated',{method:'POST',headers:{'Cf-Access-Jwt-Assertion':'invalid'}});
  assert.equal(rejected.status,503);assert.equal((await rejected.json()).error,'federation_misconfigured');assert.equal(report.externalProviderRequests,0);
  await start({},false);await connect({},appToken);
 });
 await test('same public domain preparation and recovery work through application-authenticated MCP',async()=>{
  const prepared=await success('issue_create_prepare',{projectId:'P',input:{operationId:'api-prepared',body:'API-only retained original'}});
  assert.equal(prepared.recorded,true);assert.equal(await db.prepare('SELECT count(*) FROM issues').first('count(*)'),0);
  const saved=await success('operation_get',{operationId:'api-prepared'});assert.equal(saved.input.body,'API-only retained original');
  await start({},false);await connect({},appToken);
  assert((await success('operation_list')).operations.some(x=>x.operationId==='api-prepared'));
  const applied=await success('operation_execute',{operationId:'api-prepared'});assert.equal(applied.source,'committed');
  assert.equal((await success('issue_get',{projectId:'P',issueId:applied.snapshot.id})).issue.body,'API-only retained original');
  assert.equal((await success('operation_execute',{operationId:'api-prepared'})).source,'recovered');
  assert.equal(await db.prepare("SELECT count(*) FROM issue_history WHERE operation_id='api-prepared'").first('count(*)'),1);
 });
 // App credential authentication itself rejects non-Agent principals before the MCP actor check.
 await test('human, cookie, mixed and unsupported credentials cannot enter Agent MCP',async()=>{
  for(const [headers,status] of [
   [{Authorization:'Bearer '+humanToken},401],
   [{Cookie:'__Host-projektor_session='+'s'.repeat(43)},400],
   [{Authorization:'Bearer '+appToken,Cookie:'__Host-projektor_session='+'s'.repeat(43)},400],
   [{'Cf-Access-Jwt-Assertion':token},401],
   [{Authorization:'Bearer invalid'},401],
  ]){const response=await request('/mcp',{method:'POST',headers});assert.equal(response.status,status);assert(!JSON.stringify(await response.json()).includes(appToken));}
  await connect({'Cf-Access-Jwt-Assertion':token},appToken);assert.equal((await success('identity_current')).principal.id,'API_A');
  const malformed=await request('/mcp',{method:'POST',headers:{Authorization:'Bearer malformed','Cf-Access-Jwt-Assertion':token}});assert.equal(malformed.status,401);
  assert.equal(report.externalProviderRequests,0);
 });
 await test('credential revoked inside callback returns application401 with no refresh challenge, fallback or retry',async()=>{
  await connect({'X-Test-Race':'revoke-api'},appToken);
  const before=wireRequests,count=await db.prepare('SELECT count(*) FROM operation_intents').first('count(*)');
  const rejected=await call('issue_create',{projectId:'P',input:{operationId:'api-revoked-callback',body:'must not dispatch'}});
  assert.equal(rejected.isError,true);assert.equal(rejected.structuredContent.status,401);assert.equal(rejected.structuredContent.error,'unauthenticated');
  assert.equal(rejected._meta?.['mcp/www_authenticate'],undefined);assert.equal(wireRequests,before+1);
  assert.equal(await db.prepare('SELECT count(*) FROM operation_intents').first('count(*)'),count);
  assert(!JSON.stringify(rejected).includes(appToken));assert.equal(report.externalProviderRequests,0);
 });
 await test('optional federation never changes an app-credential failure into OAuth refresh',async()=>{
  await start();
  const rejected=await request('/mcp',{method:'POST',headers:{Authorization:'Bearer '+appToken}});assert.equal(rejected.status,401);
  assert.equal(rejected.headers.get('WWW-Authenticate'),'Bearer realm="Projektor"');
  assert.equal(report.externalProviderRequests,0);
  await db.prepare("UPDATE api_credentials SET revoked_at=NULL WHERE id='api-key'").run();await connect({},appToken);
  await client.listTools();assert.equal((await success('identity_current')).authentication,'api');assert.equal(report.externalProviderRequests,0);
  for(const headers of [{Authorization:'Bearer '+appToken},{Authorization:'Bearer '+appToken,'Cf-Access-Jwt-Assertion':token}]){
   assert.equal((await request('/mcp/federated',{method:'POST',headers})).status,400);
  }
  assert.equal((await request('/mcp/federated',{method:'POST',headers:{Authorization:'Bearer opaque-edge-metadata'}})).status,401);
  await db.prepare("INSERT INTO principals VALUES('FED_B','agent','Separate Federated Agent',NULL,1,1)").run();
  await db.prepare('INSERT INTO federated_bindings VALUES(?,?,?,?,?,unixepoch())').bind('api-mode-other-binding','FED_B',issuer,aud,subject).run();
  await db.prepare("INSERT INTO federated_credentials(id,binding_id,principal_auth_version,created_at,expires_at) VALUES('api-mode-other-credential','api-mode-other-binding',1,unixepoch(),unixepoch()+3600)").run();
  await connect({Authorization:'Bearer opaque-edge-metadata'});assert.equal((await success('identity_current')).principal.id,'FED_B');
  const providerReads=report.externalProviderRequests;assert(providerReads>0);
  await connect({'Cf-Access-Jwt-Assertion':token},appToken);assert.equal((await success('identity_current')).principal.id,'API_A');await client.listTools();
  assert.equal(report.externalProviderRequests,providerReads);
 });
}
try {
 const bundle=await build({metafile:true,entryPoints:['tests/support/mcp-transport-fixture.ts'],outfile:root+'/worker.mjs',bundle:true,format:'esm',platform:'neutral',conditions:['workerd','worker','browser'],mainFields:['module','main'],external:['node:*','cloudflare:*'],plugins:[{name:'wasm',setup(b){b.onResolve({filter:/\.wasm$/},a=>({path:'./'+basename(a.path),external:true}));}}]});
 report.sourceHashes=Object.fromEntries(await Promise.all(Object.keys(bundle.metafile.inputs).filter(f=>!f.includes('node_modules')).map(async f=>[f,createHash('sha256').update(await readFile(f)).digest('hex')])));
 report.bundleSha256=createHash('sha256').update(await readFile(root+'/worker.mjs')).digest('hex');
 fixture=await prepareLocalD1(root);
 if(mode==='api-only'){await runApplicationCredentialChecks();}else{
 await start({MCP_ENABLED:'false'});await verifyCanonicalLedger(db);
 await test('disabled and all reserved paths avoid SPA fallback',async()=>{for(const path of ['/mcp','/mcp/extra','/.well-known/cloudflare-access-protected-resource/','/.well-known/unknown'])assert.equal((await request(path)).status,404);assert.equal(await (await request('/ordinary')).text(),'SPA fallback');});
 await start();
 await test('unauthenticated requests give a metadata challenge and no HTML/cookie/API fallback',async()=>{for(const [headers,status] of [[{},401],[{Cookie:'__Host-projektor_session='+'a'.repeat(43)},400],[{Authorization:'Bearer '+'a'.repeat(43)},400]]){const r=await request('/mcp/federated',{method:'POST',headers});assert.equal(r.status,status,await r.text());if(status===401)assert.equal(r.headers.get('WWW-Authenticate'),'Bearer resource_metadata="'+origin+'/.well-known/cloudflare-access-protected-resource/"');}});
 await test('valid unbound assertion cannot initialize',async()=>{assert.equal((await request('/mcp/federated',{method:'POST',headers:{'Cf-Access-Jwt-Assertion':token}})).status,403);});
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
 await test('origin host query and non-POST contract are enforced',async()=>{const headers={'Cf-Access-Jwt-Assertion':token};for(const extra of [{Origin:'https://wrong.invalid'},{'X-Test-Host':'wrong.invalid'}])assert.equal((await request('/mcp/federated',{method:'POST',headers:{...headers,...extra}})).status,403);assert.equal((await request('/mcp/federated?access_token=x',{method:'POST',headers})).status,400);for(const method of ['GET','DELETE'])assert.equal((await request('/mcp/federated',{method,headers})).status,405);assert.equal((await request('/mcp/extra',{headers})).status,404);});
 await test('official initialize notification list and closure-bound identity succeed statelessly',async()=>{await connect();const listed=await client.listTools();assert.equal(listed.tools.length,29);assert(!listed.tools.some(t=>preparedMutations.has(t.name)));assert(wireCatalogues>0);for(const t of listed.tools){assert.equal(t.inputSchema.additionalProperties,false,t.name);assert(t.outputSchema,t.name);assert.deepEqual(t._meta.securitySchemes,[{type:'oauth2',scopes:[]}]);for(const k of ['readOnlyHint','destructiveHint','idempotentHint','openWorldHint'])assert.equal(typeof t.annotations[k],'boolean');}assert(!listed.tools.some(t=>/credential|browser|admin|http|shell/.test(t.name)));const me=await success('identity_current');assert.equal(me.principal.id,'A');assert.equal(me.authentication,'federated');assert.deepEqual(me.projects,[{id:'P',permissions:['assign','edit','execute','transition','view']}]);const directory=await success('directory_get');assert.deepEqual(directory.projects.map(p=>p.id),['P']);assert.deepEqual(directory.workspaces,[]);assert.deepEqual(directory.definitions.map(d=>d.record.name),['Shared definition']);const source=await success('source_get',{scopeId:'P',kind:'projects',id:'P',page:2});assert.equal(source.historyTotal,12);assert.equal(source.history.length,2);assert.equal((await success('legacy_resolve',{path:'/projects/view/project-p'})).id,'P');});
 await test('oversized body and unknown authority fields never dispatch',async()=>{const r=await request('/mcp/federated',{method:'POST',headers:{'Cf-Access-Jwt-Assertion':token,Accept:'application/json, text/event-stream','Content-Type':'application/json'},body:'x'.repeat(96*1024+1)});assert.equal(r.status,413);const bad=await call('issue_create',{projectId:'P',actor:'OWNER',input:{operationId:'bad',body:'injected'}});assert.equal(bad.isError,true);assert.equal(await db.prepare('SELECT count(*) FROM issues').first('count(*)'),0);});
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
  const page=await success('operation_list'),saved=page.operations.find(o=>o.operationId==='lost-prepare');assert(saved);assert.equal(saved.input,undefined);assert.equal(saved.result.snapshot,undefined);assert.equal(saved.result.status,'unknown');
  const recovered=await success('operation_get',{operationId:'lost-prepare'});assert.equal(recovered.recorded,true);assert.equal(recovered.input.body,'Durable retained input');assert.equal(recovered.inputHash,saved.inputHash);
  // A later same-ID preparation remains preparation only, including after a lost response.
  await success('issue_create_prepare',{projectId:'P',input:{operationId:'lost-prepare',body:'Durable retained input'}});
  assert.equal(await db.prepare('SELECT count(*) FROM issues').first('count(*)'),beforeIssues);assert.equal(await db.prepare('SELECT count(*) FROM operation_results').first('count(*)'),beforeResults);
  const executed=await success('operation_execute',{operationId:'lost-prepare'});assert.equal(executed.source,'committed');
  await start();await connect();const original=await success('operation_result',{scopeId:'P',operationId:'lost-prepare',resource:{kind:'issue'}});assert.equal(original.snapshot.id,executed.snapshot.id);
  assert.equal((await success('operation_get',{operationId:'lost-prepare'})).result.status,'confirmed');assert.equal((await success('operation_execute',{operationId:'lost-prepare'})).source,'recovered');
  for(const table of ['issues','issue_history','operation_results']){const column=table==='issues'?'id':table==='issue_history'?'issue_id':'operation_id',value=table==='operation_results'?'lost-prepare':executed.snapshot.id;assert.equal(await db.prepare(`SELECT count(*) FROM ${table} WHERE ${column}=?`).bind(value).first('count(*)'),1);}
 });
 await success('issue_update',{projectId:'P',issueId:id,input:{operationId:'assign',revision:1,assigneeId:'A'}});
 await test('official client completes assigned execution while issue resolution stays separate',async()=>{const acquired=await success('execution_change',{projectId:'P',issueId:id,input:{action:'acquire',operationId:'acquire'}}),attemptId=acquired.snapshot.attemptId;await success('execution_current',{projectId:'P',issueId:id});await success('execution_report',{projectId:'P',issueId:id,input:{action:'progress',operationId:'progress',attemptId,leaseVersion:acquired.snapshot.leaseVersion,message:'Working'}});await success('execution_report',{projectId:'P',issueId:id,input:{action:'completed',operationId:'completed',attemptId,leaseVersion:acquired.snapshot.leaseVersion,message:'Done'}});await success('execution_reports',{projectId:'P',issueId:id});await success('execution_report_history',{projectId:'P',issueId:id});assert.equal((await success('issue_get',{projectId:'P',issueId:id})).issue.state,'Backlog');await success('issue_update',{projectId:'P',issueId:id,input:{operationId:'resolve',revision:2,state:'Done'}});await success('issue_history',{projectId:'P',issueId:id});await success('assignee_list',{projectId:'P'});});
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
 await test('operation discovery is bounded summaries while get retains full wiki input',async()=>{
  const body='Retained wiki input '.repeat(1600);
  for(let n=0;n<3;n++)await success('wiki_create_prepare',{scopeId:'P',input:{operationId:'large-wiki-'+n,body}});
  const page=await success('operation_list',{limit:2});assert.equal(page.operations.length,2);assert.notEqual(page.nextAfter,null);
  for(const saved of page.operations){assert.equal(saved.input,undefined);assert.equal(saved.route,undefined);assert.equal(saved.result.snapshot,undefined);}
  assert(JSON.stringify(page).length<2048);
  const full=await success('operation_get',{operationId:'large-wiki-2'});assert.equal(full.input.body,body);assert.equal(full.result.status,'unknown');
  const tail=await success('operation_list',{after:full.sequence-1,limit:50});assert.equal(tail.operations.length,1);assert.equal(tail.operations[0].operationId,full.operationId);assert.equal(tail.nextAfter,null);assert(JSON.stringify(tail).length<1024);
 });
 await test('retained known-shape future versions remain discoverable but cannot execute',async()=>{
  await db.prepare(`INSERT INTO operation_intents(principal_id,operation_id,format_version,operation_kind,target_id,project_id,route_json,input_json,input_hash,required_permissions,prepared_at)
    SELECT principal_id,'future-format',2,operation_kind,target_id,project_id,route_json,json_set(input_json,'$.operationId','future-format'),input_hash,required_permissions,prepared_at
    FROM operation_intents WHERE operation_id='large-wiki-2' AND principal_id='A'`).run();
  const full=await success('operation_get',{operationId:'future-format'});assert.equal(full.formatVersion,2);assert.equal(full.input.body,'Retained wiki input '.repeat(1600));
  const page=await success('operation_list',{after:full.sequence-1});assert.equal(page.operations[0].formatVersion,2);assert.equal(page.operations[0].input,undefined);
  const before=await db.prepare('SELECT count(*) FROM operation_results').first('count(*)');
  const denied=await call('operation_execute',{operationId:'future-format'});assert.equal(denied.isError,true);assert.equal(denied.structuredContent.status,409);assert.equal(denied.structuredContent.error,'operation_format_unsupported');
  assert.equal(await db.prepare('SELECT count(*) FROM operation_results').first('count(*)'),before);
 });
 await test('retained unversioned reports stay readable but only confirmed results can recover',async()=>{
  const source=await db.prepare("SELECT snapshot,target_id FROM operation_results WHERE principal_id='A' AND operation_id='progress'").first(),snapshot=JSON.parse(source.snapshot);
  for(const confirmed of [false,true]){
   const operationId='old-report-'+(confirmed?'confirmed':'pending'),input={attemptId:snapshot.attemptId,message:snapshot.message,operationId,references:[]},inputJson=JSON.stringify(input),inputHash=createHash('sha256').update(inputJson).digest('hex');
   await db.prepare(`INSERT INTO operation_intents(principal_id,operation_id,format_version,operation_kind,target_id,project_id,route_json,input_json,input_hash,required_permissions,prepared_at)
    VALUES('A',?,1,'execution-report.progress',?,'P',?,?,?,'["execute","view"]',unixepoch())`).bind(operationId,source.target_id,JSON.stringify({kind:'report',projectId:'P',issueId:source.target_id,action:'progress'}),inputJson,inputHash).run();
   if(confirmed)await db.prepare(`INSERT INTO operation_results(principal_id,operation_id,operation_kind,target_id,project_id,input_hash,required_permissions,state,snapshot,created_at,confirmed_at,authority_kind)
    VALUES('A',?,'execution-report.progress',?,'P',?,'["execute","view"]','confirmed',?,unixepoch(),unixepoch(),'project')`).bind(operationId,source.target_id,inputHash,JSON.stringify({...snapshot,operationId})).run();
   const full=await success('operation_get',{operationId});assert.deepEqual(full.input,input);assert.equal(full.result.status,confirmed?'confirmed':'unknown');
   assert((await success('operation_list',{after:full.sequence-1})).operations.some(x=>x.operationId===operationId));
   const before=await db.prepare('SELECT count(*) FROM operation_results').first('count(*)'),reports=await db.prepare('SELECT count(*) FROM issue_execution_reports').first('count(*)');
   if(confirmed){const receipt=await success('operation_execute',{operationId});assert.equal(receipt.source,'recovered');assert.deepEqual(receipt.snapshot,{...snapshot,operationId});const direct=await success('operation_result',{scopeId:'P',operationId,resource:{kind:'report'}});assert.deepEqual(direct.snapshot,receipt.snapshot);}
   else {const rejected=await call('operation_execute',{operationId});assert.equal(rejected.isError,true);assert.equal(rejected.structuredContent.status,400);}
   assert.equal(await db.prepare('SELECT count(*) FROM operation_results').first('count(*)'),before);assert.equal(await db.prepare('SELECT count(*) FROM issue_execution_reports').first('count(*)'),reports);
   const denied=await call('execution_report_prepare',{projectId:'P',issueId:source.target_id,input:{action:'progress',...input,operationId:'new-'+operationId}});assert.equal(denied.isError,true);
  }
 });
 await test('grant ceiling cannot read workspace or other project and importing blocks business reads',async()=>{for(const scopeId of ['OTHER','workspace:OTHER'])assert.equal((await call('wiki_list',{scopeId})).isError,true);await db.prepare("UPDATE write_gate SET mode='importing' WHERE id=1").run();const r=await call('issue_list',{projectId:'P'});assert.equal(r.isError,true);assert.equal(r.structuredContent.error,'import_in_progress');assert.equal((await success('identity_current')).principal.id,'A');});
 await db.prepare("UPDATE write_gate SET mode='open' WHERE id=1").run();
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
 }
 report.passed=true;
}catch(error){report.passed=false;report.failure=String(error);throw error;}
finally{if(client)await client.close();if(mf)await mf.dispose();await rm(root,{recursive:true,force:true});await writeFile(mode==='api-only'?'.local/evidence/mcp-api-only-check.json':'.local/evidence/mcp-transport-check.json',JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify(report));
