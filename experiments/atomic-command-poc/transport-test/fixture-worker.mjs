// TEST ONLY. Never use this class as a deployed binding.
import { AuthenticatedWorkspace } from '../transport/workspace.mjs';
export { default } from '../transport/ingress.mjs';
export class FixtureWorkspace extends AuthenticatedWorkspace {
 seed(ids,kind,issuer,expiry) {this.ctx.storage.transactionSync(()=>{
  const sql=this.ctx.storage.sql;
  sql.exec('INSERT INTO workspace VALUES(?,?,1,0)',ids.workspace,ids.epoch);
  sql.exec('INSERT INTO membership VALUES(?,?,0,1)',ids.actor,kind);
  sql.exec('INSERT INTO credential VALUES(?,?,?,0,1,1)',ids.credential,ids.actor,expiry);
  sql.exec('INSERT INTO identity_binding VALUES(?,?,?,?,?)',issuer,'fixture-subject',ids.credential,ids.actor,kind);
  sql.exec('INSERT INTO project_grant VALUES(?,?,1,1)',ids.actor,ids.project);
  sql.exec('INSERT INTO issue VALUES(?,?,?,7,0)',ids.issue,ids.project,'original title');
  sql.exec('INSERT INTO issue_fts VALUES(?,?)',ids.issue,'original title');
 });return true;}
 sql(statement,args=[]) {return this.ctx.storage.sql.exec(statement,...args).toArray();}
 async command(verified,c) {const result=super.command(verified,c);if(c.payload.title==='TEST_ONLY_DROP_AFTER_COMMIT'){await this.ctx.storage.sync();throw new Error('test-only postcommit response loss');}return result;}
}
