import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync,sign} from 'node:crypto';
import {Miniflare,createFetchMock} from 'miniflare';
const issuer='https://team.cloudflareaccess.com',origin='https://projektor.example';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const key={...publicKey.export({format:'jwk'}),kid:'access-key',alg:'RS256',use:'sig'};
const ids=()=>Object.fromEntries(['workspace','epoch','actor','credential','project','issue'].map(k=>[k,randomUUID()]));
const a=ids(),b=ids(),empty=ids(),legacy=ids();let mf;
function jwt(change={},header={}){const now=Math.floor(Date.now()/1000);const claims={iss:issuer,aud:['access-app'],sub:'human-subject',type:'app',email:'person@example.invalid',iat:now-10,nbf:now-10,exp:now+3600,...change};const h=Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT',kid:key.kid,...header})).toString('base64url'),p=Buffer.from(JSON.stringify(claims)).toString('base64url');return `${h}.${p}.${sign('RSA-SHA256',Buffer.from(`${h}.${p}`),privateKey).toString('base64url')}`;}
const headers=(token=jwt())=>({'cf-access-jwt-assertion':token,cookie:`CF_Authorization=${token}`});
const url=(f,path)=>`${origin}/v1/workspaces/${f.workspace}/${path}`;
const get=(f,path,extra={})=>mf.dispatchFetch(url(f,path),{headers:{...headers(),...extra}});
const command=(f,extra={})=>({schemaVersion:1,workspaceId:f.workspace,workspaceEpoch:f.epoch,operationId:randomUUID(),commandType:'Issue.UpdateTitle',entityId:f.issue,expectedVersion:7,payload:{title:'changed'},...extra});
const post=(f,c,extra={})=>mf.dispatchFetch(url(f,'commands'),{method:'POST',headers:{...headers(),'content-type':'application/json',origin,'x-projektor-csrf':'same-origin','idempotency-key':c.operationId,...extra},body:JSON.stringify(c)});
const storage=f=>mf.unsafeGetDurableObjectStorage('product','WorkspaceService',{name:f.workspace});
async function seed(f){const db=await storage(f);await db.exec('INSERT INTO workspace VALUES(?,?,1,0)',f.workspace,f.epoch);await db.exec("INSERT INTO membership VALUES(?,'human',0,1)",f.actor);await db.exec('INSERT INTO credential VALUES(?,?,?,0,1,1)',f.credential,f.actor,Date.now()+7200000);await db.exec("INSERT INTO identity_binding VALUES(?,?,?,?,'human')",issuer,'human-subject',f.credential,f.actor);await db.exec('INSERT INTO project_grant VALUES(?,?,1,1)',f.actor,f.project);await db.exec('INSERT INTO issue VALUES(?,?,?,7,0)',f.issue,f.project,`private ${f.workspace}`);await db.exec('INSERT INTO issue_fts VALUES(?,?)',f.issue,`private ${f.workspace}`);await db.exec("INSERT INTO issue_queue VALUES(?,?,'ready',1,100,0)",f.issue,f.actor);}
before(async()=>{
 const mock=createFetchMock();mock.disableNetConnect();mock.get(issuer).intercept({path:'/cdn-cgi/access/certs'}).reply(200,JSON.stringify({keys:[key]}),{headers:{'content-type':'application/json'}}).persist();
 mf=new Miniflare({cf:false,unsafeInspectDurableObjects:true,name:'product',modules:true,scriptPath:new URL('../service/entry.mjs',import.meta.url).pathname,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],modulesRules:[{type:'Text',include:['**/*.sql'],fallthrough:true}],fetchMock:mock,bindings:{APP_ORIGIN:origin,WORKSPACE_IDS:JSON.stringify([a.workspace,b.workspace,empty.workspace,legacy.workspace]),REQUEST_TIMEOUT_MS:'5000',BODY_TIMEOUT_MS:'1000',PROVIDER_CONFIG:JSON.stringify({issuer,jwksUrl:`${issuer}/cdn-cgi/access/certs`,humanAudience:'access-app',machineAudience:'machine-app',jwksCacheMs:60000,jwksTimeoutMs:500})},durableObjects:{WORKSPACE:{className:'WorkspaceService',useSQLite:true}}});
 await mf.ready;await seed(a);await seed(b);
});
after(async()=>{await mf?.dispose();});
test('exact production entry routes two workerd SQLite workspaces without actor override',async()=>{
 for(const f of [a,b]){const r=await get(f,`my-issues?workspaceEpoch=${f.epoch}`,{'x-principal-id':a.actor,'x-workspace-id':a.workspace});assert.equal(r.status,200,await r.clone().text());const data=await r.json();assert.equal(data.data.items.length,1);assert.equal(data.data.items[0].id,f.issue);assert.equal(data.meta.actorId,f.actor);}
 const ns=await mf.getDurableObjectNamespace('WORKSPACE');const wrong=await ns.get(ns.idFromName(a.workspace)).fetch(url(b,`my-issues?workspaceEpoch=${b.epoch}`),{headers:headers()});assert.equal(wrong.status,403);
 assert.equal((await get(b,`issues/${a.issue}?workspaceEpoch=${b.epoch}`)).status,404);
});
test('100 same operation deliveries and renewed provider token retain one effect',async()=>{
 const c=command(a),first=await post(a,c);assert.equal(first.status,200,await first.clone().text());const result=await first.json();const token=jwt({exp:Math.floor(Date.now()/1000)+7200});const responses=await Promise.all(Array.from({length:100},async()=>{const r=await post(a,c,headers(token));assert.equal(r.status,200);return r.json();}));for(const r of responses)assert.deepEqual(r,result);
 assert.deepEqual(await (await get(a,`operations/${c.operationId}?workspaceEpoch=${a.epoch}`)).json(),result);
 const db=await storage(a);for(const table of ['activity','outbox','operation'])assert.equal((await db.exec(`SELECT count(*) AS n FROM ${table}`))[0].n,1);
});
test('JWT roles cannot override current DB write or receipt authority',async()=>{
 const db=await storage(b),c=command(b);await db.exec('UPDATE credential SET can_write=0');assert.equal((await post(b,c,headers(jwt({roles:['owner'],principalId:a.actor})))).status,403);await db.exec('UPDATE credential SET can_write=1');
 const ok=command(b);assert.equal((await post(b,ok)).status,200);await db.exec('UPDATE credential SET revoked=1');assert.equal((await post(b,ok)).status,403);assert.equal((await get(b,`operations/${ok.operationId}?workspaceEpoch=${b.epoch}`)).status,403);await db.exec('UPDATE credential SET revoked=0');await db.exec('UPDATE membership SET revoked=1');assert.equal((await get(b,`my-issues?workspaceEpoch=${b.epoch}`)).status,403);await db.exec('UPDATE membership SET revoked=0');
});
test('uninitialized, unknown and schema-mismatched stores fail closed without provisioning',async()=>{
 assert.equal((await get(empty,`my-issues?workspaceEpoch=${empty.epoch}`)).status,503);
 const before=await mf.listDurableObjectIds('WORKSPACE');const unknown=ids();assert.equal((await get(unknown,`my-issues?workspaceEpoch=${unknown.epoch}`)).status,404);assert.equal((await mf.listDurableObjectIds('WORKSPACE')).length,before.length);
 const db=await storage(legacy);await db.exec('UPDATE service_schema SET version=999');await mf.unsafeEvictDurableObject('product','WorkspaceService',{name:legacy.workspace});const r=await get(legacy,`my-issues?workspaceEpoch=${legacy.epoch}`);assert.equal(r.status,503);assert.equal((await r.json()).error.code,'STORE_SCHEMA_UNSUPPORTED');
});
test('product excludes test routes and inherited actor RPC methods',async()=>{
 for(const path of ['/sql','/reset','/seed','/fault','/identity','/draft-key','/bootstrap'])assert.equal((await mf.dispatchFetch(origin+path,{method:'POST'})).status,404);
 const ns=await mf.getDurableObjectNamespace('WORKSPACE'),stub=ns.get(ns.idFromName(a.workspace));for(const method of ['sql','seed','command','updateTitle','getOperation','getMyIssues'])await assert.rejects(async()=>await stub[method]({principalId:a.actor},command(a)));
 assert.equal((await post(a,command(a,{actor:{principalId:a.actor}}))).status,400);
});
test('HTTPS origin, CSRF, duplicate credentials, typed expiry and byte limits',async()=>{
 const c=command(a);for(const h of [{origin:'https://evil.example'},{'x-projektor-csrf':''},{'sec-fetch-site':'cross-site'}])assert.equal((await post(a,c,h)).status,403);
 assert.equal((await post(a,c,{authorization:'Bearer unrelated'})).status,401);
 assert.equal((await post(a,c,{cookie:`CF_Authorization=${jwt({sub:'other'})}`})).status,401);
 assert.equal((await post(a,c,headers(jwt({exp:Math.floor(Date.now()/1000)-1})))).status,401);
 assert.equal((await post(a,command(a,{payload:{title:'x'.repeat(17000)}}))).status,413);
 assert.equal((await mf.dispatchFetch(url(a,`my-issues?workspaceEpoch=${a.epoch}`).replace('https:','http:'),{headers:headers()})).status,403);
});
test('current credential expiry, restricted resource and duplicate binding fail closed',async()=>{
 const db=await storage(a);await db.exec('UPDATE credential SET expires_at=0');assert.equal((await get(a,`my-issues?workspaceEpoch=${a.epoch}`)).status,401);await db.exec('UPDATE credential SET expires_at=?',Date.now()+7200000);
 await db.exec('UPDATE issue_queue SET restricted_read=1');const hidden=await get(a,`my-issues?workspaceEpoch=${a.epoch}`);assert.equal(hidden.status,200);assert.equal((await hidden.json()).data.items.length,0);assert.equal((await get(a,`issues/${a.issue}?workspaceEpoch=${a.epoch}`)).status,404);await db.exec('UPDATE issue_queue SET restricted_read=0');
 const duplicate=randomUUID();await db.exec("INSERT INTO identity_binding VALUES(?,?,?,?,'human')",issuer,'human-subject',duplicate,a.actor);assert.equal((await get(a,`my-issues?workspaceEpoch=${a.epoch}`)).status,401);await db.exec('DELETE FROM identity_binding WHERE credential_id=?',duplicate);
});
test('actual Access service JWT resolves separate current machine authority',async()=>{
 const db=await storage(a),actor=randomUUID(),credential=randomUUID();await db.exec("INSERT INTO membership VALUES(?,'machine',0,1)",actor);await db.exec('INSERT INTO credential VALUES(?,?,?,0,1,1)',credential,actor,Date.now()+7200000);await db.exec("INSERT INTO identity_binding VALUES(?,?,?,?,'machine')",issuer,'service-client',credential,actor);await db.exec('INSERT INTO project_grant VALUES(?,?,1,1)',actor,a.project);
 const token=jwt({sub:'',common_name:'service-client',email:undefined,aud:['machine-app'],nbf:undefined});const endpoint=`${origin}/machine/v1/workspaces/${a.workspace}/my-issues?workspaceEpoch=${a.epoch}`;
 const r=await mf.dispatchFetch(endpoint,{headers:{authorization:`Bearer ${token}`}});assert.equal(r.status,200,await r.clone().text());const result=await r.json();assert.equal(result.meta.actorId,actor);assert.equal(result.data.items.length,0);
 assert.equal((await get(a,`my-issues?workspaceEpoch=${a.epoch}`,headers(token))).status,401);
 await db.exec('UPDATE credential SET revoked=1 WHERE id=?',credential);assert.equal((await mf.dispatchFetch(endpoint,{headers:{authorization:`Bearer ${token}`}})).status,403);
});
test('unfinished body expires before any effect; rejection is not a rollback claim',async()=>{
 const db=await storage(a),before=(await db.exec('SELECT count(*) AS n FROM operation'))[0].n,c=command(a,{expectedVersion:8}),bytes=JSON.stringify(c);
 let timer;const stream=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(bytes.slice(0,-1)));timer=setTimeout(()=>{try{controller.enqueue(new TextEncoder().encode('}'));controller.close();}catch{}},1600);},cancel(){clearTimeout(timer);}});
 const r=await mf.dispatchFetch(url(a,'commands'),{method:'POST',headers:{...headers(),'content-type':'application/json',origin,'x-projektor-csrf':'same-origin','idempotency-key':c.operationId},body:stream,duplex:'half'});assert.equal(r.status,408,await r.clone().text());assert.equal((await r.json()).error.outcome,'unknown');assert.equal((await db.exec('SELECT count(*) AS n FROM operation'))[0].n,before);clearTimeout(timer);
});
test('unmarked existing schema is preserved; unknown verified subject gets no membership',async()=>{
 const db=await storage(legacy);await db.exec('CREATE TABLE preserved_source(id TEXT PRIMARY KEY,value TEXT)');await db.exec("INSERT INTO preserved_source VALUES('old','keep verbatim')");await db.exec('DROP TABLE service_schema');await mf.unsafeEvictDurableObject('product','WorkspaceService',{name:legacy.workspace});const r=await get(legacy,`my-issues?workspaceEpoch=${legacy.epoch}`);assert.equal(r.status,503);assert.equal((await r.json()).error.code,'STORE_SCHEMA_UNSUPPORTED');assert.deepEqual(await db.exec('SELECT * FROM preserved_source'),[{id:'old',value:'keep verbatim'}]);
 const current=await storage(a),before=(await current.exec('SELECT count(*) AS n FROM membership'))[0].n;assert.equal((await get(a,`my-issues?workspaceEpoch=${a.epoch}`,headers(jwt({sub:'unknown-subject'})))).status,401);assert.equal((await current.exec('SELECT count(*) AS n FROM membership'))[0].n,before);
});
test('removed enrollment and automatic purge routes cannot create membership or delete data',async()=>{
 const db=await storage(a);
 const counts=async()=>Object.fromEntries(await Promise.all(['membership','identity_binding','issue','activity','outbox','operation'].map(async table=>[table,(await db.exec(`SELECT count(*) AS n FROM ${table}`))[0].n])));
 const before=await counts();
 for(const path of ['/auto-join','/autoprovisionmembership','/cron','/scheduled','/trash/purge',`/v1/workspaces/${a.workspace}/auto-join`,`/v1/workspaces/${a.workspace}/trash/purge`])for(const method of ['GET','POST'])assert.equal((await mf.dispatchFetch(origin+path,{method,headers:headers()})).status,404);
 const ns=await mf.getDurableObjectNamespace('WORKSPACE'),stub=ns.get(ns.idFromName(a.workspace));
 for(const method of ['autoJoin','autoProvisionMembership','purgeTrash'])await assert.rejects(async()=>await stub[method]());
 assert.deepEqual(await counts(),before);
});
test('pre-I1 version 2 stores fail closed without implicit migration or mutation',async()=>{
 const old=legacy;const db=await storage(old);await db.exec('CREATE TABLE service_schema(id INTEGER PRIMARY KEY,version INTEGER NOT NULL)');await db.exec('INSERT INTO service_schema VALUES(1,2)');await mf.unsafeEvictDurableObject('product','WorkspaceService',{name:old.workspace});const r=await get(old,`my-issues?workspaceEpoch=${old.epoch}`);assert.equal(r.status,503);assert.equal((await r.json()).error.code,'STORE_SCHEMA_UNSUPPORTED');assert.deepEqual(await db.exec('SELECT * FROM preserved_source'),[{id:'old',value:'keep verbatim'}]);assert.deepEqual(await db.exec('SELECT version FROM service_schema'),[{version:2}]);
});
test('I5 selected ingress independently verifies credential, DO identity, schema fingerprint and no actor RPC',async()=>{
 const ns=await mf.getDurableObjectNamespace('WORKSPACE'),stub=ns.get(ns.idFromName(b.workspace));
 assert.equal((await stub.fetch(`${origin}/v1/workspaces/${a.workspace}/session`,{headers:headers()})).status,403);
 assert.equal((await stub.fetch(`${origin}/v1/workspaces/${b.workspace}/session`,{headers:{'x-principal-id':b.actor}})).status,401);
 assert.equal((await stub.fetch(`${origin}/v1/workspaces/${b.workspace}/session`,{headers:headers(jwt({sub:'unmapped-subject',principalId:b.actor}))})).status,401);
 for(const method of ['currentSession','draftKey','browserSession','browserKey'])await assert.rejects(async()=>stub[method]({principalId:b.actor}));
 const db=await storage(b),fingerprint=(await db.exec('SELECT fingerprint FROM service_schema_variant'))[0].fingerprint;
 await db.exec("UPDATE service_schema_variant SET fingerprint='different-unpublished-v5-variant'");await mf.unsafeEvictDurableObject('product','WorkspaceService',{name:b.workspace});
 const bad=await get(b,'session');assert.equal(bad.status,503);assert.equal((await bad.json()).error.code,'STORE_SCHEMA_UNSUPPORTED');
 await db.exec('UPDATE service_schema_variant SET fingerprint=?',fingerprint);await db.exec('UPDATE service_schema SET version=4');await mf.unsafeEvictDurableObject('product','WorkspaceService',{name:b.workspace});
 assert.equal((await get(b,'session')).status,503);assert.deepEqual(await db.exec('SELECT version FROM service_schema'),[{version:4}]);
});
