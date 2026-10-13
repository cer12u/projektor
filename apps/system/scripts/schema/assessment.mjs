// @module tooling.schema
// @role assessment
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {ledgerSQL} from './ledger.mjs';
import {sqlTokens} from './sql-tokens.mjs';
import {snapshot} from './snapshot.mjs';
import {appShape,differences} from './shape.mjs';
import {expectedChain} from './chain.mjs';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function assess(s, chain) {
 chain ??= await expectedChain();
 const report={format:1,status:'stop',schemaSha256:digest(appShape(s)),ledgerSha256:digest(s.ledger),migrations:chain.migrations,reasons:[],pending:[],reconcile:[],writesPerformed:0};
 const stop=reason=>{report.reasons.push(reason);return report;};
 if(s.format!==1) return stop('Unsupported snapshot format.');
 if(JSON.stringify(s.integrity)!==JSON.stringify([{integrity_check:'ok'}])) return stop('Database integrity check did not return ok.');
 if(s.foreignKeyViolations.length) return stop('Existing foreign-key violations require review.');
 const actual=appShape(s), canonicalNames=chain.migrations.map(m=>m.name), ledgerObject=s.objects.find(x=>x.type==='table' && x.name==='d1_migrations');
 // Only exact known Cloudflare internal declarations are ignored. Lookalikes and
 // any added objects attached to these tables still fail closed.
 for(const [name,sql] of [['_cf_METADATA','CREATE TABLE _cf_METADATA (key INTEGER PRIMARY KEY, value BLOB)'],['_cf_KV','CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID']]) {
  const metadataObjects=s.objects.filter(x=>x.name===name || x.tbl_name===name);
  if(!metadataObjects.length)continue;
  const reference=new DatabaseSync(':memory:');let expected;
  try {reference.exec(sql);expected=snapshot(reference);} finally {reference.close();}
  if(JSON.stringify(metadataObjects.map(x=>({...x,sql:sqlTokens(x.sql)})))!==JSON.stringify(expected.objects.map(x=>({...x,sql:sqlTokens(x.sql)}))) || JSON.stringify(s.tables[name])!==JSON.stringify(expected.tables[name])) return stop('Unsupported Cloudflare metadata schema or associated objects: '+name+'.');
 }

 if(!ledgerObject && s.objects.some(x=>x.name==='d1_migrations' || x.tbl_name==='d1_migrations')) return stop('Migration ledger name collides with a non-table schema object.');
 if(!ledgerObject && actual.objects.length) return stop('Existing application schema has no migration ledger. Do not infer or recreate migration history.');
 if(ledgerObject) {
  const reference=new DatabaseSync(':memory:');let ledgerReference;
  try {reference.exec(ledgerSQL);ledgerReference=snapshot(reference);} finally {reference.close();}
  const ledgerObjects = value => value.objects.filter(x=>x.name==='d1_migrations' || x.tbl_name==='d1_migrations').map(x=>({...x,sql:sqlTokens(x.sql)}));
  if(JSON.stringify(ledgerObjects(s))!==JSON.stringify(ledgerObjects(ledgerReference))) return stop('Unexpected objects associated with the migration ledger.');
  const expectedObject=ledgerReference.objects.find(x=>x.name==='d1_migrations');
  if(JSON.stringify(sqlTokens(ledgerObject.sql))!==JSON.stringify(sqlTokens(expectedObject.sql)) || JSON.stringify(s.tables.d1_migrations)!==JSON.stringify(ledgerReference.tables.d1_migrations) || !Array.isArray(s.ledger)) return stop('Unsupported migration ledger schema.');
 }
 const names=s.ledger.map(r=>r.name);
 if(new Set(names).size!==names.length) return stop('Duplicate migration ledger filenames.');
 if(s.ledger.some((r,i)=>r.id!==i+1 || typeof r.applied_at!=='string' || !r.applied_at)) return stop('Migration ledger row IDs have gaps/duplicates or timestamps are invalid.');
 const unknown=names.filter(n=>!canonicalNames.includes(n));
 if(unknown.length) return stop('Unrecognized ledger filenames: '+unknown.join(', ')+'. Review their SQL and provenance; do not rename or silently mark them.');
 if(names.some((name,i)=>name!==canonicalNames[i])) return stop('Migration ledger is not an ordered canonical prefix (hole or out-of-order migration).');
 const prefix=chain.states.findIndex(state=>JSON.stringify(state)===JSON.stringify(actual));
 if(prefix===-1) {report.differences=differences(actual,chain.states[names.length]);return stop('Schema is partial, incompatible, or contains unexpected objects. No automatic migration/reconciliation is safe.');}
 report.schemaPrefix=prefix;report.ledgerPrefix=names.length;
 if(prefix<names.length) return stop('Ledger claims migrations whose schema is absent.');
 if(prefix>names.length) {
  report.status='reconciliation-required';report.reconcile=canonicalNames.slice(names.length,prefix);report.pending=canonicalNames.slice(prefix);
  return stop('Schema is ahead of its ledger. Stop normal migration application; review an explicit metadata-only reconciliation against this exact snapshot before proceeding.');
 }
 report.pending=canonicalNames.slice(prefix);report.status=report.pending.length?'ready':'current';
 return report;
}
