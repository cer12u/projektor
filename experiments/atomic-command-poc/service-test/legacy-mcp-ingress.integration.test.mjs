import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import { Miniflare, createFetchMock } from 'miniflare';
import { LEGACY_API_TOKEN_MODE } from '../service/legacy-bearer.mjs';

// Actual public ingress and actual D1/DO bindings. No fixture actor/RPC entrypoint,
// adapter mock, signed-context header, provider network or real credential.
test('old MCP URL crosses D1 authentication, current Store and legacy core facade', async t => {
 const ids=Object.fromEntries(['workspace','epoch','principal','credential','project'].map(key=>[key,randomUUID()]));
 const origin='https://legacy-mcp-ingress.invalid',token='pk_'+randomUUID();
 const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 const jwk={...publicKey.export({format:'jwk'}),kid:'synthetic-perimeter',alg:'RS256',use:'sig'};
 const mock=createFetchMock();mock.disableNetConnect();
 mock.get('https://unused-provider.invalid').intercept({path:'/certs'}).reply(200,JSON.stringify({keys:[jwk]}),{headers:{'content-type':'application/json'}}).persist();
 const mf=new Miniflare({cf:false,fetchMock:mock,name:'legacy-mcp-ingress',unsafeInspectDurableObjects:true,modules:true,
  scriptPath:new URL('../service/entry.mjs',import.meta.url).pathname,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],
  modulesRules:[{type:'Text',include:['**/*.sql'],fallthrough:true}],d1Databases:['DB'],
  bindings:{APP_ORIGIN:origin,WORKSPACE_IDS:JSON.stringify([ids.workspace]),REQUEST_TIMEOUT_MS:'5000',BODY_TIMEOUT_MS:'1000',
   PROVIDER_CONFIG:JSON.stringify({issuer:'https://unused-provider.invalid',jwksUrl:'https://unused-provider.invalid/certs',humanAudience:'existing-human',machineAudience:null}),
   LEGACY_API_TOKEN_AUTH:LEGACY_API_TOKEN_MODE,MCP_RATE_LIMIT_CONFIG:JSON.stringify({workspaceBurst:128,workspacePerSecond:50,identityBurst:100,identityPerSecond:25})},
  durableObjects:{WORKSPACE:{className:'WorkspaceService',useSQLite:true}}});
 try{
  await mf.ready;
  const source=await mf.getD1Database('DB');
  await source.exec('CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE workspace_members(workspace_id TEXT,user_id TEXT,role TEXT); CREATE TABLE api_tokens(id TEXT PRIMARY KEY,workspace_id TEXT,user_id TEXT,issued_by_user_id TEXT,token_hash TEXT,scopes TEXT,expires_at INTEGER,last_used_at INTEGER); CREATE TABLE issues(id TEXT PRIMARY KEY,title TEXT);');
  const sourceSQL=(q,...a)=>source.prepare(q).bind(...a).run();
  const tokenHash=createHash('sha256').update(token).digest('hex');
  await sourceSQL('INSERT INTO users VALUES(?)',ids.principal);
  await sourceSQL("INSERT INTO workspace_members VALUES(?,?,'owner')",ids.workspace,ids.principal);
  const insertToken=()=>sourceSQL("INSERT INTO api_tokens VALUES(?,?,?,NULL,?,'[read,write]',NULL,NULL)",ids.credential,ids.workspace,ids.principal,tokenHash);
  await insertToken();await sourceSQL("INSERT INTO issues VALUES(?,'Untouched source domain row')",randomUUID());
  const db=await mf.unsafeGetDurableObjectStorage('legacy-mcp-ingress','WorkspaceService',{name:ids.workspace});
  await db.exec('INSERT INTO workspace VALUES(?,?,1,0)',ids.workspace,ids.epoch);
  await db.exec("INSERT INTO membership VALUES(?,'human',0,1)",ids.principal);
  await db.exec('INSERT INTO credential VALUES(?,?,?,0,1,1)',ids.credential,ids.principal,Date.now()+3600000);
  await db.exec("INSERT INTO project VALUES(?,'Legacy core project',1,0)",ids.project);
  await db.exec("INSERT INTO project_url VALUES(?,'LEG','legacy-core',NULL)",ids.project);
  await db.exec('INSERT INTO project_grant VALUES(?,?,1,1)',ids.principal,ids.project);
  await db.exec('INSERT INTO shared_grant VALUES(?,1,1)',ids.principal);
  for(const scope of ['operations:read_own','issue:read','issue:write','comment:write','wiki:read','wiki:write','history:read']){
   await db.exec('INSERT INTO principal_scope VALUES(?,?)',ids.principal,scope);
   await db.exec('INSERT INTO credential_scope VALUES(?,?)',ids.credential,scope);
  }
  const headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
  const url=origin+'/mcp/'+ids.workspace;
  const request=(rpc,query='')=>mf.dispatchFetch(url+query,{method:'POST',headers,body:JSON.stringify(rpc)});
  const rpc=(name,args,id=7)=>({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}});
  const call=async(name,args,id=7)=>{
   const response=await request(rpc(name,args,id));assert.equal(response.status,200,await response.clone().text());
   const body=await response.json();assert.equal(body.jsonrpc,'2.0');assert.equal(body.id,id);assert.ok(body.result?.content?.[0]?.text,JSON.stringify(body));
   return {result:JSON.parse(body.result.content[0].text),isError:body.result.isError===true};
  };
  const success=async(name,args,id=7)=>{const result=await call(name,args,id);assert.equal(result.isError,false,JSON.stringify(result.result));return result.result;};
  const sourceSnapshot=async()=>({users:(await source.prepare('SELECT * FROM users ORDER BY id').all()).results,
   members:(await source.prepare('SELECT * FROM workspace_members ORDER BY user_id').all()).results,
   tokens:(await source.prepare('SELECT id,workspace_id,user_id,issued_by_user_id,scopes,expires_at,last_used_at FROM api_tokens ORDER BY id').all()).results,
   issues:(await source.prepare('SELECT * FROM issues ORDER BY id').all()).results});
  const authority=async()=>(await db.exec('SELECT (SELECT count(*) FROM membership) AS membership,(SELECT count(*) FROM credential) AS credential,(SELECT count(*) FROM identity_binding) AS binding'))[0];
  const effects=async()=>(await db.exec('SELECT (SELECT change_seq FROM workspace) AS seq,(SELECT count(*) FROM operation) AS operations,(SELECT count(*) FROM content_revision) AS revisions,(SELECT count(*) FROM issue_entry) AS entries'))[0];
  const sourceBefore=await sourceSnapshot();let issueId,commentId,wikiId;
  await t.test('stateless discovery preserves old path, domains and serialized text results',async()=>{
   const response=await request({jsonrpc:'2.0',id:1,method:'initialize'});assert.equal(response.status,200);
   assert.equal(response.headers.get('mcp-session-id'),null);assert.equal((await response.json()).result.protocolVersion,'2025-11-25');
   for(const [domains,names] of [['comments',['list_comments','add_comment','update_comment']],['issues,wiki',['get_issue','create_issue','get_wiki_page','create_wiki_page']]]){
    const listed=await(await request({jsonrpc:'2.0',id:1,method:'tools/list'},'?domains='+domains)).json();
    for(const name of names)assert.ok(listed.result.tools.some(tool=>tool.name===name));
    if(domains==='comments')assert.deepEqual(listed.result.tools.map(tool=>tool.name),names);
    else assert.ok(!listed.result.tools.some(tool=>tool.name==='add_comment'));
   }
  });
  await t.test('signed service perimeter and D1 bearer are independently required',async()=>{
   const now=Math.floor(Date.now()/1000),encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
   const jwt=(claims,kid=jwk.kid)=>{const input=encode({alg:'RS256',kid,typ:'JWT'})+'.'+encode(claims);return input+'.'+sign('RSA-SHA256',Buffer.from(input),privateKey).toString('base64url');};
   const claims={iss:'https://unused-provider.invalid',aud:['existing-human'],type:'app',sub:'',common_name:'synthetic-perimeter.access',iat:now-5,exp:now+300};
   const send=(bearer,assertion)=>mf.dispatchFetch(url,{method:'POST',headers:{...headers,authorization:'Bearer '+bearer,'cf-access-jwt-assertion':assertion},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
   const valid=await send(token,jwt(claims));assert.equal(valid.status,200,await valid.clone().text());assert.ok((await valid.json()).result.tools.length);
   const invalid=await send('pk_invalid-synthetic',jwt(claims));assert.equal(invalid.status,401);assert.equal((await invalid.json()).error.data.code,'UNAUTHENTICATED');
   const noCommonName={...claims};delete noCommonName.common_name;
   for(const bad of [{...claims,sub:'human',email:'synthetic@example.invalid'},{...claims,email:'synthetic@example.invalid'},{...claims,iss:'https://wrong-provider.invalid'},{...claims,aud:['wrong-audience']},{...claims,type:'org'},{...claims,sub:'not-empty'},{...claims,common_name:''},noCommonName,{...claims,exp:now-1}])assert.equal((await send(token,jwt(bad))).status,401);
   // An unsigned/syntactically plausible value that the prior hint classifier
   // accepted must now fail cryptographic verification before Store dispatch.
   const unsigned=jwt(claims).split('.').slice(0,2).join('.')+'.'+Buffer.alloc(256).toString('base64url');
   for(const bad of [unsigned,jwt(claims,'unknown-kid'),'malformed'])assert.equal((await send(token,bad)).status,401);
   // Verifying the existing-app perimeter must not enable standalone machine
   // Access authentication when machineAudience remains explicitly null.
   const standalone=await mf.dispatchFetch(`${origin}/machine/v1/workspaces/${ids.workspace}/projects?workspaceEpoch=${ids.epoch}`,{headers:{authorization:'Bearer '+jwt(claims)}});
   assert.equal(standalone.status,401);
   assert.deepEqual(await sourceSnapshot(),sourceBefore);assert.deepEqual(await authority(),{membership:1,credential:1,binding:0});
  });
  await t.test('Issue create/read/multi-field LWW update uses existing principal and core effects',async()=>{
   const created=await success('create_issue',{projectId:'LEG',title:'Original issue',body:'Raw\r\nbody 日本語',priority:'medium',status:'todo'});
   assert.deepEqual(Object.keys(created).sort(),['id','number']);assert.equal(created.number,1);issueId=created.id;
   let read=await success('get_issue',{ref:'LEG-1'});assert.equal(read.id,issueId);assert.equal(read.body,'Raw\r\nbody 日本語');assert.equal(read.status,'todo');
   assert.deepEqual(await success('update_issue',{id:'LEG-1',title:'LWW title',body:'Updated\r\nbody',priority:'urgent'}),{ok:true});
   read=await success('get_issue',{id:issueId});assert.equal(read.title,'LWW title');assert.equal(read.body,'Updated\r\nbody');assert.equal(read.priority,'urgent');
   const listed=await success('list_issues',{projectId:'LEG',includeBody:true});assert.equal(listed.items[0].id,issueId);
   assert.deepEqual((await db.exec('SELECT DISTINCT principal_id FROM operation')).map(row=>row.principal_id),[ids.principal]);
  });
  await t.test('omitted create status uses the preserved authoritative task-status default',async()=>{
   for(const [index,key] of ['backlog','todo','in_progress'].entries()){
    const id=randomUUID(),raw={id,workspace_id:ids.workspace,key,category:key==='in_progress'?'in_progress':'todo',is_default:Number(key==='todo'),is_review_step:0};
    await db.exec('INSERT INTO issue_compat_status VALUES(?,?,?,?,0,?)',id,key,key,key==='todo'?'ready':key,index);
    await db.exec('INSERT INTO source_mapping VALUES(?,?,?,?,?,?,?,?)',randomUUID(),'legacy-projektor','legacy_archive',id,JSON.stringify(['task_statuses','a'.repeat(64)]),'legacy_archive',id,JSON.stringify(raw));
   }
   const created=await success('create_issue',{projectId:'LEG',title:'Uses preserved todo default'});
   assert.equal((await success('get_issue',{id:created.id})).status,'todo');
   assert.equal((await db.exec('SELECT status_category FROM issue_queue WHERE issue_id=?',created.id))[0].status_category,'ready');
  });
  await t.test('comment add/read/edit retains old envelopes and reused RPC IDs remain distinct operations',async()=>{
   const first=await success('add_comment',{issueId:'LEG-1',body:'First comment'},22);commentId=first.id;
   const second=await success('add_comment',{issueId:issueId,body:'First comment'},22);assert.notEqual(second.id,commentId);
   assert.deepEqual(await success('update_comment',{issueId:issueId,commentId,body:'Edited\r\ncomment'}),{ok:true});
   const listed=await success('list_comments',{issueId:'LEG-1'});assert.equal(listed.items.length,2);
   assert.equal(listed.items.find(row=>row.id===commentId).body,'Edited\r\ncomment');
   assert.equal(listed.items.find(row=>row.id===commentId).author_id,ids.principal);
  });
  await t.test('Wiki create/read/edit/list uses the old result format and original URL aliases',async()=>{
   const created=await success('create_wiki_page',{projectId:'LEG',title:'Legacy page',slug:'legacy-page',content:'# Heading\nExact\r\nWiki source'});wikiId=created.id;
   assert.equal(created.url,'/wiki/legacy-page');assert.equal(created.projectId,ids.project);
   const read=await success('get_wiki_page',{slug:'legacy-page'});assert.equal(read.id,wikiId);assert.equal(read.content,'# Heading\nExact\r\nWiki source');
   assert.deepEqual(await success('update_wiki_page',{id:wikiId,title:'Edited title',newSlug:'renamed-page',content:'Updated Wiki\r\n',baseRevisionId:read.revisionId}),{ok:true,url:'/wiki/renamed-page'});
   assert.equal((await success('get_wiki_page',{slug:'legacy-page'})).content,'Updated Wiki\r\n');
   const listed=await success('list_wiki_pages',{projectId:'LEG'});assert.ok(Array.isArray(listed));assert.equal(listed[0].id,wikiId);
  });
  await t.test('failed later field rolls back the entire old multi-field invocation',async()=>{
   const before=await effects(),failure=await call('update_issue',{id:issueId,title:'Must roll back',assigneeId:randomUUID()});
   assert.equal(failure.isError,true);assert.deepEqual(await effects(),before);
   assert.equal((await success('get_issue',{id:issueId})).title,'LWW title');
  });
  await t.test('live downscope, source revocation and Store fencing fail closed',async()=>{
   await sourceSQL("UPDATE api_tokens SET scopes='[read]' WHERE id=?",ids.credential);const readOnlySource=await sourceSnapshot(),before=await effects();
   assert.equal((await success('get_issue',{id:issueId})).id,issueId);
   const write=await call('add_comment',{issueId,body:'Denied after downgrade'});assert.equal(write.isError,true);assert.equal(write.result.error.code,'FORBIDDEN');
   assert.deepEqual(await effects(),before);assert.deepEqual(await sourceSnapshot(),readOnlySource);
   await sourceSQL('DELETE FROM api_tokens WHERE id=?',ids.credential);const revoked=await request(rpc('get_issue',{id:issueId}));assert.equal(revoked.status,401);
   await insertToken();await db.exec('UPDATE workspace SET active=0');
   const fenced=await request(rpc('add_comment',{issueId,body:'Denied while frozen'}));assert.equal(fenced.status,503);assert.equal((await fenced.json()).error.data.code,'STORE_FENCED');
   assert.deepEqual(await effects(),before);await db.exec('UPDATE workspace SET active=1');
  });
  await t.test('native command API still requires caller CAS and operation identity',async()=>{
   const native={schemaVersion:1,workspaceId:ids.workspace,workspaceEpoch:ids.epoch,operationId:randomUUID(),commandType:'Issue.UpdateTitle',entityId:issueId,payload:{title:'No implicit native CAS'}};
   const postNative=command=>mf.dispatchFetch(`${origin}/machine/v1/workspaces/${ids.workspace}/commands`,{method:'POST',headers:{...headers,'idempotency-key':command.operationId},body:JSON.stringify(command)});
   const missing=await postNative(native);assert.equal(missing.status,428);assert.equal((await missing.json()).error.code,'PRECONDITION_REQUIRED');
   const stale=await postNative({...native,expectedVersion:1});assert.equal(stale.status,409);assert.equal((await stale.json()).error.code,'VERSION_CONFLICT');
   assert.equal((await success('get_issue',{id:issueId})).title,'LWW title');
   assert.deepEqual(await sourceSnapshot(),sourceBefore);assert.deepEqual(await authority(),{membership:1,credential:1,binding:0});
  });
 }finally{await mf.dispose();}
});

