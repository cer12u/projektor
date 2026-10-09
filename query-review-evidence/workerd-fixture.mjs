// Independent reviewer-only workerd fixture. Never deploy this class.
import { AtomicWorkspace } from '../experiments/atomic-command-poc/workerd/adapter.mjs';
import { queryMyIssues } from '../experiments/atomic-command-poc/src/my-issues.mjs';
export class ReviewWorkspace extends AtomicWorkspace {
 sql(statement,args=[]) { return this.ctx.storage.sql.exec(statement,...args).toArray(); }
 query(actor,args,now) { return queryMyIssues(this.db,actor,args,now); }
 detail(actor,args,now) { return this.getIssues(actor,args,now); }
 command(actor,args,now) { return this.updateTitle(actor,args,{now}); }
 receipt(actor,args,now) { return this.getOperation(actor,args,now); }
}
export default {async fetch(request,env) {
 const {object,action,args}=await request.json();
 if(!['sql','query','detail','command','receipt'].includes(action))return new Response('',{status:404});
 try{return Response.json(await env.WORKSPACE.getByName(object)[action](...args));}
 catch(error){return Response.json({reviewFixtureError:String(error)},{status:500});}
}};
