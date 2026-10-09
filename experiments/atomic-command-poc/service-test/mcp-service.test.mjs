import {readMCPResponse} from './mcp-client-fixture.mjs';
import {test,before,after} from 'node:test';import assert from 'node:assert/strict';import {randomUUID,generateKeyPairSync,sign} from 'node:crypto';import {Miniflare,createFetchMock} from 'miniflare';
const issuer='https://wiki-auth.invalid',origin='https://wiki-product.invalid';const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048}),key={...publicKey.export({format:'jwk'}),kid:'offline-key',alg:'RS256',use:'sig'};
const workspace=randomUUID(),epoch=randomUUID(),project=randomUUID(),badWorkspace=randomUUID();const actors=['human','machine'].map(kind=>({kind,principal:randomUUID(),credential:randomUUID()}));let mf,db;
function jwt(a){const now=Math.floor(Date.now()/1000),claims={iss:issuer,aud:[a.kind==='human'?'human-audience':'machine-audience'],sub:a.kind==='human'?'human-subject':'',...(a.kind==='machine'?{common_name:'machine-subject'}:{}),type:'app',iat:now-2,nbf:now-2,exp:now+3600};const h=Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT',kid:key.kid})).toString('base64url'),p=Buffer.from(JSON.stringify(claims)).toString('base64url');return `${h}.${p}.${sign('RSA-SHA256',Buffer.from(`${h}.${p}`),privateKey).toString('base64url')}`;}
const headers=a=>a.kind==='human'?{'cf-access-jwt-assertion':jwt(a),origin,'x-projektor-csrf':'same-origin'}:{authorization:`Bearer ${jwt(a)}`};
const url=(a,path,w=workspace)=>`${origin}/${a.kind==='machine'?'machine/':''}v1/workspaces/${w}/${path}`;
const command=(id,commandType,payload,expectedVersion)=>({schemaVersion:1,workspaceId:workspace,workspaceEpoch:epoch,operationId:randomUUID(),entityId:id,commandType,payload,expectedVersion});
const post=(a,c)=>mf.dispatchFetch(url(a,'commands'),{method:'POST',headers:{...headers(a),'content-type':'application/json','idempotency-key':c.operationId},body:JSON.stringify(c)});
const read=(a,path,query='')=>mf.dispatchFetch(url(a,path)+`?workspaceEpoch=${epoch}${query}`,{headers:headers(a)});
const mcp=(name,args)=>mf.dispatchFetch(url(actors[1],'mcp'),{method:'POST',headers:{...headers(actors[1]),'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2026-07-28','mcp-method':'tools/call','mcp-name':name,...(args.operationId?{'idempotency-key':args.operationId}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}}}})});
before(async()=>{const mock=createFetchMock();mock.disableNetConnect();mock.get(issuer).intercept({path:'/certs'}).reply(200,JSON.stringify({keys:[key]}),{headers:{'content-type':'application/json'}}).persist();mf=new Miniflare({cf:false,fetchMock:mock,unsafeInspectDurableObjects:true,name:'wiki-product',modules:true,scriptPath:new URL('../service/entry.mjs',import.meta.url).pathname,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],modulesRules:[{type:'Text',include:['**/*.sql'],fallthrough:true}],bindings:{MCP_RATE_LIMIT_CONFIG:JSON.stringify({workspaceBurst:128,workspacePerSecond:50,identityBurst:100,identityPerSecond:25}),APP_ORIGIN:origin,WORKSPACE_IDS:JSON.stringify([workspace,badWorkspace]),REQUEST_TIMEOUT_MS:'5000',BODY_TIMEOUT_MS:'2000',PROVIDER_CONFIG:JSON.stringify({issuer,jwksUrl:issuer+'/certs',humanAudience:'human-audience',machineAudience:'machine-audience',jwksCacheMs:60000,jwksTimeoutMs:500})},durableObjects:{WORKSPACE:{className:'WorkspaceService',useSQLite:true}}});await mf.ready;db=await mf.unsafeGetDurableObjectStorage('wiki-product','WorkspaceService',{name:workspace});await db.exec('INSERT INTO workspace VALUES(?,?,1,0)',workspace,epoch);await db.exec('INSERT INTO project VALUES(?,?,1,0)',project,'Wiki project');for(const a of actors){await db.exec('INSERT INTO membership VALUES(?,?,0,1)',a.principal,a.kind);await db.exec('INSERT INTO credential VALUES(?,?,?,0,1,1)',a.credential,a.principal,Date.now()+3600000);await db.exec('INSERT INTO identity_binding VALUES(?,?,?,?,?)',issuer,a.kind+'-subject',a.credential,a.principal,a.kind);await db.exec('INSERT INTO project_grant VALUES(?,?,1,1)',a.principal,project);await db.exec('INSERT INTO shared_grant VALUES(?,1,1)',a.principal);for(const s of ['operations:read_own','wiki:read','wiki:write','wiki:restore','history:read','deleted:read','issue:read','issue:write','claim:write','progress:write','issue:transition','comment:write']){await db.exec('INSERT INTO principal_scope VALUES(?,?)',a.principal,s);await db.exec('INSERT INTO credential_scope VALUES(?,?)',a.credential,s);}}});
after(async()=>await mf?.dispose());
import {MCP_MODERN,MCP_LEGACY} from '../service/mcp.mjs';
const machine=actors[1];
function rpc(method,params={},id=1){return {jsonrpc:'2.0',id,method,params};}
function modern(method,params={},id=1){return rpc(method,{...params,_meta:{'io.modelcontextprotocol/protocolVersion':MCP_MODERN,'io.modelcontextprotocol/clientCapabilities':{}}},id);}
const send=(message,extra={},method='POST')=>mf.dispatchFetch(url(machine,'mcp'),{method,headers:{...headers(machine),'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':MCP_MODERN,'mcp-method':message?.method??'',...(message?.method==='tools/call'?{'mcp-name':message.params.name}:{}),...extra},...(method==='POST'?{body:typeof message==='string'?message:JSON.stringify(message)}:{})});
async function initialize(){const r=await send(rpc('initialize',{protocolVersion:MCP_LEGACY,capabilities:{},clientInfo:{name:'synthetic-client',version:'1'}}),{'mcp-protocol-version':MCP_LEGACY});assert.equal(r.status,200,await r.clone().text());const sid=r.headers.get('mcp-session-id');const n=await send({jsonrpc:'2.0',method:'notifications/initialized'},{'mcp-protocol-version':MCP_LEGACY,'mcp-session-id':sid});assert.equal(n.status,202);return sid;}
const legacyCall=(sid,name,args,id=1)=>send(rpc('tools/call',{name,arguments:args},id),{'mcp-protocol-version':MCP_LEGACY,'mcp-session-id':sid});
const call=(name,args,id=1)=>send(modern('tools/call',{name,arguments:args},id));
const args=entityId=>({workspaceId:workspace,workspaceEpoch:epoch,...(entityId?{entityId}:{})});
const result=async response=>{assert.equal(response.status,200,await response.clone().text());return (await readMCPResponse(response)).result;};
const count=async table=>(await db.exec(`SELECT count(*) AS n FROM ${table}`))[0].n;
let issue,first,createdCommand,sid;
test('production route implements modern discovery and legacy handshake without enrollment',async()=>{
 const before=await count('membership');const d=await result(await send(modern('server/discover')));assert.deepEqual(d.supportedVersions,[MCP_MODERN,MCP_LEGACY]);assert.equal(d.resultType,'complete');sid=await initialize();const l=await result(await send(rpc('tools/list'),{'mcp-protocol-version':MCP_LEGACY,'mcp-session-id':sid}));assert.ok(l.tools.some(t=>t.name==='capabilities_get'));assert.equal(await count('membership'),before);
});
test('REST, modern and legacy preserve one logical operation and receipt across 100 deliveries',async()=>{
 issue=randomUUID();createdCommand=command(issue,'Issue.Create',{projectId:project,title:'MCP exact',description:'---\r\n日本語\n---',assigneeId:machine.principal,priority:'P1',parentId:null,initialStatus:'ready'},0);
 const before=await count('operation');first=await(await post(machine,createdCommand)).json();assert.equal(first.meta.actorId,machine.principal);
 const replies=await Promise.all(Array.from({length:100},async(_,i)=>result(await(i%2?legacyCall(sid,'issue_create',createdCommand,i+1):call('issue_create',createdCommand,i+1)))));
 for(const r of replies){assert.equal(r.isError,false);assert.deepEqual(r.structuredContent,first);assert.deepEqual(JSON.parse(r.content[0].text),first);}
 assert.equal(await count('operation'),before+1);assert.equal((await db.exec('SELECT count(*) AS n FROM issue WHERE id=?',issue))[0].n,1);
 const receipt=await result(await call('operation_get',{...args(),operationId:createdCommand.operationId}));assert.deepEqual(receipt.structuredContent,first);
 const readMCP=await result(await call('issue_get',args(issue)));assert.deepEqual(readMCP.structuredContent,await(await read(machine,'issues/'+issue)).json());
 const my=await result(await call('my_issues',args()));assert.equal(my.structuredContent.meta.actorId,machine.principal);assert.ok(my.structuredContent.data.items.some(i=>i.id===issue));
});
test('payload changes retain KEY_REUSE, CAS rejects and protocol errors have no effects',async()=>{
 const reused={...createdCommand,payload:{...createdCommand.payload,title:'different'}};assert.equal((await result(await call('issue_create',reused))).structuredContent.error.code,'KEY_REUSE');
 const conflict=command(issue,'Issue.UpdateTitle',{title:'conflict'},9);const c=await result(await call('issue_update_title',conflict));assert.equal(c.isError,true);assert.equal(c.structuredContent.error.code,'VERSION_CONFLICT');
 const before=await count('operation');for(const changed of [{...createdCommand,actor:{principalId:actors[0].principal}},{...createdCommand,operationId:undefined}])assert.equal((await call('issue_create',changed)).status,400);
 const message=modern('tools/call',{name:'issue_create',arguments:createdCommand});assert.equal((await send(message,{'idempotency-key':randomUUID()})).status,400);assert.equal(await count('operation'),before);
});
test('write loss allows read-authorized receipt, all request types enforce current revocation',async()=>{
 await db.exec('UPDATE credential SET can_write=0 WHERE id=?',machine.credential);assert.deepEqual((await result(await call('issue_create',createdCommand))).structuredContent,first);
 await db.exec("DELETE FROM credential_scope WHERE credential_id=? AND scope='history:read'",machine.credential);assert.equal((await result(await call('operation_get',{...args(),operationId:createdCommand.operationId}))).structuredContent.data.operationId,first.data.operationId);
 await db.exec('UPDATE credential SET revoked=1 WHERE id=?',machine.credential);
 for(const msg of [modern('server/discover'),modern('tools/list'),modern('ping'),modern('tools/call',{name:'operation_get',arguments:{...args(),operationId:createdCommand.operationId}})]){const r=await send(msg);assert.equal(r.status,403);const body=await r.json();assert.equal(body.error.data.outcome,'unknown');assert.equal(body.result,undefined);}
 assert.equal((await send(undefined,{},'GET')).status,403);assert.equal((await send(undefined,{'mcp-protocol-version':MCP_LEGACY,'mcp-session-id':sid},'DELETE')).status,403);
 await db.exec('UPDATE credential SET revoked=0,can_write=1 WHERE id=?',machine.credential);await db.exec('INSERT INTO credential_scope VALUES(?,?)',machine.credential,'history:read');
 await db.exec('UPDATE membership SET revoked=1 WHERE principal_id=?',machine.principal);assert.equal((await send(modern('tools/list'))).status,403);await db.exec('UPDATE membership SET revoked=0 WHERE principal_id=?',machine.principal);
 await db.exec('UPDATE credential SET expires_at=0 WHERE id=?',machine.credential);assert.equal((await send(modern('ping'))).status,401);await db.exec('UPDATE credential SET expires_at=? WHERE id=?',Date.now()+3600000,machine.credential);
});
test('restricted resource and read revocation suppress query and receipt details',async()=>{
 await db.exec("UPDATE resource_access SET mode='restricted',reader_principal_ids='[]',writer_principal_ids='[]' WHERE resource_type='issue' AND resource_id=?",issue);
 assert.equal((await result(await call('issue_get',args(issue)))).structuredContent.error.code,'NOT_FOUND');assert.equal((await result(await call('operation_get',{...args(),operationId:createdCommand.operationId}))).structuredContent.error.code,'FORBIDDEN');
 await db.exec("UPDATE resource_access SET mode='inherit' WHERE resource_type='issue' AND resource_id=?",issue);
});
test('eviction loses protocol session only; reinitialize + original operation recovers receipt',async()=>{
 const before=await count('operation');await mf.unsafeEvictDurableObject('wiki-product','WorkspaceService',{name:workspace});assert.equal((await legacyCall(sid,'issue_create',createdCommand)).status,404);sid=await initialize();assert.deepEqual((await result(await legacyCall(sid,'issue_create',createdCommand))).structuredContent,first);assert.equal(await count('operation'),before);
 await db.exec('UPDATE workspace SET epoch=?',randomUUID());assert.equal((await legacyCall(sid,'issue_get',args(issue))).status,404);assert.equal((await result(await call('issue_get',args(issue)))).structuredContent.error.code,'EPOCH_MISMATCH');await db.exec('UPDATE workspace SET epoch=?',epoch);
});
test('machine claim/fencing operation uses same dispatcher and actor; no authority from metadata',async()=>{
 const claim=command(issue,'Issue.Claim',{payloadVersion:1,attemptId:randomUUID(),runtimeInstanceId:randomUUID(),agentDefinition:{id:'synthetic',revision:'1'},expectedClaimVersion:0},1);
 const claimed=await result(await call('issue_claim',claim));assert.equal(claimed.isError,false);const ref=claimed.structuredContent.data.claim;assert.equal(ref.principalId,machine.principal);
 const progress=command(issue,'Issue.AppendProgress',{payloadVersion:2,entryId:randomUUID(),bodyMarkdown:'synthetic checkpoint',claim:{claimId:ref.claimId,fencingToken:ref.fencingToken,runtimeInstanceId:ref.runtimeInstanceId,attemptId:ref.attemptId}},claimed.structuredContent.data.committedVersion);
 const p=await result(await call('issue_append_progress',progress));assert.equal(p.isError,false);assert.equal(p.structuredContent.meta.actorId,machine.principal);
 const replay=await result(await legacyCall(await initialize(),'issue_append_progress',progress));assert.deepEqual(replay.structuredContent,p.structuredContent);
});
test('malformed JSON, duplicate fields, batch, nesting, UTF-8 and body limits reject without effects',async()=>{
 const before=await count('operation');for(const source of ['{','{"jsonrpc":"2.0","jsonrpc":"2.0","id":1,"method":"ping"}','['+JSON.stringify(modern('ping'))+']','{"x":'+ '['.repeat(18)+'0'+']'.repeat(18)+'}'])assert.equal((await send(source)).status,400);
 const invalid=await mf.dispatchFetch(url(machine,'mcp'),{method:'POST',headers:{...headers(machine),'content-type':'application/json',accept:'application/json, text/event-stream'},body:Uint8Array.of(255)});assert.equal(invalid.status,400);
 assert.equal((await send('x'.repeat(2097153))).status,413);assert.equal(await count('operation'),before);
});
test('all MCP methods validate Origin; credential types remain separate and clientInfo grants nothing',async()=>{
 for(const method of ['POST','GET','DELETE'])assert.equal((await send(modern('ping'),{origin:'https://evil.invalid'},method)).status,403);
 assert.equal((await send(modern('ping'),{'cf-access-jwt-assertion':jwt(actors[0])})).status,401);
 const m=modern('tools/call',{name:'issue_get',arguments:args(issue)});m.params._meta['io.modelcontextprotocol/clientInfo']={name:actors[0].principal,version:'owner'};assert.equal((await result(await send(m))).structuredContent.meta.actorId,machine.principal);
});
test('largest control-escaped legal source roundtrips through MCP text and structured output',async()=>{
 const id=randomUUID(),raw='\u0001'.repeat(262144),c=command(id,'Wiki.Create',{pageId:id,scope:{kind:'project',projectId:project},parentId:null,title:'large-mcp',slug:id,contentMarkdown:raw},0);
 assert.equal((await result(await call('wiki_create',c))).isError,false);const r=await call('wiki_get',args(id));assert.equal(r.status,200);const large=(await readMCPResponse(r)).result;assert.equal(large.structuredContent.data.contentMarkdown,raw);assert.equal(JSON.parse(large.content[0].text).data.contentMarkdown,raw);assert.equal((await(await read(machine,'wiki/'+id)).json()).data.contentMarkdown,raw);assert.equal((await result(await call('operation_get',{...args(),operationId:c.operationId}))).isError,false);
});

