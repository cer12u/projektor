// Actual workerd asset router + unchanged product entry + real WorkspaceService.
// Synthetic local identities only; no loopback HTML fallback or wrapper Worker.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync,sign,createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Miniflare,createFetchMock} from 'miniflare';
import {readHostingTemplate} from '../hosting/config.mjs';

const origin='https://hosting-product.invalid',issuer='https://hosting-provider.invalid';
const ids=Object.fromEntries(['workspace','epoch','principal','credential','project','issue','wiki'].map(key=>[key,randomUUID()]));
const pretty={issue:'/projects/SYNTH/issues/1/old-title',wiki:'/wiki/synthetic-guide',project:'/projects/view/synthetic-project'};
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const key={...publicKey.export({format:'jwk'}),kid:'ephemeral-hosting-test',alg:'RS256',use:'sig'};
let mf,db,hosting,index,headers;
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
function jwt(){
 const now=Math.floor(Date.now()/1000);
 const head=Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT',kid:key.kid})).toString('base64url');
 const body=Buffer.from(JSON.stringify({iss:issuer,aud:['synthetic-human'],sub:'synthetic-hosting-user',type:'app',iat:now-2,nbf:now-2,exp:now+600})).toString('base64url');
 return `${head}.${body}.${sign('RSA-SHA256',Buffer.from(`${head}.${body}`),privateKey).toString('base64url')}`;
}
function mockNetwork(){
 const mock=createFetchMock();mock.disableNetConnect();
 mock.get(issuer).intercept({path:'/certs'}).reply(200,JSON.stringify({keys:[key]}),{headers:{'content-type':'application/json'}}).persist();
 return mock;
}
function runtime({assets=hosting.assets,bindings={}}={}){
 return new Miniflare({cf:false,name:'hosting-product',unsafeInspectDurableObjects:true,modules:true,
  scriptPath:hosting.scriptPath,modulesRoot:hosting.modulesRoot,
  compatibilityDate:hosting.compatibilityDate,compatibilityFlags:hosting.compatibilityFlags,modulesRules:hosting.modulesRules,
  assets,fetchMock:mockNetwork(),
  bindings:{APP_ORIGIN:origin,WORKSPACE_IDS:JSON.stringify([ids.workspace]),REQUEST_TIMEOUT_MS:'5000',BODY_TIMEOUT_MS:'1000',
   PROVIDER_CONFIG:JSON.stringify({issuer,jwksUrl:issuer+'/certs',humanAudience:'synthetic-human',machineAudience:'synthetic-machine',jwksCacheMs:60000,jwksTimeoutMs:500}),...bindings},
  durableObjects:{WORKSPACE:{className:'WorkspaceService',useSQLite:true}},
 });
}
const request=(path,init={})=>mf.dispatchFetch(origin+path,init);
async function json(response,status){
 assert.equal(response.status,status,await response.clone().text());
 assert.match(response.headers.get('content-type')??'',/^application\/json\b/);
 return response.json();
}
async function create(id,commandType,payload){
 const operationId=randomUUID();
 await json(await request(`/v1/workspaces/${ids.workspace}/commands`,{method:'POST',headers:{...headers,'content-type':'application/json','idempotency-key':operationId},body:JSON.stringify({schemaVersion:1,workspaceId:ids.workspace,workspaceEpoch:ids.epoch,operationId,commandType,entityId:id,expectedVersion:0,payload})}),200);
}
before(async()=>{
 hosting=await readHostingTemplate();index=await readFile(resolve(hosting.assets.directory,'index.html'));
 headers={'cf-access-jwt-assertion':jwt(),origin,'x-projektor-csrf':'same-origin'};
 mf=runtime();await mf.ready;
 db=await mf.unsafeGetDurableObjectStorage('hosting-product','WorkspaceService',{name:ids.workspace});
 await db.exec('INSERT INTO workspace VALUES(?,?,1,0)',ids.workspace,ids.epoch);
 await db.exec('INSERT INTO project VALUES(?,?,1,0)',ids.project,'Synthetic hosting project');
 await db.exec("INSERT INTO membership VALUES(?,'human',0,1)",ids.principal);
 await db.exec('INSERT INTO credential VALUES(?,?,?,0,1,1)',ids.credential,ids.principal,Date.now()+600000);
 await db.exec("INSERT INTO identity_binding VALUES(?,?,?,?,'human')",issuer,'synthetic-hosting-user',ids.credential,ids.principal);
 await db.exec('INSERT INTO project_grant VALUES(?,?,1,1)',ids.principal,ids.project);
 await db.exec("INSERT INTO scope_manage_grant VALUES(?,'project',?,1)",ids.principal,ids.project);
 for(const scope of ['operations:read_own','issue:read','issue:write','wiki:read','wiki:write','history:read']){
  await db.exec('INSERT INTO principal_scope VALUES(?,?)',ids.principal,scope);
  await db.exec('INSERT INTO credential_scope VALUES(?,?)',ids.credential,scope);
 }
 await db.exec('INSERT INTO project_url VALUES(?,?,?,NULL)',ids.project,'SYNTH','synthetic-project');
 await create(ids.issue,'Issue.Create',{projectId:ids.project,title:'Synthetic issue',description:'Synthetic raw source',assigneeId:null,priority:null,parentId:null,initialStatus:'ready'});
 await create(ids.wiki,'Wiki.Create',{pageId:ids.wiki,scope:{kind:'project',projectId:ids.project},parentId:null,title:'Synthetic wiki',slug:'synthetic-guide',contentMarkdown:'Synthetic raw wiki source'});
});
after(async()=>await mf?.dispose());

