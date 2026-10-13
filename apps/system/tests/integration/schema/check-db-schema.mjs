// @module verification
// @role db-schema
// Failure hypotheses: incomplete clean installs, unchecked already-applied DDL, or drifted
// schema/ledger must never be treated as safe to reapply. Test real SQLite persistence,
// not mocked migration return values. The Worker/D1 boundary is checked separately.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { assess, expectedChain, ledgerSQL, snapshot, sqlTokens } from "../../../scripts/schema/db-schema-preflight.mjs";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"../../..");
const files=(await readdir(root+'/migrations')).filter(n=>n.endsWith('.sql')).sort();
const migrationCount=files.length;
const sqls=await Promise.all(files.map(f=>readFile(root+'/migrations/'+f,'utf8'))), chain=await expectedChain();
const report={startedAt:new Date().toISOString(),runtime:process.version,level:'real SQLite schema/ledger preflight integration; not production or Worker runtime',checks:[]};
function fixture(schema=migrationCount,ledger=schema,mutate=(sql)=>sql) {
 const db=new DatabaseSync(':memory:');db.exec(ledgerSQL);
 for(let i=0;i<schema;i++) db.exec(mutate(sqls[i],i));
 for(let i=0;i<ledger;i++) db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(files[i]);
 return db;
}
async function check(name,fn){await fn();report.checks.push({name,passed:true});}
async function unchanged(db,status) {const before=snapshot(db),result=await assess(before,chain);assert.equal(result.status,status,JSON.stringify(result));assert.deepEqual(snapshot(db),before);return result;}
await check('empty database permits the complete ordered chain',async()=>{const db=new DatabaseSync(':memory:');try{const r=await unchanged(db,'ready');assert.equal(r.pending.length,migrationCount);}finally{db.close();}});
for(const prefix of Array.from({length:migrationCount-11},(_,i)=>i+12)) await check('canonical schema and ledger prefix '+prefix,async()=>{const db=fixture(prefix);try{const r=await unchanged(db,prefix===migrationCount?'current':'ready');assert.equal(r.pending.length,migrationCount-prefix);}finally{db.close();}});
await check('already applied unledgered additions stop for explicit reconciliation',async()=>{const db=fixture(migrationCount,12);try{const r=await unchanged(db,'reconciliation-required');assert.deepEqual(r.reconcile,files.slice(12));const before=snapshot(db);for(const name of r.reconcile)db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(name);await unchanged(db,'current');assert.deepEqual(snapshot(db).objects,before.objects);assert.deepEqual(snapshot(db).tables,before.tables);}finally{db.close();}});
await check('ledger ahead of schema stops',async()=>{const db=fixture(12,migrationCount);try{await unchanged(db,'stop');}finally{db.close();}});
await check('missing whole ledger on existing schema stops',async()=>{const db=fixture();try{db.exec('DROP TABLE d1_migrations');await unchanged(db,'stop');}finally{db.close();}});
await check('hole in ledger stops even when all objects exist',async()=>{const db=fixture();try{db.exec('DELETE FROM d1_migrations WHERE id=13');await unchanged(db,'stop');}finally{db.close();}});
await check('out-of-order ledger stops',async()=>{const db=fixture(migrationCount,0);try{for(const name of [...files.slice(0,12),files[13],files[12],...files.slice(14)])db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(name);await unchanged(db,'stop');}finally{db.close();}});
await check('historical or unknown migration filename stops without mapping guesses',async()=>{const db=fixture();try{db.exec("UPDATE d1_migrations SET name='0013_issue_execution.sql' WHERE id=14");await unchanged(db,'stop');}finally{db.close();}});
await check('unsupported and duplicate ledger schema stops',async()=>{const db=fixture();try{db.exec('DROP TABLE d1_migrations; CREATE TABLE d1_migrations(id INTEGER,name TEXT,applied_at TEXT);');db.exec("INSERT INTO d1_migrations VALUES(1,'0001_auth.sql','2026-10-12'),(2,'0001_auth.sql','2026-10-12')");await unchanged(db,'stop');}finally{db.close();}});
await check('partial reference ALTER stops',async()=>{const db=fixture(12);try{db.exec(sqls[12].split(';')[0]+';');await unchanged(db,'stop');}finally{db.close();}});
await check('missing report index stops despite matching tables',async()=>{const db=fixture();try{db.exec('DROP INDEX issue_execution_one_final_report');await unchanged(db,'stop');}finally{db.close();}});
await check('unexpected trigger stops',async()=>{const db=fixture();try{db.exec("CREATE TRIGGER extra_schema_trigger BEFORE UPDATE ON issues BEGIN SELECT RAISE(ABORT,'unexpected'); END;");await unchanged(db,'stop');}finally{db.close();}});
await check('unexpected application table stops',async()=>{const db=fixture();try{db.exec('CREATE TABLE extra_schema_table(id TEXT)');await unchanged(db,'stop');}finally{db.close();}});
for(const name of ['sqliteX_review_hidden','sqliteXreviewhidden']) await check('SQLite prefix lookalike trigger is not hidden: '+name,async()=>{const db=fixture();try{db.exec("CREATE TRIGGER "+name+" BEFORE DELETE ON issues BEGIN SELECT RAISE(ABORT,'unexpected'); END;");await unchanged(db,'stop');}finally{db.close();}});
await check('SQLite prefix lookalike table is not hidden',async()=>{const db=fixture();try{db.exec('CREATE TABLE sqliteX_extra(id TEXT)');await unchanged(db,'stop');}finally{db.close();}});
await check('unexpected migration ledger trigger stops',async()=>{const db=fixture();try{db.exec("CREATE TRIGGER unexpected_ledger BEFORE INSERT ON d1_migrations BEGIN SELECT RAISE(ABORT,'unexpected'); END;");await unchanged(db,'stop');}finally{db.close();}});
await check('ledger name collision with a view stops on an empty DB',async()=>{const db=new DatabaseSync(':memory:');try{db.exec('CREATE VIEW d1_migrations AS SELECT 1 AS id');await unchanged(db,'stop');}finally{db.close();}});
await check('metadata table name collision is not hidden',async()=>{const db=fixture();try{db.exec('CREATE VIEW _cf_METADATA AS SELECT 1 AS id');await unchanged(db,'stop');}finally{db.close();}});
await check('unexpected metadata table structure is not hidden',async()=>{const db=fixture();try{db.exec('CREATE TABLE _cf_METADATA(secret TEXT)');await unchanged(db,'stop');}finally{db.close();}});
const mutations=[
 ['CHECK string case',13,s=>s.replace("state IN ('running','ended','interrupted')","state IN ('RUNNING','ended','interrupted')")],
 ['CHECK literal interior whitespace',13,s=>s.replace("state IN ('running','ended','interrupted')","state IN ('run ning','ended','interrupted')")],
 ['reference default',12,s=>s.replace("DEFAULT '[]'","DEFAULT '[1]'")],
 ['partial UNIQUE index predicate',14,s=>s.replace("WHERE report_kind IN ('completed','imported')","WHERE report_kind IN ('completed')")],
 ['trigger body literal',14,s=>s.replace("'report immutable'","'report  immutable'")],
 ['foreign key target',13,s=>s.replace('principal_id TEXT NOT NULL REFERENCES principals(id)','principal_id TEXT NOT NULL REFERENCES principals(login_id)')],
 ['missing primary key',13,s=>s.replace('issue_id TEXT PRIMARY KEY NOT NULL REFERENCES issues(id)','issue_id TEXT UNIQUE NOT NULL REFERENCES issues(id)')],
];
for(const [name,index,mutate] of mutations) await check('structural drift: '+name,async()=>{const db=fixture(migrationCount,migrationCount,(sql,i)=>i===index?mutate(sql):sql);try{await unchanged(db,'stop');}finally{db.close();}});
await check('token normalization preserves quoted comment markers, spaces, and escaped quotes',()=>{assert.notDeepEqual(sqlTokens("CHECK(x='a  b')"),sqlTokens("CHECK(x='a b')"));assert.notDeepEqual(sqlTokens("SELECT 'A'"),sqlTokens("SELECT 'a'"));assert.notDeepEqual(sqlTokens("SELECT 'a--b'"),sqlTokens("SELECT 'a'"));assert.notDeepEqual(sqlTokens("SELECT 'a''b'"),sqlTokens("SELECT 'a''''b'"));assert.deepEqual(sqlTokens("SELECT /* comment */  'a'"),sqlTokens("SELECT 'a'"));});
await check('CLI opens an existing fixture read-only and does not alter its bytes',async()=>{const tmp=await mkdtemp(tmpdir()+'/schema-readonly-');try{const path=tmp+'/fixture.sqlite',db=new DatabaseSync(path);db.exec(ledgerSQL);for(let i=0;i<12;i++){db.exec(sqls[i]);db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(files[i]);}db.close();const hash=async()=>createHash('sha256').update(await readFile(path)).digest('hex');const before=await hash();const child=spawnSync(process.execPath,[root+'/scripts/schema/db-schema-preflight.mjs','--database',path],{encoding:'utf8'});assert.equal(child.status,0,child.stderr);assert.equal(JSON.parse(child.stdout).status,'ready');assert.equal(await hash(),before);}finally{await rm(tmp,{recursive:true,force:true});}});
await check('exact Cloudflare internal KV schema is allowed',async()=>{const db=fixture();try{db.exec('CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID');await unchanged(db,'current');}finally{db.close();}});
await check('Cloudflare internal KV changed schema is rejected',async()=>{const db=fixture();try{db.exec('CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID');await unchanged(db,'stop');}finally{db.close();}});
await check('unexpected object associated with internal KV is rejected',async()=>{const db=fixture();try{db.exec('CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID; CREATE INDEX unexpected_kv_index ON _cf_KV(value);');await unchanged(db,'stop');}finally{db.close();}});
report.finishedAt=new Date().toISOString();report.passed=true;console.log(JSON.stringify(report,null,2));
