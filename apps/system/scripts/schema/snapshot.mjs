// @module tooling.schema
// @role snapshot
const quote = name => '"' + name.replaceAll('"', '""') + '"';
function structure(db, table) {
 const columns=db.prepare('PRAGMA table_xinfo('+quote(table)+')').all();
 const foreignKeys=db.prepare('PRAGMA foreign_key_list('+quote(table)+')').all();
 const indexes=db.prepare('PRAGMA index_list('+quote(table)+')').all().map(({seq,...index})=>({...index,columns:db.prepare('PRAGMA index_xinfo('+quote(index.name)+')').all()})).sort((a,b)=>a.name.localeCompare(b.name));
 return {columns,foreignKeys,indexes};
}
export function snapshot(db) {
 const objects=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name").all();
 const ledger=objects.find(x=>x.type==='table' && x.name==='d1_migrations');
 const tables=Object.fromEntries(objects.filter(x=>x.type==='table').map(x=>[x.name,structure(db,x.name)]));
 // Reject unsupported ledger structure before selecting its expected columns.
 const supportedLedger=ledger && JSON.stringify(tables.d1_migrations.columns.map(c=>c.name)) === JSON.stringify(['id','name','applied_at']);
 return {
  format:1,objects,tables,
  ledger:ledger ? (supportedLedger ? db.prepare('SELECT id,name,applied_at FROM d1_migrations ORDER BY id').all() : null) : [],
  integrity:db.prepare('PRAGMA integrity_check').all(),
  foreignKeyViolations:db.prepare('PRAGMA foreign_key_check').all(),
 };
}