test('actual assets return the product shell for source legacy URLs without redirect or fixture content',async()=>{
 for(const path of ['/',pretty.issue,pretty.wiki,pretty.project])for(const navigate of [false,true]){
  const response=await request(path,{headers:navigate?{'sec-fetch-mode':'navigate','accept':'text/html'}:{}});
  assert.equal(response.status,200);assert.equal(response.headers.get('location'),null);
  assert.match(response.headers.get('content-type')??'',/^text\/html\b/);
  assert.equal(sha256(Buffer.from(await response.arrayBuffer())),sha256(index));
 }
 const built=await readdir(hosting.assets.directory);
 assert.ok(!built.includes('fixture.html'));assert.ok(!built.includes('fixtures'));
 const references=[...index.toString().matchAll(/(?:src|href)="(\/assets\/[^\"]+\.(?:js|css))"/g)].map(match=>match[1]);
 assert.ok(references.some(path=>path.endsWith('.js')));assert.ok(references.some(path=>path.endsWith('.css')));
 for(const path of references){
  const response=await request(path);assert.equal(response.status,200);
  assert.match(response.headers.get('content-type')??'',path.endsWith('.js')?/^(?:text|application)\/javascript\b/:/^text\/css\b/);
  const bytes=Buffer.from(await response.arrayBuffer());assert.deepEqual(bytes,await readFile(resolve(hosting.assets.directory,path.slice(1))));
  assert.doesNotMatch(bytes.toString(),/__fixture\/|ephemeral-session-provider\.invalid/);
 }
});

