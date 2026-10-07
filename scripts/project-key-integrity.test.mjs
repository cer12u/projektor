// Local real-SQL regression suite; no dependency installation, network, or D1 writes.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { inspectProjectKeys } from './project-key-preflight.mjs';

const migrations = new URL('../packages/db/migrations/', import.meta.url);
const uniqueSql = readFileSync(new URL('0072_project_key_unique.sql', migrations), 'utf8');
let reportedFixtureFailure = false;
function database({ baseline = false, file = ':memory:' } = {}) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  for (const name of readdirSync(migrations).filter(n => n.endsWith('.sql')).sort()) {
    if (baseline && name === '0072_project_key_unique.sql') continue;
    try {
      db.exec(readFileSync(new URL(name, migrations), 'utf8'));
    } catch (error) {
      // Public diagnostic is bounded to a known fixture error and runtime versions.
      // Never dump runner environment, credentials, production data, or arbitrary logs.
      if (process.env.GITHUB_ACTIONS === 'true' && !reportedFixtureFailure) {
        reportedFixtureFailure = true;
        const version = db.prepare('SELECT sqlite_version() AS version').get().version;
        const reason = error.message === 'no such module: fts5' ? error.message : 'Unclassified migration fixture failure';
        console.error(`::error file=scripts/project-key-integrity.test.mjs,title=Project SQL fixture::${name}: ${reason}. Node ${process.versions.node}, SQLite ${version}. Original failure is preserved.`);
      }
      db.close();
      throw error;
    }
  }
  db.exec(`INSERT INTO workspaces (id,name,slug,created_at) VALUES ('w1','One','one',1),('w2','Two','two',1);
           INSERT INTO users (id,email,name,created_at) VALUES ('u','fixture@example.invalid','Fixture',1);`);
  return db;
}
function insert(db, id, key, workspace = 'w1', archived = null) {
  db.prepare('INSERT INTO projects(id,workspace_id,name,key,slug,archived_at,created_at,updated_at) VALUES (?,?,?,?,?,?,1,1)')
    .run(id,workspace,id,key,id,archived);
}
function rows(db) { return db.prepare('SELECT id,workspace_id,key,archived_at FROM projects ORDER BY id').all(); }
function audit(db, id, action) {
  db.prepare(`INSERT INTO activity(id,workspace_id,entity_type,entity_id,actor_id,action,created_at)
              SELECT ?, 'w1','project',?,'u',?,1 WHERE changes() = 1`).run(`a-${id}-${action}`,id,action);
}
function transaction(db, fn) {
  db.exec('BEGIN');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

test('baseline reproduces key race, update collision and partial create after audit failure', () => {
  const db = database({ baseline: true });
  const check = () => db.prepare("SELECT id FROM projects WHERE workspace_id='w1' AND key='DUP'").get();
  assert.equal(check(), undefined); assert.equal(check(), undefined);
  insert(db,'p1','DUP'); insert(db,'p2','DUP');
  insert(db,'p3','OTHER');
  db.exec("UPDATE projects SET key='DUP' WHERE id='p3'");
  assert.equal(rows(db).filter(r => r.key === 'DUP').length,3);
  db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON activity BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
  insert(db,'partial','PARTIAL');
  assert.throws(() => audit(db,'partial','created'), /synthetic audit failure/);
  assert.equal(rows(db).length,4);
  db.close();
});

test('new migration indexes keys case-insensitively and retains the exact-key lookup index', () => {
  const db = database();
  const idx = db.prepare('PRAGMA index_list(projects)').all();
  assert.equal(idx.find(i => i.name === 'idx_projects_ws_key_unique').unique,1);
  assert.ok(idx.find(i => i.name === 'idx_projects_ws_key'));
  assert.equal(db.prepare("PRAGMA index_xinfo('idx_projects_ws_key_unique')").all().find(i => i.name === 'key').coll,'NOCASE');
  db.close();
});

for (const [name, key, archived] of [['exact','DUP',null],['case-only','dup',null],['archived','DUP',1]]) {
  test(`migration and preflight fail closed on ${name} duplicates without changing a row or old index`, () => {
    const db = database({ baseline: true });
    insert(db,'p1','DUP'); insert(db,'p2',key,'w1',archived);
    const before = rows(db);
    const indexes = db.prepare('PRAGMA index_list(projects)').all();
    assert.equal(inspectProjectKeys(db).ready,false);
    assert.equal(inspectProjectKeys(db).duplicates.length,1);
    assert.throws(() => db.exec(uniqueSql),/UNIQUE constraint failed/);
    assert.deepEqual(rows(db),before);
    assert.deepEqual(db.prepare('PRAGMA index_list(projects)').all(),indexes);
    db.close();
  });
}

test('noncanonical legacy keys are reported for review and never normalized automatically', () => {
  const db = database({ baseline: true });
  for (const [id,key] of [['p1','mixed'],['p2','2BAD'],['p3','BAD-KEY'],['p4','']]) insert(db,id,key);
  const before = rows(db);
  assert.equal(inspectProjectKeys(db).noncanonical.length,4);
  assert.equal(inspectProjectKeys(db).ready,false);
  assert.deepEqual(rows(db),before); db.close();
});

test('workspace separation, archived reservation, self-update, and physical deletion reuse', () => {
  const db = database();
  insert(db,'p1','SAME','w1',1); insert(db,'p2','same','w2');
  assert.throws(() => insert(db,'p3','same','w1'),/UNIQUE constraint failed/);
  db.exec("UPDATE projects SET key='same', archived_at=NULL WHERE id='p1'");
  assert.equal(rows(db).length,2);
  db.exec("DELETE FROM projects WHERE id='p1'"); insert(db,'p3','SAME');
  assert.equal(rows(db).length,2); db.close();
});

test('conflicting updates leave both rows unchanged', () => {
  const db = database(); insert(db,'p1','ONE'); insert(db,'p2','TWO');
  const before = rows(db);
  assert.throws(() => db.exec("UPDATE projects SET key='one' WHERE id='p2'"),/UNIQUE constraint failed/);
  assert.deepEqual(rows(db),before); db.close();
});

for (const action of ['created','updated']) {
  test(`${action}: audit failure rolls the project mutation back`, () => {
    const db = database();
    if (action === 'updated') insert(db,'p','OLD');
    const before = rows(db);
    db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON activity BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
    assert.throws(() => transaction(db, () => {
      if (action === 'created') insert(db,'p','NEW');
      else db.exec("UPDATE projects SET key='NEW',name='Changed' WHERE id='p'");
      audit(db,'p',action);
    }), /synthetic audit failure/);
    assert.deepEqual(rows(db),before);
    assert.equal(db.prepare('SELECT count(*) AS n FROM activity').get().n,0); db.close();
  });
}

test('same-value update is counted and audited once', () => {
  const db = database(); insert(db,'p','SAME');
  transaction(db, () => { db.exec("UPDATE projects SET key='SAME' WHERE id='p'"); audit(db,'p','updated'); });
  assert.equal(db.prepare('SELECT count(*) AS n FROM activity').get().n,1); db.close();
});

test('zero-row update cannot write an orphan audit, including after another writer deletes', () => {
  const db = database(); insert(db,'p','OLD'); db.exec("DELETE FROM projects WHERE id='p'");
  transaction(db, () => { db.exec("UPDATE projects SET key='NEW' WHERE id='p' AND workspace_id='w1'"); audit(db,'p','updated'); });
  assert.equal(db.prepare('SELECT count(*) AS n FROM activity').get().n,0); db.close();
});

test('read-only CLI exits nonzero for findings, never creates a missing input, leaves export bytes unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(),'projektor-preflight-'));
  try {
    const file=join(dir,'data.sqlite'); const db=database({ baseline: true,file });
    insert(db,'p1','DUP'); insert(db,'p2','DUP'); db.close();
    const before=readFileSync(file);
    const cli=new URL('./project-key-preflight.mjs',import.meta.url);
    const run=spawnSync(process.execPath,[cli.pathname,file],{encoding:'utf8'});
    assert.equal(run.status,1); assert.equal(JSON.parse(run.stdout).duplicates.length,1);
    assert.deepEqual(readFileSync(file),before);
    const missing=spawnSync(process.execPath,[cli.pathname,join(dir,'missing.sqlite')],{encoding:'utf8'});
    assert.equal(missing.status,2); assert.deepEqual(readdirSync(dir),['data.sqlite']);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

for (const mode of ['create','update','mixed']) {
  test(`real SQLite concurrent ${mode} writers commit exactly one mutation/audit`, async () => {
    const dir=mkdtempSync(join(tmpdir(),'projektor-key-race-')); const file=join(dir,'race.sqlite');
    try {
      const db=database({file});
      if (mode === 'update') insert(db,'p0','FIRST');
      if (mode !== 'create') insert(db,'p1','SECOND');
      db.close();
      const gate=new SharedArrayBuffer(4);
      const worker=String.raw`
        const {parentPort,workerData:d}=require('node:worker_threads');
        const {DatabaseSync}=require('node:sqlite');
        const db=new DatabaseSync(d.file); db.exec('PRAGMA busy_timeout=10000');
        parentPort.postMessage({ready:true}); Atomics.wait(new Int32Array(d.gate),0,0);
        try {
          db.exec('BEGIN IMMEDIATE');
          if (d.update) db.prepare('UPDATE projects SET key=? WHERE id=? AND workspace_id=?').run('RACE','p'+d.id,'w1');
          else db.prepare('INSERT INTO projects(id,workspace_id,name,key,created_at,updated_at) VALUES (?,?,?,?,1,1)').run('p'+d.id,'w1','Name'+d.id,'RACE');
          db.prepare("INSERT INTO activity(id,workspace_id,entity_type,entity_id,actor_id,action,created_at) VALUES (?,'w1','project',?,'u',?,1)").run('a'+d.id,'p'+d.id,d.update?'updated':'created');
          db.exec('COMMIT'); parentPort.postMessage({ok:true});
        } catch(error) { db.exec('ROLLBACK'); parentPort.postMessage({error:error.message}); }
        finally {db.close();}
      `;
      let ready=0;
      const results=await Promise.all([0,1].map(id => new Promise((resolve,reject) => {
        const w=new Worker(worker,{eval:true,workerData:{file,gate,id,update:mode==='update'||(mode==='mixed'&&id===1)}});
        w.on('error',reject);
        w.on('message',m=> {if(m.ready){if(++ready===2){Atomics.store(new Int32Array(gate),0,1);Atomics.notify(new Int32Array(gate),0);}}else resolve(m);});
      })));
      assert.equal(results.filter(r=>r.ok).length,1);
      assert.match(results.find(r=>r.error).error,/UNIQUE constraint failed/);
      const read=new DatabaseSync(file,{readOnly:true});
      assert.equal(read.prepare("SELECT count(*) AS n FROM projects WHERE key='RACE'").get().n,1);
      assert.equal(read.prepare('SELECT count(*) AS n FROM activity').get().n,1); read.close();
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
}
