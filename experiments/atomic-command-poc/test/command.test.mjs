import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { fixture,actor,command,restRequest,ids,now,snapshot } from './fixture.mjs';
import { executeCommand,operationGet,queryIssues,fingerprint,MUTATION_STEPS,openStore } from '../src/core.mjs';
import { restUpdate,mcpUpdate,restOperationGet,mcpOperationGet } from '../src/adapters.mjs';
const execute=(db,c,a=actor,extra={})=>executeCommand(db,a,c,{now,...extra});
const op=c=>({workspaceId:c.workspaceId,workspaceEpoch:c.workspaceEpoch,operationId:c.operationId});
function withDb(fn){return async()=>{const f=fixture();try{await fn(f);}finally{f.close();}};}
test('REST and MCP share exact machine-readable result and one atomic effect',withDb(({db})=>{
 const c=command();const rest=restUpdate(db,actor,restRequest(c),{now});const mcp=mcpUpdate(db,actor,{name:'issue_update_title',arguments:c},{now});
 assert.equal(rest.status,200);assert.equal(mcp.isError,false);assert.deepEqual(rest.body,mcp.structuredContent);
 const s=snapshot(db);assert.equal(s.issue[0].version,8);assert.equal(s.issue[0].title,c.payload.title);assert.equal(s.activity.length,1);assert.equal(s.workspace[0].change_seq,1);assert.equal(s.outbox.length,1);assert.equal(s.operation.length,1);assert.equal(s.issue_fts[0].title,c.payload.title);
 assert.equal(db.prepare("SELECT count(*) n FROM issue_fts WHERE issue_fts MATCH ?").get('"title"').n,1);
}));
test('lost committed response is unknown; lookup and replay do not mutate again',withDb(({db})=>{
 const c=command();const response=restUpdate(db,actor,restRequest(c),{now,dropResponse:true});assert.equal(response.body.error.outcome,'unknown');
 const found=restOperationGet(db,actor,op(c),now);assert.equal(found.body.data.committedVersion,8);
 assert.deepEqual(found.body,mcpOperationGet(db,actor,op(c),now).structuredContent);assert.deepEqual(execute(db,c),found.body);assert.equal(snapshot(db).activity.length,1);
}));
test('historical v8 replay remains distinct from current v9 GET and ignores lost write scope',withDb(({db})=>{
 const c=command();const first=execute(db,c);execute(db,command({expectedVersion:8,payload:{title:'latest'}}));
 db.exec('UPDATE credential SET can_write=0');assert.deepEqual(execute(db,c),first);
 const latest=queryIssues(db,actor,{...op(c),entityId:c.entityId},now);assert.equal(latest.data.version,9);assert.equal(latest.data.title,'latest');
}));
test('same key with different payload, target, version or Unicode is rejected without effects',withDb(({db})=>{
 const c=command();execute(db,c);const before=snapshot(db);
 for(const change of [{payload:{title:'different'}},{entityId:randomUUID()},{expectedVersion:8},{payload:{title:c.payload.title+'\n'}}])assert.equal(execute(db,{...c,...change}).error.code,'KEY_REUSE');
 assert.deepEqual(snapshot(db),before);
}));
test('stale CAS and domain invalid title commit only stable rejected receipts',withDb(({db})=>{
 for(const c of [command({expectedVersion:6}),command({payload:{title:'  '}})]){
 const before=snapshot(db);const result=execute(db,c);assert.ok(result.error);const after=snapshot(db);assert.equal(after.operation.length,before.operation.length+1);
 for(const table of ['issue','activity','workspace','issue_fts','outbox'])assert.deepEqual(after[table],before[table]);
 assert.deepEqual(operationGet(db,actor,op(c),now),result);assert.deepEqual(execute(db,c),result);
 assert.equal(execute(db,{...c,expectedVersion:7,payload:{title:'changed'}}).error.code,'KEY_REUSE');
 }
}));
for(const step of MUTATION_STEPS)test(`injected unexpected exception at ${step} rolls every table back`,withDb(({db})=>{
 const before=snapshot(db);const c=command();const r=restUpdate(db,actor,restRequest(c),{now,fault:s=>{if(s===step)throw new Error('synthetic storage failure');}});
 assert.equal(r.body.attemptOutcome,'not_committed');assert.deepEqual(snapshot(db),before);assert.equal(operationGet(db,actor,op(c),now).data.outcome,'not_observed');assert.equal(execute(db,c).data.committedVersion,8);
}));
test('receipt results are not redisclosed after project, own-receipt, membership or credential revocation',async()=>{
 for(const sql of ['UPDATE project_grant SET can_read=0','UPDATE membership SET read_own=0','UPDATE membership SET revoked=1','UPDATE credential SET revoked=1','UPDATE credential SET can_read=0']){
 const f=fixture();try{const c=command();execute(f.db,c);f.db.exec(sql);assert.equal(execute(f.db,c).error.code,'FORBIDDEN');assert.equal(operationGet(f.db,actor,op(c),now).error.code,'FORBIDDEN');}finally{f.close();}}
});
test('moved or deleted resource requires current and original scope on receipt',withDb(({db})=>{
 const c=command();execute(db,c);const p=randomUUID();db.prepare('UPDATE issue SET project_id=?').run(p);assert.equal(execute(db,c).error.code,'FORBIDDEN');
 db.prepare('INSERT INTO project_grant VALUES(?,?,1,1)').run(ids.actor,p);assert.equal(execute(db,c).data.committedVersion,8);
 db.prepare('UPDATE project_grant SET can_read=0 WHERE project_id=?').run(ids.project);assert.equal(execute(db,c).error.code,'FORBIDDEN');
 db.exec('UPDATE project_grant SET can_read=1; UPDATE issue SET deleted=1');assert.equal(execute(db,c).error.code,'FORBIDDEN');
}));
test('workspace, actor, expiry, epoch and store fence fail closed before mutation',async()=>{
 const cases=[{a:{...actor,workspaceId:randomUUID()},code:'WORKSPACE_MISMATCH'},{a:{...actor,principalId:randomUUID()},code:'UNAUTHENTICATED'},{a:{...actor,credentialExpiresAt:now},code:'EXPIRED'},{c:{workspaceEpoch:randomUUID()},code:'EPOCH_MISMATCH'},{sql:'UPDATE workspace SET active=0',code:'STORE_FENCED'}];
 for(const x of cases){const f=fixture();try{if(x.sql)f.db.exec(x.sql);const before=snapshot(f.db);assert.equal(execute(f.db,command(x.c),x.a??actor).error.code,x.code);assert.deepEqual(snapshot(f.db),before);}finally{f.close();}}
});
test('other valid actor cannot retrieve first actor operation; operation namespace is principal-scoped',withDb(({db})=>{
 const c=command();execute(db,c);const other={...actor,principalId:randomUUID(),credentialId:randomUUID()};
 db.prepare('INSERT INTO membership VALUES(?,?,0,1)').run(other.principalId,'machine');db.prepare('INSERT INTO credential VALUES(?,?,?,0,1,1)').run(other.credentialId,other.principalId,actor.credentialExpiresAt);db.prepare('INSERT INTO project_grant VALUES(?,?,1,1)').run(other.principalId,ids.project);
 assert.equal(operationGet(db,other,op(c),now).data.outcome,'not_observed');assert.equal(execute(db,c,other).error.code,'VERSION_CONFLICT');
}));
test('schema, operation ID, route/header target and version validation have no receipt',withDb(({db})=>{
 const c=command();for(const change of [{schemaVersion:2},{operationId:'bad'},{entityId:"' OR 1=1 --"},{expectedVersion:undefined},{payload:{title:'ok',extra:1}},{extra:true}])assert.ok(execute(db,{...c,...change}).error);
 assert.equal(restUpdate(db,actor,{...restRequest(c),idempotencyKey:randomUUID()},{now}).status,400);assert.equal(restUpdate(db,actor,{...restRequest(c),entityId:randomUUID()},{now}).status,400);assert.equal(snapshot(db).operation.length,0);
}));
test('canonical hashing sorts object keys; preserves title Unicode, newline and schema identity',withDb(({db})=>{
 const c=command({payload:{title:'é\r\n'}});const reordered=Object.fromEntries(Object.entries(c).reverse());assert.equal(fingerprint(actor,c),fingerprint({...actor,requestId:'new',credentialId:randomUUID()},reordered));
 for(const change of [{schemaVersion:2},{payload:{title:'e\u0301\r\n'}},{payload:{title:'é\n'}},{workspaceEpoch:randomUUID()}])assert.notEqual(fingerprint(actor,c),fingerprint(actor,{...c,...change}));
 execute(db,c);assert.equal(snapshot(db).issue[0].title,'é\r\n');
}));
test('parameterized title stores SQL-looking input literally',withDb(({db})=>{const title="'); DROP TABLE issue; --";execute(db,command({payload:{title}}));assert.equal(snapshot(db).issue[0].title,title);}));
test('nonexistent rejection remains queryable; genuinely empty read is a successful empty list',withDb(({db})=>{
 const c=command({entityId:randomUUID()});const result=execute(db,c);assert.equal(result.error.code,'NOT_FOUND');assert.deepEqual(operationGet(db,actor,op(c),now),result);
 db.exec('DELETE FROM issue_fts; DELETE FROM issue');const empty=queryIssues(db,actor,op(c),now);assert.deepEqual(empty.data,{items:[],nextCursor:null});assert.equal(empty.meta.workspaceId,ids.workspace);assert.equal(empty.meta.actorId,ids.actor);
 assert.equal(queryIssues(db,{...actor,credentialExpiresAt:now},op(c),now).error.code,'EXPIRED');
}));
test('WAL/FULL committed state is visible through a new connection (not restart or power loss proof)',withDb(({db,path})=>{
 execute(db,command());const reopened=openStore(path);try{assert.equal(reopened.prepare('PRAGMA journal_mode').get().journal_mode,'wal');assert.equal(reopened.prepare('PRAGMA synchronous').get().synchronous,2);assert.equal(reopened.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(reopened.prepare('SELECT version FROM issue').get().version,8);}finally{reopened.close();}
}));
test('100 simultaneous independent worker connections produce one receipt and one effect',withDb(async({db,path})=>{
 const c=command();const workers=[];try{
 const entries=Array.from({length:100},()=>{const worker=new Worker(new URL('./competitor.mjs',import.meta.url),{workerData:{path,actor,command:c,now},execArgv:['--disable-warning=ExperimentalWarning']});workers.push(worker);let ready;const readiness=new Promise((resolve,reject)=>{ready=resolve;worker.once('error',reject);});const outcome=new Promise((resolve,reject)=>{worker.on('message',m=>{if(m.ready)ready();else resolve(m);});worker.once('error',reject);worker.once('exit',code=>{if(code!==0)reject(new Error('worker exit '+code));});});return {readiness,outcome};});
 await Promise.all(entries.map(e=>e.readiness));for(const worker of workers)worker.postMessage('start');const results=await Promise.all(entries.map(e=>e.outcome));
 assert.ok(results.every(r=>!r.error),JSON.stringify(results.filter(r=>r.error)));for(const result of results)assert.deepEqual(result.result,results[0].result);
 assert.equal(results[0].result.data.committedVersion,8);const s=snapshot(db);assert.equal(s.issue[0].version,8);assert.equal(s.activity.length,1);assert.equal(s.operation.length,1);assert.equal(s.outbox.length,1);assert.equal(s.workspace[0].change_seq,1);
 }finally{await Promise.all(workers.map(w=>w.terminate()));}
}));
test('credential without read scope is forbidden, never a successful empty list',withDb(({db})=>{db.exec('UPDATE credential SET can_read=0');assert.equal(queryIssues(db,actor,{workspaceId:ids.workspace,workspaceEpoch:ids.epoch},now).error.code,'FORBIDDEN');}));
test('domain rejection explicitly says effectApplied=false; unknown never claims rollback',withDb(({db})=>{
 assert.equal(execute(db,command({expectedVersion:6})).error.effectApplied,false);
 const unknown=restUpdate(db,actor,restRequest(command()),{now,dropResponse:true});assert.equal(unknown.body.error.outcome,'unknown');assert.equal('effectApplied' in unknown.body.error,false);
}));
test('malformed UTF-16 is rejected before SQLite can substitute content',withDb(({db})=>{assert.equal(execute(db,command({payload:{title:'\ud800'}})).error.code,'VALIDATION');assert.equal(snapshot(db).operation.length,0);}));
test('stored canonical hash version mismatch fails closed rather than replay or re-execute',withDb(({db})=>{
 const c=command();execute(db,c);db.exec("UPDATE operation SET hash_version='command-json-future'");const before=snapshot(db);assert.equal(execute(db,c).error.code,'KEY_REUSE');assert.deepEqual(snapshot(db),before);
}));
test('independent connections contend with different payloads and stale CAS',withDb(async({db,path})=>{
 async function race(commands){
  const workers=commands.map(c=>new Worker(new URL('./competitor.mjs',import.meta.url),{workerData:{path,actor,command:c,now},execArgv:['--disable-warning=ExperimentalWarning']}));
  try{const ready=workers.map(w=>new Promise((resolve,reject)=>{w.once('message',resolve);w.once('error',reject);}));await Promise.all(ready);
   const outcomes=workers.map(w=>new Promise((resolve,reject)=>{w.once('message',resolve);w.once('error',reject);}));workers.forEach(w=>w.postMessage('start'));return await Promise.all(outcomes);
  }finally{await Promise.all(workers.map(w=>w.terminate()));}
 }
 const c=command();const results=await race([c,{...c,payload:{title:'competitor'}}]);assert.equal(results.filter(r=>r.result?.data).length,1);assert.equal(results.filter(r=>r.result?.error?.code==='KEY_REUSE').length,1);
 const next=await race([command({expectedVersion:8}),command({expectedVersion:8})]);assert.equal(next.filter(r=>r.result?.data).length,1);assert.equal(next.filter(r=>r.result?.error?.code==='VERSION_CONFLICT').length,1);
 assert.equal(snapshot(db).issue[0].version,9);assert.equal(snapshot(db).activity.length,2);
}));
test('workspace singleton is enforced by SQLite, blocking cross-workspace target confusion',withDb(({db})=>{
 assert.throws(()=>db.prepare('INSERT INTO workspace VALUES(?,?,1,0)').run(randomUUID(),randomUUID()),/UNIQUE/);
 const other=randomUUID();assert.equal(execute(db,command({workspaceId:other}),{...actor,workspaceId:other}).error.code,'WORKSPACE_MISMATCH');assert.equal(snapshot(db).issue[0].version,7);
}));
test('receipt lookup contention settles to the same typed unknown in REST and MCP',withDb(({db,path})=>{
 const c=command();execute(db,c);const lock=openStore(path);try{lock.exec('BEGIN IMMEDIATE');db.exec('PRAGMA busy_timeout=1');const rest=restOperationGet(db,actor,op(c),now);const mcp=mcpOperationGet(db,actor,op(c),now);assert.equal(rest.status,503);assert.equal(rest.body.error.code,'UNAVAILABLE');assert.equal(rest.body.error.outcome,'unknown');assert.deepEqual(rest.body,mcp.structuredContent);}finally{lock.exec('ROLLBACK');lock.close();}
 assert.equal(operationGet(db,actor,op(c),now).data.outcome,'committed');
}));
test('query rejects malformed workspace, epoch and target IDs',withDb(({db})=>{
 const base={workspaceId:ids.workspace,workspaceEpoch:ids.epoch};for(const extra of [{workspaceId:'bad'},{workspaceEpoch:'bad'},{entityId:'bad'}])assert.equal(queryIssues(db,actor,{...base,...extra},now).error.code,'VALIDATION');
}));
test('credential scope denial precedes target lookup and reveals no existence difference',withDb(({db})=>{
 for(const scope of ['can_read','can_write']){db.exec('UPDATE credential SET can_read=1,can_write=1');db.exec(`UPDATE credential SET ${scope}=0`);
 const existing=execute(db,command());const missing=execute(db,command({entityId:randomUUID()}));assert.deepEqual(existing,missing);assert.equal(existing.error.code,'FORBIDDEN');assert.equal(snapshot(db).operation.length,0);}
}));
test('invisible target and nonexistent target return the same generic new-command refusal',withDb(({db})=>{
 db.exec('UPDATE project_grant SET can_read=0');const a=command();const b=command({entityId:randomUUID()});const existing=execute(db,a);const missing=execute(db,b);assert.deepEqual(existing,missing);assert.equal(existing.error.code,'NOT_FOUND');assert.deepEqual(operationGet(db,actor,op(a),now),operationGet(db,actor,op(b),now));assert.deepEqual(execute(db,a),execute(db,b));
}));
test('synthetic silent zero-row required writes fail closed with full rollback',async()=>{
 for(const [table,event] of [['operation','INSERT'],['activity','INSERT'],['outbox','INSERT'],['workspace','UPDATE']]){
 const f=fixture();try{f.db.exec(`CREATE TRIGGER suppress_write BEFORE ${event} ON ${table} BEGIN SELECT RAISE(IGNORE); END`);const before=snapshot(f.db);const c=command();const result=restUpdate(f.db,actor,restRequest(c),{now});assert.equal(result.body.attemptOutcome,'not_committed');assert.deepEqual(snapshot(f.db),before);}finally{f.close();}}
});
test('lost authorization does not falsely claim an earlier committed operation had no effect',withDb(({db})=>{
 const c=command();execute(db,c);db.exec('UPDATE project_grant SET can_read=0');for(const r of [execute(db,c),operationGet(db,actor,op(c),now)]){assert.equal(r.error.code,'FORBIDDEN');assert.equal(r.error.outcome,'unknown');assert.equal('effectApplied' in r.error,false);}assert.equal(snapshot(db).issue[0].version,8);
}));
test('real SQLite with synthetic COMMIT/ROLLBACK call faults classifies attempt separately',async()=>{
 for(const mode of ['before_commit','after_commit','rollback_failure']){
  const f=fixture();try{const c=command();const delegated={prepare:(...args)=>f.db.prepare(...args),exec(sql){
   if(sql==='COMMIT'&&mode==='before_commit')throw new Error('synthetic pre-commit');
   if(sql==='COMMIT'&&mode==='after_commit'){f.db.exec(sql);throw new Error('synthetic post-commit');}
   if(sql==='ROLLBACK'&&mode==='rollback_failure')throw new Error('synthetic rollback failure');
   return f.db.exec(sql);
  }};
  const result=restUpdate(delegated,actor,restRequest(c),{now,fault:step=>{if(mode==='rollback_failure'&&step==='after_issue')throw new Error('synthetic mutation');}});
  assert.equal(result.body.error.outcome,'unknown');assert.equal(result.body.attemptOutcome,mode==='before_commit'?'not_committed':'unknown');assert.equal('effectApplied' in result.body.error,false);
  if(mode==='rollback_failure')f.db.exec('ROLLBACK');
  const found=operationGet(f.db,actor,op(c),now);assert.equal(found.data.outcome,mode==='after_commit'?'committed':'not_observed');assert.equal(snapshot(f.db).issue[0].version,mode==='after_commit'?8:7);
  }finally{f.close();}
 }
});
test('request-level refusals never deny an already committed operation effect',withDb(({db,path})=>{
 const c=command();execute(db,c);
 const responses=[execute(db,{...c,schemaVersion:2}),execute(db,{...c,payload:{title:'different'}}),execute(db,{...c,workspaceEpoch:randomUUID()}),restUpdate(db,actor,{...restRequest(c),idempotencyKey:randomUUID()},{now}).body,restUpdate(db,actor,{...restRequest(c),entityId:randomUUID()},{now}).body];
 const lock=openStore(path);try{lock.exec('BEGIN IMMEDIATE');db.exec('PRAGMA busy_timeout=1');responses.push(restUpdate(db,actor,restRequest(c),{now}).body);}finally{lock.exec('ROLLBACK');lock.close();}
 for(const result of responses){assert.equal(result.error.outcome,'unknown');assert.equal('effectApplied' in result.error,false);}assert.equal(operationGet(db,actor,op(c),now).data.outcome,'committed');assert.equal(snapshot(db).issue[0].version,8);
}));
