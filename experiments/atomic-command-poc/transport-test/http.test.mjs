import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync,sign} from 'node:crypto';
import {createServer} from 'node:net';
import {Miniflare} from 'miniflare';
const issuer='https://ephemeral-issuer.invalid';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
let mf,base,control;
before(async()=>{
 const reserve=createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
 base=`http://127.0.0.1:${port}`;
 mf=new Miniflare({host:'127.0.0.1',port,workers:[
  {name:'app',modules:true,scriptPath:new URL('./fixture-worker.mjs',import.meta.url).pathname,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],modulesRules:[{type:'Text',include:['**/*.sql'],fallthrough:true}],bindings:{TEST_ISSUER:issuer,TEST_PUBLIC_JWK:JSON.stringify(publicKey.export({format:'jwk'})),TEST_ORIGIN:base},durableObjects:{WORKSPACE:{className:'FixtureWorkspace',useSQLite:true}}},
  {name:'control',modules:true,scriptPath:new URL('./control-worker.mjs',import.meta.url).pathname,compatibilityDate:'2026-07-30',durableObjects:{WORKSPACE:{className:'FixtureWorkspace',scriptName:'app',useSQLite:true}}}
 ]});base=(await mf.ready).origin;control=await mf.getWorker('control');
});
after(async()=>{await mf?.dispose();});
function jwt(claims,header={}) {const h=Buffer.from(JSON.stringify({alg:'RS256',typ:'projektor-local+jwt',kid:'ephemeral-test-key',...header})).toString('base64url');const p=Buffer.from(JSON.stringify(claims)).toString('base64url');return `${h}.${p}.${sign('RSA-SHA256',Buffer.from(`${h}.${p}`),privateKey).toString('base64url')}`;}
async function fixture(kind='machine') {
 const ids=Object.fromEntries(['workspace','epoch','actor','credential','issue','project'].map(k=>[k,randomUUID()]));
 const call=async(action,...args)=>(await control.fetch('http://private-control/',{method:'POST',body:JSON.stringify({workspace:ids.workspace,action,args})})).json();
 const now=Math.floor(Date.now()/1000);
 await call('seed',ids,kind,issuer,(now+3600)*1000);
 const claims={iss:issuer,sub:'fixture-subject',aud:`projektor-local-${kind}`,kind,cid:ids.credential,wid:ids.workspace,iat:now-10,nbf:now-10,exp:now+600};
 const token=jwt(claims);
 const path=`/${kind==='machine'?'machine/':''}v1/workspaces/${ids.workspace}`;
 const command={schemaVersion:1,workspaceId:ids.workspace,workspaceEpoch:ids.epoch,operationId:randomUUID(),commandType:'Issue.UpdateTitle',entityId:ids.issue,expectedVersion:7,payload:{title:'new title'}};
 async function request(c=command,t=token,extra={}) {return fetch(`${base}${path}/commands`,{method:'POST',headers:{'content-type':'application/json','idempotency-key':c.operationId,...(kind==='machine'?{authorization:`Bearer ${t}`}:{cookie:`projektor_test_session=${t}`,origin:base,'x-projektor-csrf':'same-origin'}),...extra},body:JSON.stringify(c)});}
 async function lookup(t=token) {return fetch(`${base}${path}/operations/${command.operationId}?workspaceEpoch=${ids.epoch}`,{headers:kind==='machine'?{authorization:`Bearer ${t}`}:{cookie:`projektor_test_session=${t}`}});}
 async function effects(n=1) {assert.equal((await call('sql','SELECT version FROM issue'))[0].version,7+n);for(const table of ['activity','outbox','operation'])assert.equal((await call('sql',`SELECT COUNT(*) AS n FROM ${table}`))[0].n,n);}
 return {ids,call,claims,token,command,request,lookup,effects,path};
}
test('actual TCP HTTP signed ingress to workerd commits once; 100 concurrent renewed-token deliveries recover same receipt',async()=>{
 const f=await fixture(),r=await f.request();assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');const receipt=await r.json();assert.equal(receipt.meta.actorId,f.ids.actor);
 const renewed=jwt({...f.claims,exp:f.claims.exp+60});const replies=await Promise.all(Array.from({length:100},async()=> (await f.request(f.command,renewed)).json()));for(const reply of replies)assert.deepEqual(reply,receipt);assert.deepEqual(await (await f.lookup(renewed)).json(),receipt);await f.effects();
});
for(const [name,change,header] of [
 ['issuer',{iss:'https://other.invalid'}],['audience',{aud:'wrong'}],['expiry',{exp:Math.floor(Date.now()/1000)-1}],['future nbf',{nbf:Math.floor(Date.now()/1000)+600}],['future iat',{iat:Math.floor(Date.now()/1000)+600}],['numeric expiry',{exp:'9999999999'}],['subject',{sub:'other'}],['credential',{cid:randomUUID()}],['kind',{kind:'human'}],['alg',{}, {alg:'none'}],['kid',{}, {kid:'attacker'}],['typ',{}, {typ:'JWT'}],['jku',{}, {jku:'https://evil.invalid'}]
])test(`signed but invalid ${name} rejected before effects and receipt`,async()=>{const f=await fixture();const t=jwt({...f.claims,...change},header);assert.equal((await f.request(f.command,t)).status,401);assert.equal((await f.lookup(t)).status,401);await f.effects(0);});
test('bad signature, malformed token, missing auth and mixed sources cannot mutate',async()=>{const f=await fixture();const p=f.token.split('.');p[2]=(p[2][0]==='A'?'B':'A')+p[2].slice(1);for(const token of [p.join('.'),'bad',''])assert.equal((await f.request(f.command,token)).status,401);assert.equal((await f.request(f.command,f.token,{cookie:`projektor_test_session=${f.token}`})).status,401);await f.effects(0);});
test('untrusted actor body rejected and identity headers ignored',async()=>{const f=await fixture();assert.equal((await f.request({...f.command,actor:{principalId:randomUUID()}})).status,400);const r=await (await f.request(f.command,f.token,{'x-principal-id':randomUUID(),'cf-access-authenticated-user-email':'owner@invalid'})).json();assert.equal(r.meta.actorId,f.ids.actor);await f.effects();});
test('current revocation prevents receipt disclosure and new mutation',async()=>{for(const sql of ['UPDATE credential SET revoked=1','UPDATE membership SET revoked=1','UPDATE project_grant SET can_read=0','UPDATE membership SET read_own=0']){const f=await fixture();await f.request();await f.call('sql',sql);assert.equal((await f.lookup()).status,403);assert.equal((await f.request()).status,403);await f.effects();}});
test('write-only revocation permits original receipt but prohibits new effect',async()=>{const f=await fixture();const r=await (await f.request()).json();await f.call('sql','UPDATE credential SET can_write=0');assert.deepEqual(await (await f.lookup()).json(),r);assert.deepEqual(await (await f.request()).json(),r);assert.equal((await f.request({...f.command,operationId:randomUUID(),expectedVersion:8})).status,403);await f.effects();});
test('DB expiry independently rejected with still valid signed token',async()=>{const f=await fixture();await f.call('sql','UPDATE credential SET expires_at=0');assert.equal((await f.request()).status,401);await f.effects(0);});
test('another authenticated principal cannot read receipt by knowing operation ID',async()=>{const f=await fixture();await f.request();const actor=randomUUID(),cid=randomUUID();await f.call('sql','INSERT INTO membership VALUES(?,?,0,1)',[actor,'machine']);await f.call('sql','INSERT INTO credential VALUES(?,?,?,0,1,1)',[cid,actor,f.claims.exp*1000]);await f.call('sql','INSERT INTO identity_binding VALUES(?,?,?,?,?)',[issuer,'other',cid,actor,'machine']);await f.call('sql','INSERT INTO project_grant VALUES(?,?,1,1)',[actor,f.ids.project]);const r=await (await f.lookup(jwt({...f.claims,cid,sub:'other'}))).json();assert.deepEqual(r.data,{outcome:'not_observed',absenceIsProofOfNonExecution:false});await f.effects();});
test('HTTP envelope, idempotency key, content-type, actual byte limit and private fixture routes',async()=>{const f=await fixture();for(const [c,h,status] of [[f.command,{'idempotency-key':randomUUID()},400],[f.command,{'content-type':'text/plain'},415],[{...f.command,payload:{title:'a'.repeat(17000)}},{},413],[{...f.command,workspaceId:randomUUID()},{},400]])assert.equal((await f.request(c,f.token,h)).status,status);assert.equal((await fetch(`${base}/sql`,{method:'POST',body:'{}'})).status,404);await f.effects(0);});
test('human route rejects cross-origin, missing CSRF, mixed credentials and machine token',async()=>{const f=await fixture('human');for(const h of [{origin:'https://evil.invalid'},{'x-projektor-csrf':''},{authorization:`Bearer ${f.token}`}])assert.ok([401,403].includes((await f.request(f.command,f.token,h)).status));assert.equal((await f.request(f.command,jwt({...f.claims,kind:'machine',aud:'projektor-local-machine'}))).status,401);await f.effects(0);});
test('postcommit response-loss simulation remains unknown; renewal receipt has one effect',async()=>{const f=await fixture();f.command.payload.title='TEST_ONLY_DROP_AFTER_COMMIT';const r=await f.request();assert.equal(r.status,503);const b=await r.json();assert.equal(b.error.outcome,'unknown');assert.equal('effectApplied' in b.error,false);const receipt=await (await f.lookup(jwt({...f.claims,exp:f.claims.exp+60}))).json();assert.equal(receipt.data.outcome,'committed');await f.effects();});