test('machine capability profile and MCP discovery cover the same command types',async()=>{const cap=(await result(await call('capabilities_get',args()))).structuredContent;let cursor;const found=[];do{const page=await result(await send(modern('tools/list',cursor?{cursor}:{})));found.push(...page.tools);cursor=page.nextCursor;}while(cursor);assert.deepEqual(Object.keys(cap.data.commands).sort(),found.filter(t=>t.inputSchema.properties.commandType).map(t=>t.inputSchema.properties.commandType.const).sort());});
test('incomplete body times out before dispatch and cannot create an operation',async()=>{
 const before=await count('operation');let timer;const stream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));timer=setTimeout(()=>{try{c.close();}catch{}},2600);},cancel(){clearTimeout(timer);}});
 const r=await mf.dispatchFetch(url(machine,'mcp'),{method:'POST',headers:{...headers(machine),'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':MCP_MODERN,'mcp-method':'tools/call'},body:stream,duplex:'half'});assert.equal(r.status,408);const b=await r.json();assert.equal(b.error.data.outcome,'unknown');assert.equal(b.error.data.code,'BODY_TIMEOUT');assert.equal(await count('operation'),before);clearTimeout(timer);
});
test('legal two-record domain page fits modern and legacy without losing content or cursor',async()=>{
 const bodies=['\u0001'.repeat(262144),'\u0001'.repeat(61000)];for(let i=0;i<2;i++){const page=randomUUID(),c=command(page,'Wiki.Create',{pageId:page,scope:{kind:'project',projectId:project},parentId:null,title:'multi-budget-'+i,slug:page,contentMarkdown:bodies[i]},0);assert.equal((await result(await call('wiki_create',c))).isError,false);}
 const query={...args(),search:'multi-budget-'},rest=await(await read(machine,'wiki','&search=multi-budget-')).json();assert.equal(rest.data.items.length,2);const session=sid;
 for(const response of [await call('wiki_list',query),await legacyCall(session,'wiki_list',query)]){const r=await result(response);assert.deepEqual(r.structuredContent,rest);assert.match(r.content[0].text,/duplicate.*omitted/);assert.deepEqual(r.structuredContent.data.items.map(i=>i.contentMarkdown),bodies);}
 const {createMCPQueryPort}=await import('../client/mcp-query-port.mjs');const p=createMCPQueryPort({textOnly:true,callTool:async({name,arguments:a})=>result(await call(name,a))});const first=await p.readPage('wiki_list',query);assert.equal(first.data.items.length,1);assert.ok(first.data.nextCursor);const second=await p.readPage('wiki_list',{...query,cursor:first.data.nextCursor});assert.equal(second.data.items.length,1);assert.deepEqual([...first.data.items,...second.data.items].map(i=>i.contentMarkdown),bodies);
});
test('legal ASCII and worst-JSON-escaped title cursors roundtrip through both protocol schemas',async()=>{
 const {listMCPTools}=await import('../service/mcp-tools.mjs'),max=listMCPTools().find(t=>t.name==='wiki_list').inputSchema.properties.cursor.maxLength;
 for(const control of [false,true]){
  const prefix=control?'cursor-control-':'cursor-ascii-';for(const ch of ['a','b']){const page=randomUUID(),title=prefix+ch+(control?'\u0001':ch).repeat(4096-prefix.length-1),c=command(page,'Wiki.Create',{pageId:page,scope:{kind:'project',projectId:project},parentId:null,title,slug:page,contentMarkdown:'short'},0);assert.equal((await result(await call('wiki_create',c))).isError,false);}
  const q={...args(),search:prefix,limit:1},first=(await result(await call('wiki_list',q))).structuredContent,cursor=first.data.nextCursor;assert.ok(cursor.length>2048);if(control)assert.ok(cursor.length>8192);assert.ok(cursor.length<=max);
  const session=sid;for(const response of [await call('wiki_list',{...q,cursor}),await legacyCall(session,'wiki_list',{...q,cursor})]){const next=(await result(response)).structuredContent;assert.equal(next.data.items.length,1);assert.notEqual(next.data.items[0].id,first.data.items[0].id);}
 }
});
