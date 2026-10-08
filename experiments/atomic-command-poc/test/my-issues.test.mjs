import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture,ids,actor,now } from './fixture.mjs';
import { queryMyIssues } from '../src/my-issues.mjs';
async function setup(){const f=fixture();return {sql:(sql,args=[])=>f.db.prepare(sql).run(...args),query:(q,a=actor)=>queryMyIssues(f.db,a,q,now),close:f.close};}

const args={workspaceId:ids.workspace,workspaceEpoch:ids.epoch};
async function add(f,{id=randomUUID(),assignee=ids.actor,priority=null,status='ready',created=1000,project=ids.project,restricted=0,deleted=0}={}) {
 await f.sql('INSERT INTO issue VALUES(?,?,?,1,?)',[id,project,'日本語 '+id,deleted]);
 await f.sql('INSERT INTO issue_queue VALUES(?,?,?,?,?,?)',[id,assignee,status,priority,created,restricted]);return id;
}
test('empty My Issues is a valid empty page; unassigned legacy row is not invented as mine',async()=>{
 const f=await setup();try {const r=await f.query(args);assert.deepEqual(r.data,{items:[],nextCursor:null,total:0});assert.equal(r.meta.actorId,ids.actor);}finally{await f.close();}
});
for(const count of [1,100,101,1000])test(`keyset traverses ${count} tied rows without loss or duplicates`,async()=>{
 const f=await setup();try {let expected=[];for(let n=0;n<count;n++)expected.push(await add(f,{priority:n%6===5?null:n%6,created:n%3}));
 const all=[];let cursor;do{const r=await f.query({...args,limit:37,...(cursor?{cursor}:{})});assert.equal(r.error,undefined);assert.equal(r.meta.refreshRequired,false);assert.equal(r.data.total,count);all.push(...r.data.items);cursor=r.data.nextCursor;}while(cursor);
 assert.equal(new Set(all.map(x=>x.id)).size,count);assert.deepEqual(all.map(x=>x.id).sort(),expected.sort());assert.deepEqual(all,[...all].sort((a,b)=>(a.priority??5)-(b.priority??5)||a.created_at-b.created_at||a.id.localeCompare(b.id)));}finally{await f.close();}
});
test('assignment is principal-specific: machine never aliases its human owner; category filters null resolution',async()=>{
 const f=await setup();try {const human=randomUUID();await f.sql('INSERT INTO membership VALUES(?,?,0,1)',[human,'human']);await add(f,{assignee:human});await add(f,{assignee:null});await add(f,{status:'done'});await add(f,{status:'canceled'});const mine=await add(f,{status:'blocked'});
 let r=await f.query(args);assert.deepEqual(r.data.items.map(x=>x.id),[mine]);assert.equal(r.data.items[0].assignee_kind,'machine');r=await f.query({...args,status:'all'});assert.equal(r.data.total,3);}finally{await f.close();}
});
test('ACL and live-row predicates precede limit and count; hidden and absent project are indistinguishable',async()=>{
 const f=await setup();try {const hidden=randomUUID(),allowed=await add(f,{priority:4});await add(f,{project:hidden,priority:0});await add(f,{deleted:1,priority:0});const restricted=await add(f,{restricted:1,priority:0});
 let r=await f.query({...args,limit:1});assert.equal(r.data.total,1);assert.equal(r.data.items[0].id,allowed);assert.equal(r.data.nextCursor,null);
 const a=await f.query({...args,projectId:hidden}),b=await f.query({...args,projectId:randomUUID()});assert.deepEqual(a.data,b.data);
 await f.sql('INSERT INTO issue_read_grant VALUES(?,?,1)',[restricted,ids.actor]);r=await f.query(args);assert.equal(r.data.total,2);
 await f.sql('UPDATE issue SET project_id=? WHERE id=?',[hidden,allowed]);r=await f.query(args);assert.deepEqual(r.data.items.map(x=>x.id),[restricted]);}finally{await f.close();}
});
test('cursor signature, actor/credential, filter, epoch and page-size bindings reject tampering',async()=>{
 const f=await setup();try {await add(f);await add(f);const r=await f.query({...args,limit:1}),cursor=r.data.nextCursor;assert.ok(cursor);
 for(const change of [{cursor:cursor+'x'},{cursor:cursor.replace('.', '=.')},{cursor:cursor.slice(0,-3)+'abc'},{cursor,status:'all'},{cursor,limit:2},{cursor,projectId:ids.project}])assert.equal((await f.query({...args,limit:1,...change})).error.code,'CURSOR_INVALID');
 assert.equal((await f.query({...args,workspaceEpoch:randomUUID(),limit:1,cursor})).error.code,'EPOCH_MISMATCH');
 const human=randomUUID(),credential=randomUUID();await f.sql('INSERT INTO membership VALUES(?,?,0,1)',[human,'human']);await f.sql('INSERT INTO credential VALUES(?,?,?,0,1,1)',[credential,human,actor.credentialExpiresAt]);
 assert.equal((await f.query({...args,limit:1,cursor},{...actor,principalId:human,credentialId:credential,actorKind:'human'})).error.code,'CURSOR_INVALID');}finally{await f.close();}
});
test('concurrent changes and ACL revoke signal refresh even without workspace command seq',async()=>{
 const f=await setup();try {const first=await add(f,{priority:0});await add(f,{priority:1});const a=await f.query({...args,limit:1});await f.sql('UPDATE issue SET project_id=? WHERE id=?',[randomUUID(),first]);const b=await f.query({...args,limit:1,cursor:a.data.nextCursor});assert.equal(b.meta.changeSeq,a.meta.changeSeq);assert.equal(b.meta.refreshRequired,true);assert.notEqual(b.meta.visibilityVersion,a.meta.visibilityVersion);assert.equal(b.data.total,1);
 await f.sql('UPDATE credential SET can_read=0 WHERE id=?',[ids.credential]);assert.equal((await f.query(args)).error.code,'FORBIDDEN');}finally{await f.close();}
});
test('strict query limits and types reject protocol-invalid input',async()=>{
 const f=await setup();try {for(const change of [{limit:null},{status:null},{limit:0},{limit:101},{limit:1.5},{limit:'1'},{status:'open'},{assigneeId:ids.actor},{cursor:''},{cursor:'x'.repeat(2049)},{projectId:''}])assert.equal((await f.query({...args,...change})).error.code,'VALIDATION');}finally{await f.close();}
});

