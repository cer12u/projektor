// Synthetic-only import/query fixture. Production uses service/entry.mjs directly.
import entry from '../service/entry.mjs';
import {WorkspaceService} from '../service/workspace.mjs';
import {sqliteStore} from '../service/store.mjs';
import {importProjectUrls,queryLegacyUrl} from '../src/legacy-url.mjs';
export class LegacyUrlFixture extends WorkspaceService {
 importUrls(batch){try{return {data:importProjectUrls(sqliteStore(this.ctx.storage),batch)};}catch(e){return {error:e.message,outcome:e.outcome};}}
 resolveUrl(actor,args){return queryLegacyUrl(sqliteStore(this.ctx.storage),actor,args);}
}
export default {async fetch(request,env,ctx){
 if(new URL(request.url).pathname==='/__fixture/import'){const {workspaceId,batch}=await request.json();return Response.json(await env.WORKSPACE.getByName(workspaceId).importUrls(batch));}
 if(new URL(request.url).pathname==='/__fixture/query'){const {actor,args}=await request.json();return Response.json(await env.WORKSPACE.getByName(args.workspaceId).resolveUrl(actor,args));}
 return entry.fetch(request,env,ctx);
}};
