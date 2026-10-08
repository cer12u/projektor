// Synthetic test-only actor/time/SQL/fault surface. Not imported by product.
import {AtomicWorkspace} from './adapter.mjs';
import {executeCommand,queryClaim,queryResolutionRecords,queryAttemptCheckpoint,queryIssueEntries} from '../src/shared-core.mjs';
export class WorkflowFixture extends AtomicWorkspace {
 sql(s,args=[]){return this.ctx.storage.sql.exec(s,...args).toArray();}
 snapshot(){return Object.fromEntries(this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").toArray().map(({name})=>[name,this.ctx.storage.sql.exec(`SELECT * FROM "${name}"`).toArray()]));}
 command(actor,c,now,faultWrite=0){let writes=0;const base=this.db,db={...base,prepare(s){const stmt=base.prepare(s);return {...stmt,run(...a){const r=stmt.run(...a);if(++writes===faultWrite)throw Error('Injected actual write failure');return r;}};}};try{return {result:executeCommand(db,actor,c,{now}),writes};}catch(e){return {error:'storage_failure',outcome:e.outcome,writes};}}
 query(actor,args,now,kind){return ({claim:queryClaim,resolutions:queryResolutionRecords,checkpoint:queryAttemptCheckpoint,entries:queryIssueEntries}[kind])(this.db,actor,args,now);}
}
export default {async fetch(request,env){const {object,method,args}=await request.json();if(!['sql','snapshot','command','query'].includes(method))return new Response('',{status:404});return Response.json(await env.WORKSPACE.getByName(object)[method](...args));}};
