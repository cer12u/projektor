import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync,sign} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {Miniflare,createFetchMock} from 'miniflare';
const issuer='https://legacy-auth.invalid',origin='https://legacy-product.invalid';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048}),key={...publicKey.export({format:'jwk'}),kid:'synthetic',alg:'RS256',use:'sig'};
const workspace=randomUUID(),epoch=randomUUID(),project=randomUUID(),destination=randomUUID(),unmapped=randomUUID();
const actors=['human','machine'].map(kind=>({kind,principal:randomUUID(),credential:randomUUID()}));
const projects=[{projectId:project,key:'SYNTH',slug:'synthetic-project'},{projectId:destination,key:'DEST',slug:'destination-project'}];
let mf,db;
function jwt(a){const now=Math.floor(Date.now()/1000),claims={iss:issuer,aud:[a.kind==='human'?'human':'machine'],sub:a.kind==='human'?'human-subject':'',...(a.kind==='machine'?{common_name:'machine-subject'}:{}),type:'app',iat:now-2,nbf:now-2,exp:now+3600};const h=Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT',kid:key.kid})).toString('base64url'),p=Buffer.from(JSON.stringify(claims)).toString('base64url');return `${h}.${p}.${sign('RSA-SHA256',Buffer.from(`${h}.${p}`),privateKey).toString('base64url')}`;}
const headers=a=>a.kind==='human'?{'cf-access-jwt-assertion':jwt(a),origin,'x-projektor-csrf':'same-origin'}:{authorization:`Bearer ${jwt(a)}`};
const url=(a,path)=>`${origin}/${a.kind==='machine'?'machine/':''}v1/workspaces/${workspace}/${path}`;
const command=(entityId,commandType,payload,expectedVersion)=>({schemaVersion:1,workspaceId:workspace,workspaceEpoch:epoch,operationId:randomUUID(),entityId,commandType,payload,expectedVersion});
const post=(a,c)=>mf.dispatchFetch(url(a,'commands'),{method:'POST',headers:{...headers(a),'content-type':'application/json','idempotency-key':c.operationId},body:JSON.stringify(c)});
const read=(a,path,extra='')=>mf.dispatchFetch(url(a,path)+`?workspaceEpoch=${epoch}${extra}`,{headers:headers(a)});
const resolve=(a,path,epochValue=epoch)=>mf.dispatchFetch(url(a,'legacy-url')+'?'+new URLSearchParams({workspaceEpoch:epochValue,path}),{headers:headers(a)});
const importUrls=batch=>mf.dispatchFetch(origin+'/__fixture/import',{method:'POST',body:JSON.stringify({workspaceId:workspace,batch})}).then(r=>r.json());
const rowCount=async table=>(await db.exec('SELECT count(*) n FROM '+table))[0].n;
async function createIssue(a=actors[0],projectId=project){const id=randomUUID(),r=await post(a,command(id,'Issue.Create',{projectId,title:'Synthetic original',description:'Raw source\r\n[[unresolved]]\n[legacy](/wiki/old)',assigneeId:null,priority:null,parentId:null,initialStatus:'ready'},0));assert.equal(r.status,200,await r.clone().text());return {id,number:(await db.exec('SELECT number FROM issue_number WHERE issue_id=?',id))[0].number};}
async function createWiki(slug,scope={kind:'project',projectId:project}){const id=randomUUID(),r=await post(actors[0],command(id,'Wiki.Create',{pageId:id,scope,parentId:null,title:'Synthetic '+id,slug,contentMarkdown:'Raw\r\n[[historical decision]]'},0));assert.equal(r.status,200,await r.clone().text());return id;}
async function success(a,path,kind,id){const r=await resolve(a,path);assert.equal(r.status,200,await r.clone().text());const value=await r.json();assert.deepEqual(value,{data:{kind,id,canonicalPath:`/?view=${{issue:'issue',wiki:'wiki-page',project:'project'}[kind]}&workspaceId=${workspace}&${{issue:'issueId',wiki:'pageId',project:'projectId'}[kind]}=${id}`},meta:{workspaceId:workspace,workspaceEpoch:epoch,actorId:a.principal}});return value;}
async function missing(a,path){const r=await resolve(a,path);assert.equal(r.status,404,await r.clone().text());assert.deepEqual(await r.json(),{error:{code:'NOT_FOUND',outcome:'unknown',retryable:false}});}
before(async()=>{
 const mock=createFetchMock();mock.disableNetConnect();mock.get(issuer).intercept({path:'/certs'}).reply(200,JSON.stringify({keys:[key]}),{headers:{'content-type':'application/json'}}).persist();
 mf=new Miniflare({cf:false,fetchMock:mock,unsafeInspectDurableObjects:true,name:'legacy-product',modules:true,scriptPath:new URL('./legacy-url-fixture.mjs',import.meta.url).pathname,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],modulesRules:[{type:'Text',include:['**/*.sql'],fallthrough:true}],bindings:{APP_ORIGIN:origin,WORKSPACE_IDS:JSON.stringify([workspace]),REQUEST_TIMEOUT_MS:'5000',BODY_TIMEOUT_MS:'2000',PROVIDER_CONFIG:JSON.stringify({issuer,jwksUrl:issuer+'/certs',humanAudience:'human',machineAudience:'machine',jwksCacheMs:60000,jwksTimeoutMs:500})},durableObjects:{WORKSPACE:{className:'LegacyUrlFixture',useSQLite:true}}});await mf.ready;db=await mf.unsafeGetDurableObjectStorage('legacy-product','LegacyUrlFixture',{name:workspace});
 await db.exec('INSERT INTO workspace VALUES(?,?,1,0)',workspace,epoch);
 for(const p of [project,destination,unmapped])await db.exec('INSERT INTO project VALUES(?,?,1,0)',p,'Synthetic project');
 for(const a of actors){await db.exec('INSERT INTO membership VALUES(?,?,0,1)',a.principal,a.kind);await db.exec('INSERT INTO credential VALUES(?,?,?,0,1,1)',a.credential,a.principal,Date.now()+3600000);await db.exec('INSERT INTO identity_binding VALUES(?,?,?,?,?)',issuer,a.kind+'-subject',a.credential,a.principal,a.kind);for(const p of [project,destination,unmapped])await db.exec('INSERT INTO project_grant VALUES(?,?,1,1)',a.principal,p);await db.exec('INSERT INTO shared_grant VALUES(?,1,1)',a.principal);await db.exec('INSERT INTO scope_manage_grant VALUES(?,?,?,1)',a.principal,'project',project);for(const s of ['operations:read_own','wiki:read','wiki:write','wiki:trash','wiki:restore','history:read','deleted:read','issue:read','issue:write']){await db.exec('INSERT INTO principal_scope VALUES(?,?)',a.principal,s);await db.exec('INSERT INTO credential_scope VALUES(?,?)',a.credential,s);}}
 assert.deepEqual(await importUrls({projects}),{data:{importedProjects:2}});
});
after(async()=>await mf?.dispose());
test('offline additive upgrade matches fresh schema objects exactly',()=>{
 const schema=readFileSync(new URL('../src/schema.sql',import.meta.url),'utf8'),upgrade=readFileSync(new URL('../scripts/legacy-url-upgrade.sql',import.meta.url),'utf8').split('\n').slice(1).join('\n');assert.ok(schema.endsWith(upgrade));
 const fresh=new DatabaseSync(':memory:'),upgraded=new DatabaseSync(':memory:');try{fresh.exec(schema);upgraded.exec(schema.slice(0,-upgrade.length));upgraded.exec(upgrade);const objects=db=>db.prepare("SELECT name,sql FROM sqlite_master WHERE name LIKE '%project_url%' ORDER BY name").all();assert.deepEqual(objects(upgraded),objects(fresh));}finally{fresh.close();upgraded.close();}
});
test('same Store importer rejects collisions atomically, replays without overwriting native edits, and protects baselines',async()=>{
 const first={projectId:unmapped,key:'FRESH',slug:'fresh-project'},before=await rowCount('project_url'),collision=randomUUID();
 await db.exec('INSERT INTO project VALUES(?,?,1,0)',collision,'Synthetic collision');
 for(const conflicting of [{projectId:collision,key:'SYNTH',slug:'unique-slug'},{projectId:collision,key:'UNIQUE',slug:'synthetic-project'},{projectId:project,key:'CHANGED',slug:'changed'},{projectId:randomUUID(),key:'MISSING',slug:'missing-target'}]){const result=await importUrls({projects:[first,conflicting]});assert.ok(result.error);assert.equal(result.outcome,'not_committed');assert.equal(await rowCount('project_url'),before);}
 await db.exec("CREATE TRIGGER fixture_suppress_url BEFORE INSERT ON project_url WHEN NEW.project_key='SUPPRESS' BEGIN SELECT RAISE(IGNORE); END");
 assert.equal((await importUrls({projects:[first,{projectId:collision,key:'SUPPRESS',slug:'suppressed'}]})).outcome,'not_committed');assert.equal(await rowCount('project_url'),before);await db.exec('DROP TRIGGER fixture_suppress_url');
 for(const invalid of [{projects:[projects[0],projects[0]]},{projects:[first,{...first,projectId:randomUUID()}]},{projects:[{...first,extra:true}]},{projects:Array(101).fill(first)},{projects:[],extra:true},{projects:[{...first,key:'../bad'}]},{projects:[{...first,key:'lowercase'}]}])assert.ok((await importUrls(invalid)).error);
 await db.exec('UPDATE project_url SET project_key=? WHERE project_id=?','RENAMED',project);await db.exec('UPDATE project SET title=? WHERE id=?','Renamed title',project);
 assert.deepEqual(await importUrls({projects}),{data:{importedProjects:2}});assert.equal((await db.exec('SELECT project_key FROM project_url WHERE project_id=?',project))[0].project_key,'RENAMED');
 const renamedIssue=await createIssue();await missing(actors[0],`/projects/SYNTH/issues/${renamedIssue.number}/old`);await success(actors[0],`/projects/RENAMED/issues/${renamedIssue.number}/old`,'issue',renamedIssue.id);await success(actors[0],'/projects/view/synthetic-project','project',project);
 await assert.rejects(db.exec('UPDATE project_url SET import_baseline_json=? WHERE project_id=?','{}',project));await assert.rejects(db.exec('DELETE FROM project_url WHERE project_id=?',project));
 await db.exec('INSERT INTO project_url VALUES(?,?,?,NULL)',unmapped,'NATIVE','native-project');assert.ok((await importUrls({projects:[{projectId:unmapped,key:'NATIVE',slug:'native-project'}]})).error);assert.equal((await db.exec('SELECT import_baseline_json FROM project_url WHERE project_id=?',unmapped))[0].import_baseline_json,null);
 await db.exec('UPDATE project_url SET project_key=? WHERE project_id=?','SYNTH',project);
});
for(const a of actors)test(`${a.kind}: authenticated production route uses imported key/slug, number, and exact session metadata`,async()=>{
 const i=await createIssue(a);await success(a,`/projects/SYNTH/issues/${i.number}/any-cosmetic-title`,'issue',i.id);await success(a,`/projects/SYNTH/issues/${i.number}/`,'issue',i.id);await success(a,'/projects/view/synthetic-project','project',project);
 const data=await(await read(a,'projects/'+project)).json();assert.equal(data.data.key,'SYNTH');assert.equal(data.data.slug,'synthetic-project');assert.equal(data.data.title,'Renamed title');
 const native=randomUUID();await db.exec('INSERT INTO project VALUES(?,?,1,0)',native,'Unmapped native');await db.exec('INSERT INTO project_grant VALUES(?,?,1,1)',a.principal,native);const n=await(await read(a,'projects/'+native)).json();assert.equal(n.data.key,null);assert.equal(n.data.slug,null);
 const actor={workspaceId:workspace,principalId:a.principal,credentialId:a.credential,credentialExpiresAt:Date.now()+3600000,actorKind:a.kind},args={workspaceId:workspace,workspaceEpoch:epoch,path:`/projects/SYNTH/issues/${i.number}/direct`};const direct=await(await mf.dispatchFetch(origin+'/__fixture/query',{method:'POST',body:JSON.stringify({actor,args})})).json();assert.equal(direct.data.id,i.id);
});
test('actual move retains Issue stable ID, source and current scope ACL, and never changes stored raw content or bindings',async()=>{
 const a=actors[0],i=await createIssue(),raw=(await db.exec('SELECT id,content_markdown FROM content_revision ORDER BY id')),bindings=await db.exec('SELECT * FROM link_binding ORDER BY id');
 const moved=await post(a,command(i.id,'Issue.MoveTree',{payloadVersion:1,targetProjectId:destination,targets:[{id:i.id,expectedVersion:1}]},1));assert.equal(moved.status,200,await moved.clone().text());const path=`/projects/SYNTH/issues/${i.number}/historic-title`;await success(a,path,'issue',i.id);
 assert.deepEqual(await db.exec('SELECT id,content_markdown FROM content_revision ORDER BY id'),raw);assert.deepEqual(await db.exec('SELECT * FROM link_binding ORDER BY id'),bindings);
 for(const scope of [project,destination]){await db.exec('UPDATE project_grant SET can_read=0 WHERE principal_id=? AND project_id=?',a.principal,scope);await missing(a,path);await db.exec('UPDATE project_grant SET can_read=1 WHERE principal_id=? AND project_id=?',a.principal,scope);}
 await db.exec("UPDATE resource_access SET mode='restricted',reader_principal_ids='[]',writer_principal_ids='[]' WHERE resource_type='issue' AND resource_id=?",i.id);await missing(a,path);await db.exec("UPDATE resource_access SET mode='inherit' WHERE resource_type='issue' AND resource_id=?",i.id);
 await db.exec('UPDATE issue SET deleted=1 WHERE id=?',i.id);await missing(a,path);
});
test('Wiki exact live workspace slug wins globally; hidden/ambiguous direct page cannot fall through aliases',async()=>{
 const a=actors[0],old=await createWiki('旧い-guide');await success(a,'/wiki/'+encodeURIComponent('旧い-guide'),'wiki',old);
 assert.equal((await post(a,command(old,'Wiki.Rename',{title:'Renamed',slug:'current-guide'},1))).status,200);await success(a,'/wiki/'+encodeURIComponent('旧い-guide'),'wiki',old);
 const direct=await createWiki('旧い-guide',{kind:'workspace_shared'});await success(a,'/wiki/'+encodeURIComponent('旧い-guide'),'wiki',direct);
 await db.exec("UPDATE resource_access SET mode='restricted',reader_principal_ids='[]',writer_principal_ids='[]' WHERE resource_type='wiki' AND resource_id=?",direct);await missing(a,'/wiki/'+encodeURIComponent('旧い-guide'));
 await db.exec("UPDATE resource_access SET mode='inherit' WHERE resource_type='wiki' AND resource_id=?",direct);
 const duplicate=await createWiki('duplicate-guide',{kind:'project',projectId:destination});await db.exec('UPDATE wiki_page SET slug=? WHERE id=?','旧い-guide',duplicate);await missing(a,'/wiki/'+encodeURIComponent('旧い-guide'));await db.exec('UPDATE wiki_page SET deleted_at=? WHERE id=?',Date.now(),duplicate);
 await db.exec('UPDATE wiki_page SET deleted_at=? WHERE id=?',Date.now(),direct);await missing(a,'/wiki/'+encodeURIComponent('旧い-guide')); // Persisted aliases in two scopes remain ambiguous.
 await db.exec('UPDATE wiki_page SET deleted_at=? WHERE id=?',Date.now(),old);await missing(a,'/wiki/current-guide');
});
test('Wiki alias ambiguity and source-scope/current-scope restrictions fail closed, without inferred cross-scope guesses',async()=>{
 const a=actors[0],one=await createWiki('old-one'),two=await createWiki('old-two',{kind:'project',projectId:destination});
 assert.equal((await post(a,command(one,'Wiki.Rename',{title:'New one',slug:'new-one'},1))).status,200);
 assert.equal((await post(a,command(one,'Wiki.MoveTree',{targetScope:{kind:'workspace_shared'},targetParentId:null,targets:[{id:one,expectedVersion:2}]},2))).status,200);await success(a,'/wiki/old-one','wiki',one);
 await db.exec('UPDATE project_grant SET can_read=0 WHERE principal_id=? AND project_id=?',a.principal,project);await missing(a,'/wiki/old-one');await db.exec('UPDATE project_grant SET can_read=1 WHERE principal_id=? AND project_id=?',a.principal,project);
 await db.exec('UPDATE shared_grant SET can_read=0 WHERE principal_id=?',a.principal);await missing(a,'/wiki/old-one');await db.exec('UPDATE shared_grant SET can_read=1 WHERE principal_id=?',a.principal);
 await db.exec('INSERT INTO wiki_alias VALUES(?,?,?,?,?,?,?,NULL)',randomUUID(),JSON.stringify({kind:'project',projectId:destination}),'slug','old-one','old-one',two,Date.now());await missing(a,'/wiki/old-one');
 await db.exec("UPDATE resource_access SET mode='restricted',reader_principal_ids='[]',writer_principal_ids='[]' WHERE resource_type='wiki' AND resource_id=?",two);await missing(a,'/wiki/old-one');
 const relative='/wiki/legacy-only';await db.exec('INSERT INTO wiki_alias VALUES(?,?,?,?,?,?,?,NULL)',randomUUID(),JSON.stringify({kind:'workspace_shared'}),'legacy_url',relative,relative,one,Date.now());await success(a,relative,'wiki',one);await missing(a,'https://other.invalid'+relative);
});
test('malformed/unknown paths have uniform NOT_FOUND after auth; auth, epoch and HTTP envelope checks remain enforced',async()=>{
 const a=actors[0],valid='/projects/view/synthetic-project';
 for(const path of ['https://legacy.invalid'+valid,'//legacy.invalid'+valid,'/wiki/%','/wiki/%E0%A4%A','/wiki/%2e%2e','/wiki/../synthetic','/wiki/%2fsecret','/wiki/%5csecret','/wiki/%00','/wiki/a?secret=1','/wiki/a#secret','/wiki/a/b','/projects/SYNTH/issues/01/cosmetic','/projects/SYNTH/issues/9007199254740992/a','/projects/SYNTH/issues/1000000000/a','/projects/synth/issues/1/a','/projects/%53YNTH/issues/1/a','/projects/SYNTH/issues/1/Uppercase','/projects/SYNTH/issues/1/a/b','/projects/SYNTH/issues/1/%','/projects/SYNTH/issues/1/..','/projects/view/missing','/wiki/unknown','/projects/OLD/issues/1/x','/wiki/'+'x'.repeat(16385)])await missing(a,path);
 let r=await mf.dispatchFetch(url(a,'legacy-url')+'?'+new URLSearchParams({workspaceEpoch:epoch,path:'/wiki/%'}));assert.equal(r.status,401);
 r=await resolve(a,valid,randomUUID());assert.equal(r.status,409);assert.equal((await r.json()).error.code,'EPOCH_MISMATCH');
 for(const suffix of ['',`&path=${encodeURIComponent(valid)}&path=${encodeURIComponent(valid)}`,`&path=${encodeURIComponent(valid)}&actorId=${a.principal}`]){r=await read(a,'legacy-url',suffix);assert.equal(r.status,400);}
 await db.exec('UPDATE credential SET can_read=0 WHERE id=?',a.credential);await missing(a,valid);await db.exec('UPDATE credential SET can_read=1 WHERE id=?',a.credential);
 await db.exec('UPDATE project SET deleted=1 WHERE id=?',project);await missing(a,valid);await db.exec('UPDATE project SET deleted=0 WHERE id=?',project);
 r=await mf.dispatchFetch(url(a,'legacy-url')+'?'+new URLSearchParams({workspaceEpoch:epoch,path:valid}),{method:'POST',headers:headers(a)});assert.equal(r.status,405);
});
