// TEST ONLY: synthetic authentication, fixture SQL and fault injection.
import { AtomicWorkspace } from './adapter.mjs';
const ids={workspace:'10000000-0000-4000-8000-000000000001',epoch:'10000000-0000-4000-8000-000000000002',actor:'10000000-0000-4000-8000-000000000003',credential:'10000000-0000-4000-8000-000000000004',issue:'10000000-0000-4000-8000-000000000005',project:'10000000-0000-4000-8000-000000000006'};
const now=1800000000000;
const actor={principalId:ids.actor,actorKind:'machine',credentialId:ids.credential,credentialExpiresAt:now+3600000,workspaceId:ids.workspace};
export class FixtureWorkspace extends AtomicWorkspace {
 seed(){this.ctx.storage.transactionSync(()=>{
  const sql=this.ctx.storage.sql;
  sql.exec('INSERT INTO workspace VALUES(?,?,1,0)',ids.workspace,ids.epoch);
  sql.exec('INSERT INTO membership VALUES(?,?,0,1)',ids.actor,'machine');
  sql.exec('INSERT INTO credential VALUES(?,?,?,0,1,1)',ids.credential,ids.actor,actor.credentialExpiresAt);
  sql.exec('INSERT INTO project_grant VALUES(?,?,1,1)',ids.actor,ids.project);
  sql.exec('INSERT INTO issue VALUES(?,?,?,7,0)',ids.issue,ids.project,'original title');
  sql.exec('INSERT INTO issue_fts VALUES(?,?)',ids.issue,'original title');
 });return {seeded:true};}
 sql(statement,args=[]){return this.ctx.storage.sql.exec(statement,...args).toArray();}
 snapshot(){return Object.fromEntries(['workspace','issue','activity','issue_fts','outbox','operation'].map(t=>[t,this.ctx.storage.sql.exec(`SELECT * FROM ${t}`).toArray()]));}
 command(c,{faultAt,dropResponse=false}={}){
  const r=this.updateTitle(actor,c,{now,fault(step){if(step===faultAt)throw new Error('Injected callback failure');}});
  // Actual transport exception after successful command and storage flush. The
  // caller must retain unknown; this is not a simulated SQLite rollback.
  if(dropResponse)return this.ctx.storage.sync().then(()=>{throw new Error('Injected lost response after commit');});
  return r;
 }
 lookup(args){return this.getOperation(actor,args,now);}
 myIssues(args,asActor=actor){return this.getMyIssues(asActor,args,now);}
 query(args){return this.getIssues(actor,args,now);}
}
export default {async fetch(request,env){
 const {object,action,args=[]}=await request.json();
 const stub=env.WORKSPACE.getByName(object);
 // Narrow dispatch used solely by the local test harness, never deployed.
 if(!['seed','sql','snapshot','command','lookup','query','myIssues'].includes(action))return new Response('',{status:404});
 try{return Response.json(await stub[action](...args));}
 catch(error) {console.error(error);return Response.json({error:{code:'TRANSPORT_UNKNOWN',outcome:'unknown',retryable:true}},{status:503});}
}};
