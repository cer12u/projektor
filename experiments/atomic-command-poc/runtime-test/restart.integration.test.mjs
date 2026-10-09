import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {Miniflare,createFetchMock} from 'miniflare';
import {createMachineTransport,MachineRuntime} from '../client/machine-runtime.mjs';
import {NodeRuntimeJournal} from '../client/node-runtime-journal.mjs';

const scopes=['issue:read','issue:write','operations:read_own','history:read','claim:write'];
const sourceSchema='CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE workspace_members(workspace_id TEXT,user_id TEXT,role TEXT); CREATE TABLE api_tokens(id TEXT PRIMARY KEY,workspace_id TEXT,user_id TEXT,issued_by_user_id TEXT,token_hash TEXT,scopes TEXT,expires_at INTEGER,last_used_at INTEGER);';

test('app-owned auth: real bearer→REST/MCP Store, durable journal and killed-process recovery; no provider/Access dependency',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'projektor-runtime-')),ids=Object.fromEntries(['workspace','epoch','principal','credential','project','issuer'].map(k=>[k,randomUUID()]));
 const syntheticToken='pk_synthetic_'+randomUUID(), origin='https://runtime-fixture.invalid';
 const mock=createFetchMock();mock.disableNetConnect();
 const mf=new Miniflare({cf:false,fetchMock:mock,name:'runtime-proof',unsafeInspectDurableObjects:true,modules:true,scriptPath:new URL('../service/entry.mjs',import.meta.url).pathname,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],modulesRules:[{type:'Text',include:['**/*.sql'],fallthrough:true}],d1Databases:['DB'],bindings:{APP_ORIGIN:origin,WORKSPACE_IDS:JSON.stringify([ids.workspace]),REQUEST_TIMEOUT_MS:'5000',BODY_TIMEOUT_MS:'1000',APP_AUTH_CONFIG:JSON.stringify({version:1,workspaceId:ids.workspace,humanPrincipalId:ids.issuer,authEpoch:randomUUID(),policy:{idleMs:86400000,absoluteMs:7*86400000,rotationIntervalMs:60000,retryGraceMs:10000,maxAttempts:3}}),LEGACY_API_TOKEN_AUTH:'d39852-api-tokens-v1',MCP_RATE_LIMIT_CONFIG:JSON.stringify({workspaceBurst:128,workspacePerSecond:50,identityBurst:100,identityPerSecond:25})},durableObjects:{WORKSPACE:{className:'WorkspaceService',useSQLite:true}}});
 let server,killNext=null,metadata=true,receiptUnavailable=false,expiredSession=false,requests=[];
 try {
  await mf.ready;const source=await mf.getD1Database('DB');await source.exec(sourceSchema);
  const sql=(q,...a)=>source.prepare(q).bind(...a).run();
  await sql('INSERT INTO users VALUES(?)',ids.principal);await sql('INSERT INTO workspace_members VALUES(?,?,?)',ids.workspace,ids.principal,'member');
  await sql('INSERT INTO api_tokens VALUES(?,?,?,?,?,?,?,NULL)',ids.credential,ids.workspace,ids.principal,ids.issuer,createHash('sha256').update(syntheticToken).digest('hex'),'["read","write"]',Math.floor(Date.now()/1000)+3600);
  const db=await mf.unsafeGetDurableObjectStorage('runtime-proof','WorkspaceService',{name:ids.workspace});
  await db.exec('INSERT INTO workspace VALUES(?,?,1,0)',ids.workspace,ids.epoch);await db.exec('INSERT INTO project VALUES(?,?,1,0)',ids.project,'Runtime');
  await db.exec('INSERT INTO membership VALUES(?,?,0,1)',ids.principal,'machine');await db.exec('INSERT INTO credential VALUES(?,?,?,0,1,1)',ids.credential,ids.principal,Date.now()+3600000);await db.exec('INSERT INTO project_grant VALUES(?,?,1,1)',ids.principal,ids.project);
  for(const scope of scopes){await db.exec('INSERT INTO principal_scope VALUES(?,?)',ids.principal,scope);await db.exec('INSERT INTO credential_scope VALUES(?,?)',ids.credential,scope);}
  server=createServer(async(req,res)=>{
   try {
    let body='';for await(const chunk of req)body+=chunk;const rpc=body?JSON.parse(body):null;
    const name=rpc?.method==='tools/call'?rpc.params.name:null;
    requests.push({path:req.url,method:rpc?.method??req.method,name,operationId:rpc?.params?.arguments?.operationId??rpc?.operationId,cookie:req.headers.cookie,cf:req.headers['cf-access-jwt-assertion']});
    if(expiredSession&&req.headers['mcp-session-id']&&rpc?.method==='tools/call'){expiredSession=false;await mf.dispatchFetch(origin+req.url,{method:'DELETE',headers:{authorization:req.headers.authorization,'mcp-protocol-version':'2025-11-25','mcp-session-id':req.headers['mcp-session-id']}});res.writeHead(404,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,error:{code:-32600,message:'Session not found'}}));return;}
    if(receiptUnavailable&&(name==='operation_get'||req.url.includes('/operations/'))){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'UNAVAILABLE'}}));return;}
    const headers={...req.headers};delete headers.host;
    const response=await mf.dispatchFetch(origin+req.url,{method:req.method,headers,...(body?{body}:{})});
    if(killNext&&(name==='issue_create'||req.url.endsWith('/commands'))&&response.status===200){const child=killNext;killNext=null;child.kill('SIGKILL');req.socket.destroy();return;}
    let responseBody=await response.text();
    // Negative contract test only: remove required fields from an otherwise real
    // authenticated response. Successful binding is never synthesized by this bridge.
    if(!metadata&&response.status===200&&(name==='capabilities_get'||req.url.includes('/capabilities?'))){const value=JSON.parse(responseBody),binding=name?value.result.structuredContent:value;delete binding.data.credentialId;delete binding.data.scopes;responseBody=JSON.stringify(value);}
    const outputHeaders=Object.fromEntries(response.headers);delete outputHeaders['content-length'];res.writeHead(response.status,outputHeaders);res.end(responseBody);
   }catch{res.writeHead(500);res.end();}
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));const localOrigin=`http://127.0.0.1:${server.address().port}`;
  const makeSpec=protocol=>{const issueId=randomUUID();return {protocol,origin:localOrigin,syntheticToken,runtimeId:randomUUID(),journal:join(dir,randomUUID()+'.sqlite'),context:{workspaceId:ids.workspace,workspaceEpoch:ids.epoch,principalId:ids.principal,issueId},command:{schemaVersion:1,workspaceId:ids.workspace,workspaceEpoch:ids.epoch,operationId:randomUUID(),commandType:'Issue.Create',entityId:issueId,expectedVersion:0,payload:{projectId:ids.project,title:'restart proof',description:'durable intent',assigneeId:ids.principal,priority:null,parentId:null,initialStatus:'ready'}}};};
  function child(spec,kill=false){return new Promise((resolve,reject)=>{const p=spawn(process.execPath,[new URL('./process-client.mjs',import.meta.url).pathname],{stdio:['pipe','pipe','pipe']});let out='',err='';p.stdout.on('data',c=>out+=c);p.stderr.on('data',c=>err+=c);p.on('error',reject);p.on('exit',(code,signal)=>resolve({code,signal,out:out?JSON.parse(out):null,err}));if(kill)killNext=p;p.stdin.end(JSON.stringify(spec));});}
  for(const protocol of ['rest','mcp-modern','mcp-legacy'])await t.test(`${protocol}: crash after commit then restart returns original receipt without duplicate mutation`,async()=>{
   const spec=makeSpec(protocol),start=requests.length;
   const first=await child({...spec,action:'submit'},true);assert.equal(first.signal,'SIGKILL');
   const second=await child({...spec,runtimeId:randomUUID(),action:'recover'});assert.equal(second.code,0,second.err);assert.equal(second.out.result?.data?.outcome,'committed',JSON.stringify(second.out));assert.equal(second.out.result.meta.operationId,spec.command.operationId);
   const mutation=requests.slice(start).filter(r=>r.name==='issue_create'||r.path.endsWith('/commands'));assert.equal(mutation.length,1);
   assert.equal((await db.exec('SELECT count(*) AS n FROM operation WHERE operation_id=?',spec.command.operationId))[0].n,1);
   const saved=new NodeRuntimeJournal(spec.journal);assert.equal((await saved.load(spec.command.operationId)).state,'committed');saved.close();assert.equal((await readFile(spec.journal)).includes(Buffer.from(syntheticToken)),false);
  });
  await t.test('app mode ignores CF metadata but rejects wrong bearer and human-session ambiguity',async()=>{
   const restPath=`${origin}/machine/v1/workspaces/${ids.workspace}/capabilities?workspaceEpoch=${ids.epoch}`;
   const fakeCF={'cf-access-jwt-assertion':'synthetic.invalid.assertion',cookie:'CF_Authorization=synthetic-invalid-cookie'};
   const noCF=await mf.dispatchFetch(restPath,{headers:{authorization:`Bearer ${syntheticToken}`}});assert.equal(noCF.status,200);assert.equal((await noCF.json()).data.credentialId,ids.credential);
   const inert=await mf.dispatchFetch(restPath,{headers:{authorization:`Bearer ${syntheticToken}`,...fakeCF}});assert.equal(inert.status,200);assert.equal((await inert.json()).data.credentialId,ids.credential);
   for(const authorization of [undefined,'Bearer pk_synthetic_wrong']){
    const response=await mf.dispatchFetch(restPath,{headers:{...fakeCF,...(authorization?{authorization}:{})}});assert.equal(response.status,401);assert.equal((await response.json()).error.code,'UNAUTHENTICATED');
   }
   const response=await mf.dispatchFetch(`${origin}/machine/v1/workspaces/${ids.workspace}/mcp`,{method:'POST',headers:{...fakeCF,authorization:'Bearer pk_synthetic_wrong',accept:'application/json, text/event-stream','content-type':'application/json','mcp-protocol-version':'2026-07-28','mcp-method':'tools/call','mcp-name':'capabilities_get'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'capabilities_get',arguments:{workspaceId:ids.workspace,workspaceEpoch:ids.epoch},_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}}}})});assert.equal(response.status,401);assert.equal((await response.json()).error.data.code,'UNAUTHENTICATED');
   const mixed=await mf.dispatchFetch(restPath,{headers:{authorization:`Bearer ${syntheticToken}`,cookie:'__Host-projektor_session=synthetic-invalid-session'}});assert.equal(mixed.status,401);assert.equal((await mixed.json()).error.code,'AUTH_CREDENTIAL_AMBIGUOUS');
  });
  await t.test('legacy protocol expiry reinitializes a read once; revoked credential never enters that path',async()=>{
   const transport=createMachineTransport({baseUrl:localOrigin,getToken:async()=>syntheticToken,protocol:'mcp-legacy'}),args={workspaceId:ids.workspace,workspaceEpoch:ids.epoch};
   assert.ok((await transport.query('capabilities_get',args)).data);expiredSession=true;const start=requests.length;assert.ok((await transport.query('capabilities_get',args)).data);assert.equal(requests.slice(start).filter(r=>r.method==='initialize').length,1);
   await db.exec('UPDATE credential SET revoked=1 WHERE id=?',ids.credential);const deniedStart=requests.length;await assert.rejects(transport.query('capabilities_get',args),{code:'MACHINE_SCOPE_OR_CREDENTIAL_DENIED'});assert.equal(requests.slice(deniedStart).filter(r=>r.method==='initialize').length,0);await db.exec('UPDATE credential SET revoked=0 WHERE id=?',ids.credential);await transport.close();
  });
  await t.test('expired protocol session on mutation never auto-resends; not_observed remains unresolved',async()=>{
   const spec=makeSpec('mcp-legacy'),journal=new NodeRuntimeJournal(spec.journal),transport=createMachineTransport({baseUrl:localOrigin,getToken:async()=>syntheticToken,protocol:spec.protocol}),runtime=new MachineRuntime({transport,journal,runtimeInstanceId:spec.runtimeId});
   try {
    await runtime.connect(spec.context);expiredSession=true;const start=requests.length;
    await assert.rejects(runtime.submit(spec.command),{code:'MCP_PROTOCOL_SESSION_EXPIRED'});
    const result=await runtime.recover(spec.command.operationId);assert.equal(result.error.code,'OUTCOME_UNKNOWN');assert.equal(result.resendAllowed,false);
    assert.equal(requests.slice(start).filter(r=>r.name==='issue_create').length,1);assert.equal((await journal.listUnresolved()).length,1);
    assert.equal((await db.exec('SELECT count(*) AS n FROM operation WHERE operation_id=?',spec.command.operationId))[0].n,0);
   }finally{await transport.close();journal.close();}
  });
  await t.test('authenticated capabilities expose effective source/Store scope intersection',async()=>{
   const transport=createMachineTransport({baseUrl:localOrigin,getToken:async()=>syntheticToken}),args={workspaceId:ids.workspace,workspaceEpoch:ids.epoch};
   const full=(await transport.query('capabilities_get',args)).data;assert.equal(full.credentialId,ids.credential);assert.ok(full.scopes.includes('issue:write'));assert.ok(full.credentialExpiresAt>Date.now());
   await sql('UPDATE api_tokens SET scopes=? WHERE id=?','["read"]',ids.credential);
   const reduced=(await transport.query('capabilities_get',args)).data;assert.ok(reduced.scopes.includes('issue:read'));assert.ok(!reduced.scopes.some(s=>s.endsWith(':write')));
   await db.exec('DELETE FROM credential_scope WHERE credential_id=? AND scope=?',ids.credential,'history:read');
   assert.ok(!(await transport.query('capabilities_get',args)).data.scopes.includes('history:read'));
   await db.exec('INSERT INTO credential_scope VALUES(?,?)',ids.credential,'history:read');await sql('UPDATE api_tokens SET scopes=? WHERE id=?','["read","write"]',ids.credential);
  });
  await t.test('another authenticated credential for same principal cannot recover original binding',async()=>{
   const spec=makeSpec('rest');await child({...spec,action:'submit'},true);
   const otherCredential=randomUUID(),otherToken='pk_synthetic_other_'+randomUUID();
   await sql('INSERT INTO api_tokens VALUES(?,?,?,?,?,?,?,NULL)',otherCredential,ids.workspace,ids.principal,ids.issuer,createHash('sha256').update(otherToken).digest('hex'),'["read","write"]',Math.floor(Date.now()/1000)+3600);
   await db.exec('INSERT INTO credential VALUES(?,?,?,0,1,1)',otherCredential,ids.principal,Date.now()+3600000);for(const scope of scopes)await db.exec('INSERT INTO credential_scope VALUES(?,?)',otherCredential,scope);
   const start=requests.length,result=await child({...spec,syntheticToken:otherToken,action:'recover'});assert.equal(result.out.error,'MACHINE_BINDING_CHANGED');assert.equal(requests.slice(start).filter(r=>r.path.includes('/operations/')).length,0);
  });
  await t.test('restart retains receipt budget and unknown intent; missing verified metadata fails closed',async()=>{
   const spec=makeSpec('rest');await child({...spec,action:'submit'},true);receiptUnavailable=true;
   const first=await child({...spec,action:'recover'});assert.equal(first.out.result.error.code,'RECOVERY_CHECKS_EXHAUSTED');
   const start=requests.length,second=await child({...spec,action:'recover'});assert.equal(second.out.result.error.code,'RECOVERY_CHECKS_EXHAUSTED');assert.equal(requests.slice(start).filter(r=>r.path.includes('/operations/')).length,0);receiptUnavailable=false;
   metadata=false;const missing=await child({...makeSpec('rest'),action:'submit'});assert.equal(missing.out.error,'VERIFIED_MACHINE_BINDING_REQUIRED');metadata=true;
  });
  assert.ok(requests.every(r=>!r.cookie&&!r.cf));
 } finally {if(server)await new Promise(r=>server.close(r));await mf.dispose();await rm(dir,{recursive:true,force:true});}
});
