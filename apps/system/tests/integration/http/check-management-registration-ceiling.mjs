// @module verification
// @role management-grant-runtime-contract
// Actual Worker + local workerd/D1. Synthetic-only DB batch race hooks, no production.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,join,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {prepareLocalD1,verifyCanonicalLedger} from '../../support/local-d1-fixture.mjs';
const candidate=fileURLToPath(new URL('../../../',import.meta.url)),root=await mkdtemp(join(tmpdir(),'projektor-registration-ceiling-'));
const origin='https://grants.invalid',token='a'.repeat(43),human='h'.repeat(43),csrf='c'.repeat(43),hash=x=>createHash('sha256').update(x).digest('hex');
const report={passed:false,level:'actual source-bundled Worker, local workerd/D1, synthetic batch race hooks; not production',externalRequests:0,productionActions:0,checks:[]};let mf;
try{
 const fixture=await prepareLocalD1(root),bundle=join(root,'worker.mjs');
 const source=`import product from '${candidate}/src/apps/worker.ts';export default {async fetch(request,env){let raced=false;const mode=request.headers.get('X-Synthetic-Race');const DB={prepare:q=>env.DB.prepare(q),withSession:()=>DB,async batch(statements){if(mode&&!raced){raced=true;const q={actorGlobal:"UPDATE principal_management SET global_administrator=0 WHERE principal_id='A'",actorCredential:"UPDATE api_credentials SET revoked_at=unixepoch() WHERE id='A_KEY'",actorGrant:"DELETE FROM api_grants WHERE credential_id='A_KEY' AND project_id='P' AND permission='edit'",actorMembership:"DELETE FROM memberships WHERE principal_id='A' AND project_id='P' AND permission='edit'",actorManage:"DELETE FROM memberships WHERE principal_id='A' AND project_id='P' AND permission='manage'",targetMembership:"DELETE FROM memberships WHERE principal_id='TARGET' AND project_id='P' AND permission='edit'",credentialRevision:"UPDATE credential_management SET revision=revision+1 WHERE credential_id='TARGET_KEY'"}[mode];if(!q)throw Error('Unknown synthetic race');await env.DB.prepare(q).run();}return env.DB.batch(statements);}};const headers=new Headers(request.headers);headers.set('Host',new URL(request.url).host);if(headers.has('X-Synthetic-Origin')){headers.set('Origin',headers.get('X-Synthetic-Origin'));headers.delete('X-Synthetic-Origin');}const response=await product.fetch(new Request(request,{headers}),{...env,DB});response.headers.set('X-Synthetic-Raced',String(raced));return response;}};`;
 const compiled=await build({stdin:{contents:source,resolveDir:candidate,sourcefile:'management-grant-fixture.ts'},outfile:bundle,bundle:true,format:'esm',platform:'neutral',mainFields:['module','main'],conditions:['workerd','worker','browser'],external:['node:*','cloudflare:*'],metafile:true,plugins:[{name:'wasm',setup(b){b.onResolve({filter:/\.wasm$/},a=>({path:'./'+basename(a.path),external:true}));}}]});
 report.sourceHashes=Object.fromEntries(await Promise.all(Object.keys(compiled.metafile.inputs).filter(p=>p.startsWith('src/')).map(async p=>[p,hash(await readFile(resolve(candidate,p)))])));
 const modules=[{type:'ESModule',path:bundle,contents:await readFile(bundle,'utf8')}];for(const name of ['argon2.wasm','blake2b.wasm'])modules.push({type:'CompiledWasm',path:join(root,name),contents:await readFile(join(candidate,'src/adapters/crypto/generated',name))});
 mf=new Miniflare(convertV4MiniflareOptions({name:'registration-ceiling',modules,modulesRoot:root,compatibilityDate:'2026-10-09',compatibilityFlags:['nodejs_compat'],...fixture,bindings:{AUTH_ORIGIN:origin},serviceBindings:{ASSETS:()=>new Response('static')},outboundService:()=>{report.externalRequests++;throw Error('External request denied');},host:'127.0.0.1',port:0,cf:false,logRequests:false}));await mf.ready;const db=await mf.getD1Database('DB'),worker=await mf.getWorker();await verifyCanonicalLedger(db);
 const sql=(q,...v)=>db.prepare(q).bind(...v).run();
 for(const id of ['A','TARGET']){await sql('INSERT INTO principals VALUES(?,?,?,NULL,1,1)',id,'agent',id);await sql('INSERT INTO api_credentials VALUES(?,?,?,unixepoch()+3600,NULL)',id+'_KEY',id,hash(id==='A'?token:'t'.repeat(43)));}
 await sql("INSERT INTO principals VALUES('ADMIN','human','Synthetic Admin','admin',1,1)");await sql("UPDATE principal_management SET global_administrator=1 WHERE principal_id='ADMIN'");
 await sql("INSERT INTO sessions(token_hash,principal_id,auth_version,api_credential_id,csrf_token,created_at,last_seen_at,absolute_expires_at,revoked_at) VALUES(?,'ADMIN',1,NULL,?,unixepoch(),unixepoch(),unixepoch()+3600,NULL)",hash(human),csrf);
 for(const id of ['A','TARGET'])for(const p of id==='A'?['view','manage']:['view','edit','execute']){await sql('INSERT INTO memberships VALUES(?,?,?)',id,'P',p);await sql('INSERT INTO api_grants VALUES(?,?,?)',id+'_KEY','P',p);}
 async function http(path,method='GET',body,{admin=false,derived=false,race}={}){const headers={...((admin||derived)?{Cookie:'__Host-projektor_session='+(derived?'d'.repeat(43):human),'X-Synthetic-Origin':origin,'X-CSRF-Token':csrf}:{Authorization:'Bearer '+token}),...(body===undefined?{}:{'Content-Type':'application/json'}),...(race?{'X-Synthetic-Race':race}:{})};const r=await worker.fetch(origin+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,body:await r.json(),raced:r.headers.get('X-Synthetic-Raced')==='true'};}

 // Normal provisioning forbids agent + global administrator. This synthetic imported/corrupt
 // global flag tests defense in depth; it is not claimed as an ordinary reachable grant path.
 await sql("UPDATE principal_management SET global_administrator=1 WHERE principal_id='A'");
 for(const p of ['view','manage'])await sql('INSERT INTO memberships VALUES(?,?,?)','ADMIN','P',p);
 await sql("INSERT INTO sessions(token_hash,principal_id,auth_version,api_credential_id,csrf_token,created_at,last_seen_at,absolute_expires_at,revoked_at,scope_ceiling_json) VALUES(?,'A',1,'A_KEY',?,unixepoch(),unixepoch(),unixepoch()+3600,NULL,?)",hash('d'.repeat(43)),csrf,JSON.stringify(['view','manage'].map(permission=>({projectId:'P',permission}))));
 const registration=(id,permissions=['view','edit'])=>({operationId:'register-'+id,principalId:id,kind:'agent',displayName:id,loginId:null,projects:[{projectId:'P',permissions}]});
 const register=(input,options)=>http('/api/management/principals','POST',input,options);
 async function absent(input){for(const [table,column,value] of [['principals','id',input.principalId],['memberships','principal_id',input.principalId],['operation_results','operation_id',input.operationId],['management_audit','operation_id',input.operationId]])assert.equal(await db.prepare(`SELECT count(*) n FROM ${table} WHERE ${column}=?`).bind(value).first('n'),0);}
 let input=registration('LIMITED');let r=await register(input);assert.equal(r.status,403,JSON.stringify(r));await absent(input);
 // A principal having edit does not lift the API credential ceiling.
 await sql("INSERT INTO memberships VALUES('A','P','edit')");input=registration('LIMITED_MEMBER');r=await register(input);assert.equal(r.status,403,JSON.stringify(r));await absent(input);
 await sql("INSERT INTO api_grants VALUES('A_KEY','P','edit')");input=registration('DERIVED_LIMITED');r=await register(input,{derived:true});assert.equal(r.status,403,JSON.stringify(r));await absent(input);
 report.checks.push('synthetic global API actor cannot exceed credential rights; derived session also obeys captured ceiling; no partial principal, grants, audit or receipt');
 input=registration('VALID');r=await register(input);assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.body.source,'committed');
 const replay=await register(input);assert.equal(replay.status,200,JSON.stringify(replay));assert.equal(replay.body.source,'recovered');assert.deepEqual(replay.body.snapshot,r.body.snapshot);
 assert.deepEqual((await db.prepare("SELECT permission FROM memberships WHERE principal_id='VALID' AND project_id='P' ORDER BY permission").all()).results.map(x=>x.permission),['edit','view']);
 for(const table of ['operation_results','management_audit'])assert.equal(await db.prepare(`SELECT count(*) n FROM ${table} WHERE operation_id=?`).bind(input.operationId).first('n'),1);
 // Human global administrator's explicit scope management remains sufficient; it does not
 // acquire its own edit membership as a side effect of registering someone else.
 input=registration('HUMAN_VALID');r=await register(input,{admin:true});assert.equal(r.status,200,JSON.stringify(r));assert.equal(await db.prepare("SELECT count(*) n FROM memberships WHERE principal_id='ADMIN' AND permission='edit'").first('n'),0);
 report.checks.push('valid scoped registration, immutable same-ID replay, single audit/receipt; human global registration does not add implicit actor rights');
 for(const race of ['actorGrant','actorGlobal','actorCredential']){
  await sql("INSERT OR IGNORE INTO api_grants VALUES('A_KEY','P','edit')");await sql("UPDATE principal_management SET global_administrator=1 WHERE principal_id='A'");await sql("UPDATE api_credentials SET revoked_at=NULL WHERE id='A_KEY'");
  input=registration('RACE_'+race);r=await register(input,{race});assert.equal(r.status,race==='actorCredential'?401:403,JSON.stringify(r));assert(r.raced);await absent(input);
 }
 report.checks.push('revoked requested grant, global authority or credential immediately before actual D1 batch rejects all writes');assert.equal(report.externalRequests,0);report.passed=true;
}catch(error){report.failure=error.message;throw error;}finally{await mf?.dispose();await mkdir('.local/evidence',{recursive:true});await writeFile('.local/evidence/management-registration-ceiling.json',JSON.stringify(report,null,2)+'\n');await rm(root,{recursive:true,force:true});}
console.log(JSON.stringify({passed:report.passed,checks:report.checks}));