// Regression: independent per-route limiters previously allowed one native plus
// one legacy call against a burst of one. Both requests must spend the same budget.
test('native and old MCP URLs share one actual workspace/identity admission budget',async()=>{
 const ids=Object.fromEntries(['workspace','epoch','principal','credential'].map(key=>[key,randomUUID()]));
 const origin='https://legacy-shared-budget.invalid',token='pk_'+randomUUID();
 const mock=createFetchMock();mock.disableNetConnect();
 const mf=new Miniflare({cf:false,fetchMock:mock,name:'legacy-shared-budget',unsafeInspectDurableObjects:true,modules:true,
  scriptPath:new URL('../service/entry.mjs',import.meta.url).pathname,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],
  modulesRules:[{type:'Text',include:['**/*.sql'],fallthrough:true}],d1Databases:['DB'],
  bindings:{APP_ORIGIN:origin,WORKSPACE_IDS:JSON.stringify([ids.workspace]),REQUEST_TIMEOUT_MS:'5000',BODY_TIMEOUT_MS:'1000',
   PROVIDER_CONFIG:JSON.stringify({issuer:'https://unused-provider.invalid',jwksUrl:'https://unused-provider.invalid/certs',humanAudience:'existing-human',machineAudience:null}),
   LEGACY_API_TOKEN_AUTH:LEGACY_API_TOKEN_MODE,MCP_RATE_LIMIT_CONFIG:JSON.stringify({workspaceBurst:1,workspacePerSecond:1,identityBurst:1,identityPerSecond:1})},
  durableObjects:{WORKSPACE:{className:'WorkspaceService',useSQLite:true}}});
 try{
  await mf.ready;const source=await mf.getD1Database('DB');
  await source.exec('CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE workspace_members(workspace_id TEXT,user_id TEXT,role TEXT); CREATE TABLE api_tokens(id TEXT PRIMARY KEY,workspace_id TEXT,user_id TEXT,issued_by_user_id TEXT,token_hash TEXT,scopes TEXT,expires_at INTEGER);');
  await source.prepare('INSERT INTO users VALUES(?)').bind(ids.principal).run();
  await source.prepare("INSERT INTO workspace_members VALUES(?,?,'owner')").bind(ids.workspace,ids.principal).run();
  await source.prepare("INSERT INTO api_tokens VALUES(?,?,?,NULL,?,'[read]',NULL)").bind(ids.credential,ids.workspace,ids.principal,createHash('sha256').update(token).digest('hex')).run();
  const db=await mf.unsafeGetDurableObjectStorage('legacy-shared-budget','WorkspaceService',{name:ids.workspace});
  await db.exec('INSERT INTO workspace VALUES(?,?,1,0)',ids.workspace,ids.epoch);
  await db.exec("INSERT INTO membership VALUES(?,'human',0,1)",ids.principal);
  await db.exec('INSERT INTO credential VALUES(?,?,?,0,1,0)',ids.credential,ids.principal,Date.now()+3600000);
  const headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
  const native=await mf.dispatchFetch(`${origin}/machine/v1/workspaces/${ids.workspace}/mcp`,{method:'POST',headers:{...headers,accept:'application/json, text/event-stream','mcp-protocol-version':'2026-07-28','mcp-method':'tools/call','mcp-name':'project_list'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'project_list',arguments:{workspaceId:ids.workspace,workspaceEpoch:ids.epoch},_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}}}})});
  assert.equal(native.status,200,await native.clone().text());assert.deepEqual((await native.json()).result.structuredContent.data.items,[]);
  const legacy=await mf.dispatchFetch(`${origin}/mcp/${ids.workspace}`,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'list_issues',arguments:{}}})});
  assert.equal(legacy.status,429,await legacy.clone().text());assert.equal((await legacy.json()).error.data.code,'RATE_LIMITED');assert.ok(Number(legacy.headers.get('retry-after'))>=1);
  assert.equal((await db.exec('SELECT count(*) AS n FROM operation'))[0].n,0);
 }finally{await mf.dispose();}
});