test('human same-origin CSRF header and signed cookie permit command; receipt/read are private',async()=>{const f=await fixture('human');assert.equal((await f.request()).status,200);assert.equal((await f.lookup()).status,200);const r=await fetch(`${base}${f.path}/issues/${f.ids.issue}?workspaceEpoch=${f.ids.epoch}`,{headers:{cookie:`projektor_test_session=${f.token}`}});assert.equal(r.status,200);assert.equal((await r.json()).data.title,'new title');await f.effects();});
test('missing expected version preserves HTTP428 contract',async()=>{const f=await fixture();const {expectedVersion,...c}=f.command;assert.equal((await f.request(c)).status,428);await f.effects(0);});
test('typed credential and workspace claims cannot use coercible arrays',async()=>{const f=await fixture();for(const changed of [{cid:[f.ids.credential]},{wid:[f.ids.workspace]}])assert.equal((await f.request(f.command,jwt({...f.claims,...changed}))).status,401);await f.effects(0);});
test('slow unfinished HTTP request body hits deadline and cannot mutate',async()=>{
 const {request}=await import('node:http');const f=await fixture();
 const result=await new Promise((resolve,reject)=>{const req=request(`${base}${f.path}/commands`,{method:'POST',headers:{authorization:`Bearer ${f.token}`,'idempotency-key':f.command.operationId,'content-type':'application/json','transfer-encoding':'chunked'}},res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>{req.destroy();resolve({status:res.statusCode,body:JSON.parse(body)});});});req.on('error',reject);req.write(JSON.stringify(f.command));});
 assert.equal(result.status,408);assert.equal(result.body.error.code,'BODY_TIMEOUT');await f.effects(0);
});
test('real HTTP401 human renewal reconciles same ID and preserves newer local draft',async()=>{
 const {createFetchTransport,SessionCoordinator,OperationCoordinator}=await import('../client/recovery.mjs');
 const f=await fixture('human');let token=jwt({...f.claims,iat:f.claims.iat-100,exp:f.claims.iat-1}),renewals=0;const sent=[];
 const initialSession={principalId:f.ids.actor,workspaceId:f.ids.workspace,workspaceEpoch:f.ids.epoch,actorKind:'human',expiresAt:f.claims.exp*1000,scopes:['issue:read','issue:write']};
 const session=new SessionCoordinator({initialSession,renewSession:async()=>{renewals++;token=f.token;return {kind:'authenticated',session:initialSession};}});
 const transport=createFetchTransport({baseUrl:base,prefix:'/v1',getToken:()=>null,fetchImpl:(url,options)=>{if(options.method==='POST')sent.push(JSON.parse(options.body));return fetch(url,{...options,headers:{...options.headers,cookie:`projektor_test_session=${token}`,origin:base}});}});
 const editor=new OperationCoordinator({session,transport,resourceProjectId:f.ids.project,initialDraft:f.command.payload,retryDelaysMs:[0,0,0]});
 const pending=editor.submit(f.command);editor.edit({title:'newer unsent input'});assert.equal((await pending).kind,'auth-required');assert.equal(editor.snapshot().locked,true);assert.equal((await editor.prepareRecovery()).mayNavigate,false);
 assert.equal((await editor.recover()).kind,'committed');assert.equal(renewals,1);assert.equal(sent.length,2);assert.deepEqual(sent[0],sent[1]);assert.equal(editor.snapshot().draft.value.title,'newer unsent input');assert.equal(editor.snapshot().draft.dirty,true);assert.equal(editor.snapshot().operation.operationId,f.command.operationId);await f.effects();editor.dispose();
});
test('real HTTP503 after commit reconciles receipt without reissuing command',async()=>{
 const {createFetchTransport,SessionCoordinator,OperationCoordinator}=await import('../client/recovery.mjs');const f=await fixture();f.command.payload.title='TEST_ONLY_DROP_AFTER_COMMIT';let posts=0;
 const session=new SessionCoordinator({initialSession:{principalId:f.ids.actor,workspaceId:f.ids.workspace,workspaceEpoch:f.ids.epoch,actorKind:'machine',expiresAt:f.claims.exp*1000,scopes:['issue:read','issue:write'],token:f.token}});
 const transport=createFetchTransport({baseUrl:base,fetchImpl:(url,options)=>{if(options.method==='POST')posts++;return fetch(url,options);}});
 const editor=new OperationCoordinator({session,transport,resourceProjectId:f.ids.project,initialDraft:f.command.payload});assert.equal((await editor.submit(f.command)).kind,'ambiguous');assert.equal((await editor.recover()).kind,'committed');assert.equal(posts,1);await f.effects();editor.dispose();
});
test('token expiring after signature verification but before body completion cannot mutate',async()=>{
 const {request}=await import('node:http');const f=await fixture();const token=jwt({...f.claims,exp:Math.floor(Date.now()/1000)+1});const bytes=JSON.stringify(f.command);
 const result=await new Promise((resolve,reject)=>{const req=request(`${base}${f.path}/commands`,{method:'POST',headers:{authorization:`Bearer ${token}`,'idempotency-key':f.command.operationId,'content-type':'application/json','transfer-encoding':'chunked'}},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(b)}));});req.on('error',reject);req.write(bytes.slice(0,-1));setTimeout(()=>req.end(bytes.slice(-1)),1200);});
 assert.equal(result.status,401);assert.equal(result.body.error.code,'CREDENTIAL_EXPIRED');await f.effects(0);
});
test('workspace route and epoch fence cannot be bypassed by a signed token',async()=>{const f=await fixture();assert.equal((await f.request(f.command,jwt({...f.claims,wid:randomUUID()}))).status,403);assert.equal((await f.request({...f.command,workspaceEpoch:randomUUID()})).status,409);await f.effects(0);});