test('cursor expires, rejects noncanonical signature and survives store reopen with persisted key',async()=>{
 const f=fixture();try {
 const wrapped={sql:(sql,args=[])=>f.db.prepare(sql).run(...args)};await add(wrapped);await add(wrapped);
 const q={...args,limit:1},cursor=queryMyIssues(f.db,actor,q,now).data.nextCursor;
 assert.equal(queryMyIssues(f.db,actor,{...q,cursor},now+900000).error.code,'CURSOR_INVALID');
 assert.equal(queryMyIssues(f.db,actor,{...q,cursor},now-1).error.code,'CURSOR_INVALID');
 const [payload,sig]=cursor.split('.');assert.equal(queryMyIssues(f.db,actor,{...q,cursor:`${payload}.${sig}=`},now).error.code,'CURSOR_INVALID');
 const {openStore}=await import('../src/core.mjs');const other=openStore(f.path);try {assert.equal(queryMyIssues(other,actor,{...q,cursor},now).data.items.length,1);}finally{other.close();}
 }finally{f.close();}
});
test('storage refuses fractional sort tuples and adapter surfaces preserve exact results',async()=>{
 const f=fixture();try {
 for(const [priority,created] of [[0.5,1],[0,1.5],[0,-1],[0,9007199254740992],[6,0]])assert.throws(()=>f.db.prepare('INSERT INTO issue_queue VALUES(?,?,?,?,?,0)').run(ids.issue,ids.actor,'ready',priority,created));
 f.db.prepare('INSERT INTO issue_queue VALUES(?,?,?,?,?,0)').run(ids.issue,ids.actor,'done',null,1);
 const {restMyIssues,mcpMyIssues}=await import('../src/adapters.mjs');const rest=restMyIssues(f.db,actor,args,now),mcp=mcpMyIssues(f.db,actor,{name:'my_issues',arguments:args},now);assert.equal(rest.status,200);assert.equal(mcp.isError,false);assert.deepEqual(rest.body,mcp.structuredContent);
 const {executeCommand,queryIssues}=await import('../src/shared-core.mjs');const {command}=await import('./fixture.mjs');
 f.db.prepare('UPDATE issue_queue SET restricted_read=1').run();assert.equal(queryIssues(f.db,actor,{...args,entityId:ids.issue},now).error.code,'NOT_FOUND');
 f.db.prepare('INSERT INTO issue_read_grant VALUES(?,?,1)').run(ids.issue,ids.actor);assert.equal(executeCommand(f.db,actor,command(),{now}).error.code,'FORBIDDEN');
 }finally{f.close();}
});
