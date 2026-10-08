import { AtomicWorkspace } from '../workerd/adapter.mjs';
import { failure } from '../src/shared-core.mjs';
export class AuthenticatedWorkspace extends AtomicWorkspace {
 constructor(ctx,env) {
  super(ctx,env);
  ctx.blockConcurrencyWhile(async()=>{ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS identity_binding(issuer TEXT NOT NULL, subject TEXT NOT NULL, credential_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, kind TEXT NOT NULL)`);});
 }
 actor(verified) {
  const row=this.db.prepare('SELECT * FROM identity_binding WHERE issuer=? AND subject=? AND credential_id=?').get(verified.issuer,verified.subject,verified.credentialId);
  if(!row || row.kind!==verified.actorKind)return null;
  return {...verified,principalId:row.principal_id};
 }
 bind(result,actor,args){return result.data?{...result,meta:{...result.meta,workspaceId:args.workspaceId,workspaceEpoch:args.workspaceEpoch,actorId:actor.principalId}}:result;}
 // Internal binding only: no fetch handler and no route accepting actor fields.
 command(verified,command) {
  const actor=this.actor(verified);
  return actor ? this.updateTitle(actor,command) : failure('UNAUTHENTICATED');
 }
 issue(verified,args) {
  const actor=this.actor(verified);
  return actor ? this.bind(this.getIssues(actor,args),actor,args) : failure('UNAUTHENTICATED');
 }
 myIssues(verified,args) {
  const actor=this.actor(verified);
  return actor ? this.getMyIssues(actor,args) : failure('UNAUTHENTICATED');
 }
 receipt(verified,args) {
  const actor=this.actor(verified);
  return actor ? this.getOperation(actor,args) : failure('UNAUTHENTICATED');
 }
 projects(verified,args) {
  const actor=this.actor(verified);
  return actor ? this.bind(this.getProjects(actor,args),actor,args) : failure('UNAUTHENTICATED');
 }
 entries(verified,args) {
  const actor=this.actor(verified);
  return actor ? this.bind(this.getIssueEntries(actor,args),actor,args) : failure('UNAUTHENTICATED');
 }
 revisions(verified,args) {
  const actor=this.actor(verified);
  return actor ? this.bind(this.getContentRevisions(actor,args),actor,args) : failure('UNAUTHENTICATED');
 }

}
