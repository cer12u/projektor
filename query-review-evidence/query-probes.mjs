import { denyOutbound } from '../experiments/atomic-command-poc/test-support/offline.mjs';
// Independent assertions against the shared query and real SQLite runtimes.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {openStore,migrate,queryIssues,executeCommand,operationGet} from '../experiments/atomic-command-poc/src/core.mjs';
import {queryMyIssues} from '../experiments/atomic-command-poc/src/my-issues.mjs';
const req=createRequire(new URL('../experiments/atomic-command-poc/package.json',import.meta.url));
const runtime=process.env.REVIEW_RUNTIME??'node';
const now=1800000000000;
const id=n=>`90000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const ids={workspace:id(1),epoch:id(2),actor:id(3),credential:id(4),project:id(5),human:id(6),humanCredential:id(7),hiddenProject:id(8)};
const actor={principalId:ids.actor,credentialId:ids.credential,workspaceId:ids.workspace,actorKind:'machine',credentialExpiresAt:now+3600000};
const human={...actor,principalId:ids.human,credentialId:ids.humanCredential,actorKind:'human'};
const args={workspaceId:ids.workspace,workspaceEpoch:ids.epoch};
let mf;
before(async()=>{if(runtime==='workerd'){const {Miniflare}=req('miniflare');mf=new Miniflare({cf:false,fetchMock:denyOutbound(),modules:true,scriptPath:new URL('./workerd-fixture.mjs',import.meta.url).pathname,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],modulesRules:[{type:'Text',include:['**/*.sql'],fallthrough:true}],durableObjects:{WORKSPACE:{className:'ReviewWorkspace',useSQLite:true}}});await mf.ready;}});
after(async()=>{await mf?.dispose();});
async function setup(t) {
 let invoke;
 if(runtime==='workerd') {const object=randomUUID();invoke=async(action,...args)=>{const r=await mf.dispatchFetch('http://review.invalid',{method:'POST',body:JSON.stringify({object,action,args})});const value=await r.json();if(!r.ok)throw Error(value.reviewFixtureError);return value;};}
 else {const db=openStore(':memory:');migrate(db);t.after(()=>db.close());invoke=async(action,...a)=>{if(action==='sql')return db.prepare(a[0]).all(...(a[1]??[])).map(r=>({...r}));if(action==='query')return queryMyIssues(db,...a);if(action==='detail')return queryIssues(db,...a);if(action==='command')return executeCommand(db,a[0],a[1],{now:a[2]});if(action==='receipt')return operationGet(db,...a);throw Error(action);};}
 const sql=(q,...a)=>invoke('sql',q,a);
 await sql('INSERT INTO workspace VALUES(?,?,1,0)',ids.workspace,ids.epoch);
 for(const who of [actor,human]) {await sql('INSERT INTO membership VALUES(?,?,0,1)',who.principalId,who.actorKind);await sql('INSERT INTO credential VALUES(?,?,?,0,1,1)',who.credentialId,who.principalId,who.credentialExpiresAt);await sql('INSERT INTO project_grant VALUES(?,?,1,1)',who.principalId,ids.project);}
 const add=async(n,{principal=ids.actor,project=ids.project,status='backlog',priority=1,created=100,restricted=0,deleted=0}={})=>{const issue=id(1000+n);await sql('INSERT INTO issue VALUES(?,?,?,1,?)',issue,project,`review title ${n}`,deleted);await sql('INSERT INTO issue_queue VALUES(?,?,?,?,?,?)',issue,principal,status,priority,created,restricted);return issue;};
 return {invoke,sql,add,query:(q={},who=actor,at=now)=>invoke('query',who,{...args,...q},at),detail:(issue,who=actor)=>invoke('detail',who,{...args,entityId:issue},now),command:(issue,who=actor)=>{const c={schemaVersion:1,...args,operationId:randomUUID(),commandType:'Issue.UpdateTitle',entityId:issue,expectedVersion:1,payload:{title:'independently updated'}};return invoke('command',who,c,now).then(r=>({c,r}));}};
}
const ok=r=>{assert.equal(r.error,undefined,JSON.stringify(r));return r;};

test(`${runtime}: authorized empty is a successful explicit zero`,async t=>{const f=await setup(t);const r=ok(await f.query());assert.deepEqual(r.data,{items:[],nextCursor:null,total:0});assert.equal(r.meta.actorId,ids.actor);assert.equal(r.meta.refreshRequired,false);});

test(`${runtime}: machine me never aliases human owner`,async t=>{const f=await setup(t);const m=await f.add(1),h=await f.add(2,{principal:ids.human});assert.deepEqual(ok(await f.query()).data.items.map(x=>x.id),[m]);const result=ok(await f.query({},human));assert.deepEqual(result.data.items.map(x=>x.id),[h]);assert.equal(result.data.items[0].assignee_kind,'human');});

test(`${runtime}: unresolved is status category and all is server-side`,async t=>{const f=await setup(t);for(const [i,status] of ['backlog','ready','in_progress','blocked','done','canceled'].entries())await f.add(i,{status});assert.equal(ok(await f.query()).data.total,4);assert.equal(ok(await f.query({status:'all'})).data.total,6);});

test(`${runtime}: stable keyset visits priority and timestamp ties exactly once`,async t=>{const f=await setup(t);const source=[];for(let n=0;n<137;n++){const priority=n%6===5?null:n%6,created=100+(n%3);source.push({id:await f.add(n,{priority,created}),priority,created});}source.sort((a,b)=>(a.priority??5)-(b.priority??5)||a.created-b.created||a.id.localeCompare(b.id));let cursor,seen=[];for(let page=0;page<20;page++){const r=ok(await f.query({limit:9,...(cursor?{cursor}:{})}));assert.equal(r.data.total,137);assert.equal(r.meta.refreshRequired,false);seen.push(...r.data.items.map(x=>x.id));cursor=r.data.nextCursor;if(cursor===null)break;}assert.equal(cursor,null);assert.deepEqual(seen,source.map(x=>x.id));assert.equal(new Set(seen).size,137);});

test(`${runtime}: default 50 and maximum 100 are bounded`,async t=>{const f=await setup(t);for(let n=0;n<102;n++)await f.add(n);assert.equal(ok(await f.query()).data.items.length,50);assert.equal(ok(await f.query({limit:100})).data.items.length,100);for(const limit of [0,-1,101,1.5,'3',...(runtime==='node'?[NaN,Infinity]:[])]){const r=await f.query({limit});assert.ok(r.error,`limit ${limit}`);}});

test(`${runtime}: hidden rows do not consume page slots or count`,async t=>{const f=await setup(t);for(let n=0;n<110;n++)await f.add(n,{project:ids.hiddenProject,priority:0});const visible=await f.add(200,{priority:4});const r=ok(await f.query({limit:1}));assert.deepEqual(r.data.items.map(x=>x.id),[visible]);assert.equal(r.data.total,1);assert.equal(r.data.nextCursor,null);});

test(`${runtime}: inaccessible and absent project filters are indistinguishable`,async t=>{const f=await setup(t);await f.add(1,{project:ids.hiddenProject});const hidden=ok(await f.query({projectId:ids.hiddenProject})),absent=ok(await f.query({projectId:id(999)}));assert.deepEqual(hidden.data,absent.data);assert.equal(hidden.data.total,0);});

test(`${runtime}: resource read intersection gates list, count, detail and mutation`,async t=>{const f=await setup(t);const hidden=await f.add(1,{restricted:1});assert.equal(ok(await f.query()).data.total,0);assert.equal((await f.detail(hidden)).error.code,'NOT_FOUND');assert.equal((await f.command(hidden)).r.error.code,'NOT_FOUND');await f.sql('INSERT INTO issue_read_grant VALUES(?,?,1)',hidden,ids.actor);assert.equal(ok(await f.query()).data.total,1);assert.equal(ok(await f.detail(hidden)).data.id,hidden);});

test(`${runtime}: restricted read alone never grants title write`,async t=>{const f=await setup(t);const issue=await f.add(1,{restricted:1});await f.sql('INSERT INTO issue_read_grant VALUES(?,?,1)',issue,ids.actor);const {r}=await f.command(issue);assert.equal(r.error?.code,'FORBIDDEN',JSON.stringify(r));assert.equal((await f.detail(issue)).data.version,1);});

test(`${runtime}: revoked current resource hides a previous committed receipt`,async t=>{const f=await setup(t);const issue=await f.add(1);const {c,r}=await f.command(issue);assert.equal(r.data.outcome,'committed');await f.sql('UPDATE issue_queue SET restricted_read=1 WHERE issue_id=?',issue);const receipt=await f.invoke('receipt',actor,{...args,operationId:c.operationId},now);assert.equal(receipt.error.code,'FORBIDDEN');assert.equal(receipt.data,undefined);});

test(`${runtime}: current credential and membership denial are not empty`,async t=>{for(const statement of ['UPDATE credential SET can_read=0','UPDATE credential SET revoked=1','UPDATE membership SET revoked=1']){const f=await setup(t);await f.add(1);await f.sql(statement);const r=await f.query();assert.equal(r.error.code,'FORBIDDEN');assert.equal(r.data,undefined);}});

test(`${runtime}: malformed query never falls back to unfiltered success`,async t=>{const f=await setup(t);await f.add(1);for(const bad of [{unexpected:true},{workspaceId:''},{workspaceEpoch:''},{status:'open'},{status:null},{limit:null},{projectId:''},{cursor:''},{cursor:'x'.repeat(2049)},{cursor:7}]){const r=await f.query(bad);assert.equal(r.error.code,'VALIDATION',JSON.stringify(bad));}});

test(`${runtime}: cursor rejects altered filter, limit, actor, epoch and workspace`,async t=>{const f=await setup(t);await f.add(1);await f.add(2);const cursor=ok(await f.query({limit:1})).data.nextCursor;for(const change of [{status:'all'},{projectId:ids.project},{limit:2}])assert.equal((await f.query({limit:1,cursor,...change})).error.code,'CURSOR_INVALID');assert.equal((await f.query({limit:1,cursor},human)).error.code,'CURSOR_INVALID');assert.equal((await f.query({limit:1,cursor,workspaceEpoch:id(800)})).error.code,'EPOCH_MISMATCH');assert.equal((await f.query({limit:1,cursor,workspaceId:id(801)})).error.code,'WORKSPACE_MISMATCH');});

test(`${runtime}: cursor signature and encoding tampering are rejected`,async t=>{const f=await setup(t);await f.add(1);await f.add(2);const cursor=ok(await f.query({limit:1})).data.nextCursor;const [p,s]=cursor.split('.');for(const forged of [cursor+'=',p+'.'+s+'=',p+'.'+(s[0]==='a'?'b':'a')+s.slice(1),'A'+cursor.slice(1),p+'.',p+'.'+s+'.x',p+'\n.'+s])assert.equal((await f.query({limit:1,cursor:forged})).error.code,'CURSOR_INVALID',forged);});

test(`${runtime}: cursor expires at exact bound without disclosing a page`,async t=>{const f=await setup(t);await f.add(1);await f.add(2);const cursor=ok(await f.query({limit:1})).data.nextCursor;assert.equal(ok(await f.query({limit:1,cursor},actor,now+899999)).data.items.length,1);for(const at of [now-1,now+900000]){const r=await f.query({limit:1,cursor},actor,at);assert.equal(r.error.code,'CURSOR_INVALID');assert.equal(r.data,undefined);}});

test(`${runtime}: credential replacement cannot reuse another credential cursor`,async t=>{const f=await setup(t);await f.add(1);await f.add(2);const cursor=ok(await f.query({limit:1})).data.nextCursor;const newCred=id(890);await f.sql('INSERT INTO credential VALUES(?,?,?,0,1,1)',newCred,ids.actor,actor.credentialExpiresAt);assert.equal((await f.query({limit:1,cursor},{...actor,credentialId:newCred})).error.code,'CURSOR_INVALID');});

test(`${runtime}: changes between pages are marked while current count remains accurate`,async t=>{const f=await setup(t);await f.add(1);const second=await f.add(2);const first=ok(await f.query({limit:1}));await f.sql('UPDATE issue_queue SET status_category=? WHERE issue_id=?','done',second);const next=ok(await f.query({limit:1,cursor:first.data.nextCursor}));assert.equal(next.meta.refreshRequired,true);assert.equal(next.data.total,1);assert.deepEqual(next.data.items,[]);assert.equal(next.data.nextCursor,null);});

test(`${runtime}: page-one grant revocation invalidates cursor even without business changeSeq`,async t=>{const f=await setup(t);const firstId=await f.add(1);await f.add(2);const first=ok(await f.query({limit:1}));await f.sql('UPDATE issue_queue SET restricted_read=1 WHERE issue_id=?',firstId);const next=ok(await f.query({limit:1,cursor:first.data.nextCursor}));assert.equal(next.meta.changeSeq,first.meta.changeSeq);assert.ok(next.meta.visibilityVersion>first.meta.visibilityVersion);assert.equal(next.meta.refreshRequired,true);assert.equal(next.data.total,1);assert.equal((await f.detail(firstId)).error.code,'NOT_FOUND');});

test(`${runtime}: queue/principal/project/credential/issue mutations all invalidate visibility`,async t=>{for(const statement of ['UPDATE issue SET title=title','UPDATE issue_queue SET priority=priority','UPDATE membership SET kind=kind','UPDATE project_grant SET can_write=can_write','UPDATE credential SET can_write=can_write']){const f=await setup(t);await f.add(1);await f.add(2);const first=ok(await f.query({limit:1}));await f.sql(statement);assert.equal(ok(await f.query({limit:1,cursor:first.data.nextCursor})).meta.refreshRequired,true,statement);}});

test(`${runtime}: nonexistent queue metadata never fabricates machine assignment`,async t=>{const f=await setup(t);await f.sql('INSERT INTO issue VALUES(?,?,?,1,0)',id(9999),ids.project,'unclassified legacy row');assert.equal(ok(await f.query({status:'all'})).data.total,0);});

test(`${runtime}: invalid stored sort types are rejected by schema`,async t=>{for(const values of [{priority:0.5},{created:1.5},{created:9007199254740992},{priority:5}]){const f=await setup(t);await assert.rejects(()=>f.add(1,values),JSON.stringify(values));}});
