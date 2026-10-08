// Test-only control plane. Never include this class/routes in production bundle.
import {DurableObject} from 'cloudflare:workers';
import schema from '../src/schema.sql';import keySchema from './schema.sql';import {sqliteStore} from '../service/store.mjs';import {currentSession,draftKey} from './server.mjs';
export class SessionFixture extends DurableObject{
 constructor(ctx,env){super(ctx,env);this.db=sqliteStore(ctx.storage);ctx.blockConcurrencyWhile(async()=>{ctx.storage.sql.exec(schema);ctx.storage.sql.exec(keySchema);ctx.storage.sql.exec('INSERT INTO query_state VALUES(1,0,?)','fixture-query-key');ctx.storage.sql.exec('CREATE TABLE identity_binding(issuer TEXT,subject TEXT,credential_id TEXT PRIMARY KEY,principal_id TEXT,kind TEXT)');});}
 async fetch(request){const {action,args}=await request.json();try {return Response.json(this.ctx.storage.transactionSync(()=>{if(action==='sql')return this.ctx.storage.sql.exec(args[0],...args.slice(1)).toArray();if(action==='session')return currentSession(this.db,...args).session;if(action==='key')return draftKey(this.db,...args);throw Error('UNKNOWN');}));}catch(e){return Response.json({error:{code:e.code??e.message}},{status:e.status??503});}}
}
export default {fetch(request,env){const name=new URL(request.url).pathname.slice(1);return env.WORKSPACE.getByName(name).fetch(request);}};