test('navigation headers cannot divert bootstrap, session, workspace or machine APIs to HTML',async()=>{
 for(const navigate of [false,true]){
  const navigation=navigate?{'sec-fetch-mode':'navigate','accept':'text/html'}:{};
  const bootstrap=await json(await request('/v1/bootstrap',{headers:{...headers,...navigation}}),200);
  assert.equal(bootstrap.principalId,ids.principal);assert.equal(bootstrap.workspaces[0].workspaceId,ids.workspace);
  const session=await json(await request('/v1/session?workspaceId='+ids.workspace,{headers:{...headers,...navigation}}),200);
  assert.equal(session.principalId,ids.principal);assert.equal(session.workspaceEpoch,ids.epoch);
  await json(await request('/v1/bootstrap',{headers:navigation}),401);
  await json(await request('/v1/draft-keys',{headers:{...headers,...navigation}}),405);
  await json(await request(`/v1/workspaces/${ids.workspace}/legacy-url?`+new URLSearchParams({workspaceEpoch:ids.epoch,path:pretty.issue}),{headers:navigation}),401);
  await json(await request(`/machine/v1/workspaces/${ids.workspace}/legacy-url?`+new URLSearchParams({workspaceEpoch:ids.epoch,path:pretty.issue}),{headers:navigation}),401);
 }
 for(const prefix of ['/v1','/machine','/api','/mcp','/auth','/oauth','/.well-known'])for(const suffix of ['', '/unknown']){
  const result=await json(await request(prefix+suffix,{headers:{'sec-fetch-mode':'navigate','accept':'text/html'}}),404);
  assert.equal(result.error.code,'NOT_FOUND');
 }
});

test('the same hosted service resolves all three legacy targets and rechecks current project access',async()=>{
 const sourceBefore=await db.exec('SELECT id,content_markdown FROM content_revision ORDER BY id');
 const bindingsBefore=await db.exec('SELECT * FROM link_binding ORDER BY id');
 for(const [kind,path] of Object.entries(pretty)){
  const query=new URLSearchParams({workspaceEpoch:ids.epoch,path});
  const value=await json(await request(`/v1/workspaces/${ids.workspace}/legacy-url?${query}`,{headers}),200);
  assert.equal(value.data.kind,kind);assert.equal(value.data.id,ids[kind]);
  assert.equal(value.meta.workspaceId,ids.workspace);assert.equal(value.meta.workspaceEpoch,ids.epoch);assert.equal(value.meta.actorId,ids.principal);
 }
 await db.exec('UPDATE project_grant SET can_read=0 WHERE principal_id=? AND project_id=?',ids.principal,ids.project);
 try{for(const path of Object.values(pretty)){
  const query=new URLSearchParams({workspaceEpoch:ids.epoch,path});
  const result=await json(await request(`/v1/workspaces/${ids.workspace}/legacy-url?${query}`,{headers}),404);
  assert.equal(result.error.code,'NOT_FOUND');
 }}finally{await db.exec('UPDATE project_grant SET can_read=1 WHERE principal_id=? AND project_id=?',ids.principal,ids.project);}
 assert.deepEqual(await db.exec('SELECT id,content_markdown FROM content_revision ORDER BY id'),sourceBefore);
 assert.deepEqual(await db.exec('SELECT * FROM link_binding ORDER BY id'),bindingsBefore);
});

test('unprovisioned template serves only a public shell and cannot activate the API',async()=>{
 const unprovisioned=runtime({bindings:hosting.config.vars});
 try{
  await unprovisioned.ready;
  const result=await json(await unprovisioned.dispatchFetch(origin+'/v1/bootstrap',{headers:{'sec-fetch-mode':'navigate','accept':'text/html'}}),503);
  assert.equal(result.error.code,'SERVICE_CONFIG_INVALID');
 }finally{await unprovisioned.dispose();}
});

test('counterexample: absent worker-first routes misroute API navigation to the product shell',async()=>{
 const {routerConfig,...assetSettings}=hosting.assets;
 const broken=runtime({assets:assetSettings});
 try{
  await broken.ready;
  const response=await broken.dispatchFetch(origin+'/v1/bootstrap',{headers:{'sec-fetch-mode':'navigate','accept':'text/html'}});
  assert.equal(response.status,200);assert.match(response.headers.get('content-type')??'',/^text\/html\b/);
  assert.equal(sha256(Buffer.from(await response.arrayBuffer())),sha256(index));
 }finally{await broken.dispose();}
});
