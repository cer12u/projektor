// @module platform.d1
// @role atomic-batch
// Shared atomic write construction. Callers supply only trusted SQL with bound values.
import type { AuthDB } from "../primitives";
export interface BoundSql {text:string;values:readonly (string|number|null)[]}
export interface CountedWrite {statement:BoundSql;expectedChanges:number}
export function guardedBatch(db:AuthDB,guard:BoundSql,writes:readonly CountedWrite[],prefix:readonly D1PreparedStatement[]=[]):D1PreparedStatement[]{
  const id=crypto.randomUUID(),statements=[...prefix,db.prepare(`INSERT INTO mutation_guards(batch_id,step,valid) VALUES(?,0,CASE WHEN ${guard.text} THEN 1 ELSE 0 END)`).bind(id,...guard.values)];
  for(const [index,write]of writes.entries()){
    if(!Number.isSafeInteger(write.expectedChanges)||write.expectedChanges<1)throw new Error('invalid_checked_write');
    statements.push(db.prepare(write.statement.text).bind(...write.statement.values),db.prepare('INSERT INTO mutation_guards(batch_id,step,valid) VALUES(?,?,CASE WHEN changes()=? THEN 1 ELSE 0 END)').bind(id,index+1,write.expectedChanges));
  }
  statements.push(db.prepare('DELETE FROM mutation_guards WHERE batch_id=?').bind(id));return statements;
}
