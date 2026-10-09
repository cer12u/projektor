import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync,sign} from 'node:crypto';
import {Miniflare,createFetchMock} from 'miniflare';
const issuer='https://content.cloudflareaccess.com',origin='https://content.example';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const key={...publicKey.export({format:'jwk'}),kid:'access-key',alg:'RS256',use:'sig'};
const fixtures=['human','machine','large'].map(kind=>({kind:kind==='large'?'human':kind,...Object.fromEntries(['workspace','epoch','actor','credential','project','issue'].map(k=>[k,randomUUID()]))}));let mf;
function jwt(f){const now=Math.floor(Date.now()/1000);const claims={iss:issuer,aud:[f.kind==='human'?'access-app':'machine-app'],sub:f.kind==='human'?'human-subject':'',common_name:f.kind==='machine'?'machine-subject':undefined,type:'app',iat:now-10,nbf:now-10,exp:now+3600};const h=Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT',kid:key.kid})).toString('base64url'),p=Buffer.from(JSON.stringify(claims)).toString('base64url');return `${h}.${p}.${sign('RSA-SHA256',Buffer.from(`${h}.${p}`),privateKey).toString('base64url')}`;}
function auth(f){const token=jwt(f);return f.kind==='human'?{'cf-access-jwt-assertion':token,cookie:`CF_Authorization=${token}`}:{authorization:`Bearer ${token}`};}
const url=(f,path)=>`${origin}/${f.kind==='machine'?'machine/':''}v1/workspaces/${f.workspace}/${path}`;
const get=(f,path)=>mf.dispatchFetch(url(f,`${path}?workspaceEpoch=${f.epoch}`),{headers:auth(f)});
const command=(f,type,payload,expectedVersion,entityId=f.issue)=>({schemaVersion:1,workspaceId:f.workspace,workspaceEpoch:f.epoch,operationId:randomUUID(),commandType:type,entityId,expectedVersion,payload});
const create=(f,description='---\r\nraw: 日本語\r\n---\n# Markdown\n😀 e\u0301  \n<unknown syntax>')=>command(f,'Issue.Create',{projectId:f.project,title:'Content test',description,assigneeId:f.actor,priority:'P2',parentId:null,initialStatus:'ready'},0);
const post=(f,c)=>mf.dispatchFetch(url(f,'commands'),{method:'POST',headers:{...auth(f),'content-type':'application/json',origin,'x-projektor-csrf':'same-origin','idempotency-key':c.operationId},body:JSON.stringify(c)});
const storage=f=>mf.unsafeGetDurableObjectStorage('content-product','WorkspaceService',{name:f.workspace});
before(async()=>{
 const mock=createFetchMock();mock.disableNetConnect();mock.get(issuer).intercept({path:'/cdn-cgi/access/certs'}).reply(200,JSON.stringify({keys:[key]}),{headers:{'content-type':'application/json'}}).persist();
 mf=new Miniflare({cf:false,fetchMock:mock,unsafeInspectDurableObjects:true,name:'content-product',modules:true,scriptPath:new URL('../service/entry.mjs',import.meta.url).pathname,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],modulesRules:[{type:'Text',include:['**/*.sql'],fallthrough:true}],bindings:{APP_ORIGIN:origin,WORKSPACE_IDS:JSON.stringify(fixtures.map(f=>f.workspace)),REQUEST_TIMEOUT_MS:'5000',BODY_TIMEOUT_MS:'2000',PROVIDER_CONFIG:JSON.stringify({issuer,jwksUrl:`${issuer}/cdn-cgi/access/certs`,humanAudience:'access-app',machineAudience:'machine-app',jwksCacheMs:60000,jwksTimeoutMs:500})},durableObjects:{WORKSPACE:{className:'WorkspaceService',useSQLite:true}}});await mf.ready;
 for(const f of fixtures){const db=await storage(f);await db.exec('INSERT INTO workspace VALUES(?,?,1,0)',f.workspace,f.epoch);await db.exec('INSERT INTO membership VALUES(?,?,0,1)',f.actor,f.kind);await db.exec('INSERT INTO credential VALUES(?,?,?,0,1,1)',f.credential,f.actor,Date.now()+7200000);await db.exec('INSERT INTO identity_binding VALUES(?,?,?,?,?)',issuer,`${f.kind}-subject`,f.credential,f.actor,f.kind);await db.exec('INSERT INTO project VALUES(?,?,1,0)',f.project,'Content project');await db.exec('INSERT INTO project_grant VALUES(?,?,1,1)',f.actor,f.project);for(const scope of ['operations:read_own','issue:read','issue:write','comment:write','history:read']){await db.exec('INSERT INTO principal_scope VALUES(?,?)',f.actor,scope);await db.exec('INSERT INTO credential_scope VALUES(?,?)',f.credential,scope);}}
});
after(async()=>{await mf?.dispose();});
for(const f of fixtures.slice(0,2))test(`${f.kind}: create/body/comment/readback retain source, IDs, versions and separate receipt/current state`,async()=>{
 const c=create(f);let r=await post(f,c);assert.equal(r.status,200,await r.clone().text());const receipt=await r.json();assert.equal(receipt.data.committedVersion,1);assert.equal(receipt.meta.actorId,f.actor);
 assert.deepEqual(await (await post(f,c)).json(),receipt);assert.deepEqual(await (await get(f,`operations/${c.operationId}`)).json(),receipt);
 const projects=await (await get(f,'projects')).json();assert.equal(projects.data.items[0].id,f.project);assert.equal((await (await get(f,`projects/${f.project}`)).json()).data.title,'Content project');
 const initial=await (await get(f,`issues/${f.issue}`)).json();assert.equal(initial.data.description,c.payload.description);assert.equal(initial.data.priority,'P2');assert.equal(initial.data.assigneeId,f.actor);
 const raw='\r\n---\r\nbody: Ω\r\n---\n'+String.raw`\literal **syntax** <script>untrusted</script>`+'\n  trailing spaces  \n';
 const body=command(f,'Issue.UpdateBody',{description:raw},1);r=await post(f,body);assert.equal(r.status,200,await r.clone().text());const second=await r.json();assert.equal(second.data.committedVersion,2);
 const noop=command(f,'Issue.UpdateBody',{description:raw},2);const none=await (await post(f,noop)).json();assert.equal(none.data.effectApplied,false);assert.equal(none.data.committedVersion,2);
 const commentId=randomUUID(),comment=command(f,'Issue.AddComment',{commentId,bodyMarkdown:raw},2);assert.equal((await post(f,comment)).status,200);
 const edit=command(f,'Issue.EditComment',{commentId,expectedCommentVersion:1,bodyMarkdown:raw+'edited'},1,commentId);r=await post(f,edit);assert.equal(r.status,200,await r.clone().text());const edited=await r.json();assert.equal(edited.data.entityId,commentId);assert.equal(edited.data.committedVersion,2);assert.deepEqual(await (await get(f,`operations/${edit.operationId}`)).json(),edited);
 const entries=await (await get(f,`issues/${f.issue}/entries`)).json();assert.equal(entries.data.items[0].bodyMarkdown,raw+'edited');assert.equal(entries.data.items[0].authorRef.principalId,f.actor);
 const current=await (await get(f,`issues/${f.issue}`)).json();assert.equal(current.data.description,raw);assert.equal(current.data.version,3);assert.equal(current.data.bodyRevisionId,second.data.revisionId);
 const revisions=await (await get(f,`issues/${f.issue}/revisions`)).json();assert.equal(revisions.data.items.length,4);assert.equal((await (await get(f,`issues/${f.issue}/revisions/${receipt.data.revisionId}`)).json()).data.contentMarkdown,c.payload.description);
 const stale=command(f,'Issue.UpdateBody',{description:'stale body'},1);r=await post(f,stale);assert.equal(r.status,409);const conflict=await r.json();assert.equal(conflict.error.effectApplied,false);assert.deepEqual(await (await post(f,stale)).json(),conflict);assert.equal((await (await get(f,`issues/${f.issue}`)).json()).data.description,raw);
 const db=await storage(f);assert.equal((await db.exec('SELECT count(*) AS n FROM issue'))[0].n,1);assert.equal((await db.exec('SELECT count(*) AS n FROM content_revision'))[0].n,4);
 // Outcome receipts remain available without history:read, but historic source does not.
 await db.exec("DELETE FROM credential_scope WHERE credential_id=? AND scope='history:read'",f.credential);assert.equal((await get(f,`issues/${f.issue}/revisions`)).status,403);assert.equal((await get(f,`operations/${edit.operationId}`)).status,200);assert.equal((await get(f,`issues/${f.issue}/entries`)).status,200);
 await db.exec("UPDATE resource_access SET mode='restricted',reader_principal_ids='[]',writer_principal_ids='[]'");for(const path of [`issues/${f.issue}`,`issues/${f.issue}/entries`,`issues/${f.issue}/revisions`])assert.equal((await get(f,path)).status,404);assert.equal((await get(f,`operations/${edit.operationId}`)).status,403);
});
test('full Markdown limit crosses actual product HTTP/workerd intact; oversized input rejects before effects',async()=>{
 const f=fixtures[2],raw='\t'.repeat(256*1024),c=create(f,raw);let r=await post(f,c);assert.equal(r.status,200,await r.clone().text());assert.equal((await (await get(f,`issues/${f.issue}`)).json()).data.description,raw);
 const tooLarge=command(f,'Issue.UpdateBody',{description:raw+'x'},1);r=await post(f,tooLarge);assert.equal(r.status,400);assert.equal((await r.json()).error.code,'BODY_TOO_LARGE');const db=await storage(f);assert.equal((await db.exec('SELECT count(*) AS n FROM content_revision'))[0].n,1);assert.equal((await db.exec('SELECT count(*) AS n FROM operation'))[0].n,1);
});
