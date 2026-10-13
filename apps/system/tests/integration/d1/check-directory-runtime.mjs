// @module verification
// @role directory-regression
// Synthetic local workerd/D1 evidence. Never contacts or changes a deployed database.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,basename} from 'node:path';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {prepareLocalD1,verifyCanonicalLedger} from '../../support/local-d1-fixture.mjs';
const root=await mkdtemp(join(tmpdir(),'projektor-directory-')),candidate=resolve('.');let mf;
try{
 const source=`import {assembleWorkContent} from '${candidate}/src/adapters/d1/work/assembly.ts';
 import {directoryApi} from '${candidate}/src/apps/http/directory.ts';
 import {modelApi} from '${candidate}/src/apps/http/model.ts';
 import {protocolFailure} from '${candidate}/src/apps/http/outcomes.ts';
 export default {async fetch(request,env){
  const mode=request.headers.get('X-Mode')??'',actor=request.headers.get('X-Actor')??'OWNER';
  const auth={id:actor,kind:'agent',display_name:actor,auth_version:1,authentication:'api',credential_id:'KEY_'+actor,token_hash:'hash_'+actor,csrf_token:null};
  let poisoned=false;
  const db={prepare(text){const stmt=env.DB.prepare(text);const wrap=s=>new Proxy(s,{get(t,k){if(k==='bind')return(...v)=>wrap(t.bind(...v));if(k==='first')return async(...v)=>{if(poisoned)throw Error('lost response');return t.first(...v);};const v=Reflect.get(t,k);return typeof v==='function'?v.bind(t):v;}});return wrap(stmt);},async batch(statements){
   if(mode==='revoke-before')await env.DB.prepare("UPDATE principal_management SET global_administrator=0 WHERE principal_id='OWNER'").run();
   const r=await env.DB.batch(statements);
   if(mode==='revoke-after')await env.DB.prepare("UPDATE principal_management SET global_administrator=0 WHERE principal_id='OWNER'").run();
   if(mode==='lose-after'){poisoned=true;throw Error('lost acknowledgement');}return r;
  }};
  const work=assembleWorkContent(db,auth).api,services={actor:auth,work},requests={authenticate:async()=>services};
  try{return await directoryApi(request,requests,'https://fixture.invalid')??await modelApi(request,requests)??Response.json({error:'not_found'},{status:404});}
  catch(e){const f=protocolFailure(e);return Response.json(f?.body??{error:'unavailable'},{status:f?.status??503});}
 }};`;
 await build({stdin:{contents:source,resolveDir:candidate,sourcefile:'directory-fixture.ts'},outfile:join(root,'worker.mjs'),bundle:true,format:'esm',platform:'neutral',external:['node:*','cloudflare:*'],plugins:[{name:'wasm',setup(b){b.onResolve({filter:/\.wasm$/},a=>({path:'./'+basename(a.path),external:true}));}}]});
 const opts=await prepareLocalD1(root);
 mf=new Miniflare(convertV4MiniflareOptions({name:'directory-local',modules:[{type:'ESModule',path:join(root,'worker.mjs'),contents:await readFile(join(root,'worker.mjs'),'utf8')},...await Promise.all(['argon2.wasm','blake2b.wasm'].map(async name=>({type:'CompiledWasm',path:join(root,name),contents:await readFile(candidate+'/src/adapters/crypto/generated/'+name)})))],modulesRoot:root,compatibilityDate:'2026-10-09',compatibilityFlags:['nodejs_compat'],...opts,host:'127.0.0.1',port:0,cf:false}));
 await mf.ready;const db=await mf.getD1Database('DB');await verifyCanonicalLedger(db);
 for(const id of ['OWNER','MANAGER','VIEWER']){await db.prepare('INSERT INTO principals VALUES(?,?,?,NULL,1,1)').bind(id,'agent',id).run();await db.prepare('INSERT INTO api_credentials VALUES(?,?,?,unixepoch()+3600,NULL)').bind('KEY_'+id,id,'hash_'+id).run();}
 const owner=()=>db.prepare("UPDATE principal_management SET global_administrator=1 WHERE principal_id='OWNER'").run();await owner();
 async function call(path,input,actor='OWNER',mode='',method=input?'POST':'GET'){const r=await mf.dispatchFetch('https://fixture.invalid'+path,{method,headers:{'Content-Type':'application/json','X-Actor':actor,'X-Mode':mode},...(input?{body:JSON.stringify(input)}:{})});return {status:r.status,body:await r.json()};}
 let r=await call('/api/workspaces',{operationId:'workspace_create',name:'Team'});assert.equal(r.status,200,JSON.stringify(r));const workspace=r.body.snapshot;assert.match(workspace.id,/^[a-f0-9-]{36}$/);assert.equal(workspace.revision,1);
 const create={operationId:'project_create',workspaceId:workspace.id,key:'APP',slug:'app',name:'App',description:'Original'};
 r=await call('/api/projects',create);assert.equal(r.status,200,JSON.stringify(r));const project=r.body.snapshot;
 assert.equal((await db.prepare('SELECT count(*) n FROM memberships').first('n')),0,'creating scopes never grants memberships');
 const directory=(await call('/api/directory')).body;assert.equal(directory.management.canCreate,true);assert.equal(directory.management.projects[0].id,project.id);assert.equal(directory.projects.length,0);
 assert.equal((await call('/api/projects',create)).body.source,'recovered');assert.equal((await call('/api/projects',{...create,name:'Other'})).status,409);
 assert.equal((await call('/api/projects',{...create,operationId:'duplicate_key'})).status,409);
 for(const permission of ['view','manage']){await db.prepare('INSERT INTO memberships VALUES(?,?,?)').bind('MANAGER',project.id,permission).run();await db.prepare('INSERT INTO api_grants VALUES(?,?,?)').bind('KEY_MANAGER',project.id,permission).run();}
 const patch=(op,revision,name)=>({operationId:op,revision,name});
 assert.equal((await call('/api/projects/'+project.id,patch('viewer_edit',1,'Denied'),'VIEWER','','PATCH')).status,403);
 assert.equal((await call('/api/workspaces',{operationId:'manager_create',name:'Denied'},'MANAGER')).status,403);
 r=await call('/api/projects/'+project.id,patch('manager_edit',1,'Managed'),'MANAGER','','PATCH');assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.body.snapshot.revision,2);
 const races=await Promise.all(['race_a','race_b'].map(op=>call('/api/projects/'+project.id,patch(op,2,op),'OWNER','','PATCH')));assert.deepEqual(races.map(v=>v.status).sort(),[200,409]);
 assert.equal(await db.prepare('SELECT revision FROM projects WHERE id=?').bind(project.id).first('revision'),3);
 await db.prepare("CREATE TRIGGER directory_fail_history BEFORE INSERT ON directory_history WHEN NEW.operation_id='fail_history' BEGIN SELECT RAISE(ABORT,'synthetic failure');END").run();
 assert.equal((await call('/api/projects/'+project.id,patch('fail_history',3,'Must rollback'),'OWNER','','PATCH')).status,500);
 assert.equal(await db.prepare('SELECT revision FROM projects WHERE id=?').bind(project.id).first('revision'),3);assert.equal(await db.prepare("SELECT count(*) n FROM operation_results WHERE operation_id='fail_history'").first('n'),0);
 r=await call('/api/projects/'+project.id,patch('lost_ack',3,'Committed privately'),'OWNER','lose-after','PATCH');assert.equal(r.status,503);assert.equal(r.body.application,'unknown');
 r=await call('/api/directory-operations/lost_ack');assert.equal(r.status,200);assert.equal(r.body.snapshot.revision,4);
 r=await call('/api/projects/'+project.id,patch('revoked_before',4,'Never committed'),'OWNER','revoke-before','PATCH');assert.equal(r.status,403);assert.equal(await db.prepare('SELECT revision FROM projects WHERE id=?').bind(project.id).first('revision'),4);
 await owner();r=await call('/api/projects/'+project.id,patch('revoked_after',4,'Committed but withheld'),'OWNER','revoke-after','PATCH');assert.equal(r.status,403);assert.equal(r.body.application,'unknown');assert.equal(r.body.snapshot,undefined);assert.equal(await db.prepare('SELECT revision FROM projects WHERE id=?').bind(project.id).first('revision'),5);
 assert.equal((await call('/api/directory-operations/revoked_after')).status,403);await owner();assert.equal((await call('/api/directory-operations/revoked_after')).body.snapshot.revision,5);
 // Workspace management uses the exact colon-prefixed Identity scope and credential ceiling.
 for(const permission of ['view','manage']){await db.prepare('INSERT INTO memberships VALUES(?,?,?)').bind('MANAGER',workspace.scopeId,permission).run();await db.prepare('INSERT INTO api_grants VALUES(?,?,?)').bind('KEY_MANAGER',workspace.scopeId,permission).run();}
 assert.equal((await call('/api/workspaces/'+workspace.id,patch('workspace_edit',1,'Managed workspace'),'MANAGER','','PATCH')).status,200);
 await db.prepare('DELETE FROM api_grants WHERE credential_id=? AND project_id=? AND permission=?').bind('KEY_MANAGER',workspace.scopeId,'manage').run();
 assert.equal((await call('/api/workspaces/'+workspace.id,patch('workspace_ceiling',2,'Denied'),'MANAGER','','PATCH')).status,403);
 assert.equal(await db.prepare('SELECT source_json FROM projects WHERE id=?').bind(project.id).first('source_json'),'{}');
 assert.equal((await call('/api/projects/'+project.id,{operationId:'immutable_key',revision:5,key:'OTHER'},'OWNER','','PATCH')).status,400);
 assert.equal((await call('/api/projects/'+project.id,patch('overflow_revision',Number.MAX_SAFE_INTEGER,'Invalid'),'OWNER','','PATCH')).status,400);
 assert.equal((await call('/api/projects/'+project.id+'/history?limit=51')).status,400);
 const history=(await call('/api/projects/'+project.id+'/history?limit=2')).body;assert.equal(history.history.length,2);assert.equal(history.nextAfterRevision,2);assert.equal(history.history[0].before,null);assert.equal(history.history[1].before.name,'App');
 assert.equal((await call('/api/projects/'+project.id+'/history?afterRevision=2&limit=2')).body.history[0].revision,3);
 await db.prepare("DELETE FROM memberships WHERE principal_id='MANAGER' AND permission='manage'").run();assert.equal((await call('/api/directory-operations/manager_edit',undefined,'MANAGER')).status,403);
 assert.equal((await call('/api/directory',undefined,'MANAGER')).body.management.projects.length,0);
 assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
 console.log(JSON.stringify({passed:true,runtime:'actual local workerd + canonical migrated D1',scenarios:['create workspace/project without grants','directory management visibility','same-ID recovery and mismatch','uniqueness','scoped edit','concurrent revision','atomic history failure','lost acknowledgement','revocation before/after commit','current receipt permissions','history cursor','workspace scope and credential ceiling','immutable identifiers and revision overflow'],productionActions:0}));
}finally{if(mf)await mf.dispose();await rm(root,{recursive:true,force:true});}
