// @module verification
// @role primary-authorization-regression
// Actual Worker composition and local D1. Proves primary-only binding selection and
// revocation at receipt disclosure; does not simulate or claim live replica testing.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {basename,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {prepareLocalD1,verifyCanonicalLedger} from '../../support/local-d1-fixture.mjs';
const candidate=fileURLToPath(new URL('../../../',import.meta.url));
const hash=x=>createHash('sha256').update(x).digest('hex');
const origin='https://primary.invalid',token='P'.repeat(43),principal='PRIMARY_AGENT';
const output=resolve(candidate,'.local/evidence/primary-authorization-workerd.json');
const report={runtime:'actual Worker composition and local workerd/D1; no live replicas',productionActions:0,externalRequests:0,scenarios:[]};
const source=`import product from '${candidate}/src/apps/worker.ts';
export default {async fetch(request,env){
 const metrics={sessions:0,primaryReads:0,primaryBatches:0,revocations:0};
 const revoke=request.headers.get('X-Revoke')==='true';
 function observe(db,primary){return {prepare(text){
  const wrap=stmt=>new Proxy(stmt,{get(t,k){
   if(k==='bind')return(...values)=>wrap(t.bind(...values));
   if(k==='first'||k==='all'||k==='run')return async(...args)=>{
    if(primary)metrics.primaryReads++;
    if(revoke&&!metrics.revocations&&text.includes('AS snapshot, state')&&text.includes('FROM operation_results')){
     await env.DB.prepare("DELETE FROM memberships WHERE principal_id='PRIMARY_AGENT' AND permission='edit'").run();metrics.revocations++;
    }
    return t[k](...args);
   };
   const value=Reflect.get(t,k);return typeof value==='function'?value.bind(t):value;
  }});return wrap(db.prepare(text));
 },async batch(statements){if(primary)metrics.primaryBatches++;return db.batch(statements);}};}
 const primary=observe(env.DB,true);
 const DB={...primary,withSession(c){metrics.sessions++;return observe(env.DB.withSession(c),false);}};
 const headers=new Headers(request.headers);headers.set('Host',new URL(request.url).host);
 const response=await product.fetch(new Request(request,{headers}),{...env,DB});
 response.headers.set('X-Database-Observation',JSON.stringify(metrics));return response;
}};`;
await mkdir(resolve(candidate,'.local/evidence'),{recursive:true});
try{
 for(const originalRouting of [true,false]){
  const root=await mkdtemp(join(tmpdir(),'projektor-primary-'));let mf;
  try{
   const compilation=await build({absWorkingDir:candidate,metafile:true,stdin:{contents:source,resolveDir:candidate,sourcefile:'primary-authorization-fixture.ts'},outfile:join(root,'worker.mjs'),bundle:true,format:'esm',platform:'neutral',mainFields:['module','main'],conditions:['workerd','worker','browser'],external:['node:*','cloudflare:*'],plugins:[
    {name:'original-routing-negative-control',setup(b){if(originalRouting)b.onLoad({filter:/[/\\]apps[/\\]worker\.ts$/},async args=>{const text=await readFile(args.path,'utf8');assert(text.includes('createRequestServices(env.DB,'));assert(text.includes(' db=env.DB,'));return{contents:text.replace('createRequestServices(env.DB,',"createRequestServices(env.DB.withSession('first-primary'),").replace(' db=env.DB,'," db=env.DB.withSession('first-primary'),"),loader:'ts'};});}},
    {name:'wasm',setup(b){b.onResolve({filter:/\.wasm$/},a=>({path:'./'+basename(a.path),external:true}));}}
   ]});
   const files=Object.keys(compilation.metafile.inputs).filter(p=>p.startsWith('src/'));
   const sourceHashes=Object.fromEntries(await Promise.all(files.map(async p=>[p,hash(await readFile(resolve(candidate,p)))])));
   if(!originalRouting)report.sourceHashes=sourceHashes;
   const modules=[{type:'ESModule',path:join(root,'worker.mjs'),contents:await readFile(join(root,'worker.mjs'),'utf8')}];
   for(const name of ['argon2.wasm','blake2b.wasm'])modules.push({type:'CompiledWasm',path:join(root,name),contents:await readFile(resolve(candidate,'src/adapters/crypto/generated',name))});
   const fixture=await prepareLocalD1(root);
   mf=new Miniflare(convertV4MiniflareOptions({name:'primary-authorization',modules,modulesRoot:root,compatibilityDate:'2026-10-09',compatibilityFlags:['nodejs_compat'],...fixture,bindings:{AUTH_ORIGIN:origin,MCP_ENABLED:'true'},outboundService:()=>{report.externalRequests++;throw Error('Outbound denied');},host:'127.0.0.1',port:0,cf:false,logRequests:false}));
   await mf.ready;const db=await mf.getD1Database('DB');await verifyCanonicalLedger(db);
   await db.prepare("INSERT INTO principals VALUES(?,'agent','Synthetic primary agent',NULL,1,1)").bind(principal).run();
   await db.prepare("INSERT INTO api_credentials VALUES('PRIMARY_KEY',?,?,unixepoch()+3600,NULL)").bind(principal,hash(token)).run();
   for(const permission of ['view','edit']){await db.prepare("INSERT INTO memberships VALUES(?,'P',?)").bind(principal,permission).run();await db.prepare("INSERT INTO api_grants VALUES('PRIMARY_KEY','P',?)").bind(permission).run();}
   async function call(path,input,extra={}){const response=await mf.dispatchFetch(origin+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...extra},body:JSON.stringify(input)});return{status:response.status,body:await response.json(),metrics:JSON.parse(response.headers.get('X-Database-Observation'))};}
   const input={operationId:'primary_commit',body:'PRIVATE_PRIMARY_CANARY',title:'Primary test'};
   const result=await call('/api/projects/P/issues',input);
   assert.equal(result.status,200);assert.equal(result.body.source,'committed');
   const requirePrimary=metrics=>{assert.equal(metrics.sessions,0,'protected requests must not use replica-eligible sessions');assert(metrics.primaryReads>0);};
   if(originalRouting){assert(result.metrics.sessions>0);assert.throws(()=>requirePrimary(result.metrics),/protected requests must not use/);report.scenarios.push({name:'original_worker_routing_fails_primary_only_contract',metrics:result.metrics});continue;}
   requirePrimary(result.metrics);assert(result.metrics.primaryBatches>0);
   const lost=await call('/api/projects/P/issues',input,{'X-Revoke':'true'});
   assert.equal(lost.status,403);assert.equal(lost.body.application,'unknown');assert.equal(lost.body.operationId,input.operationId);assert(!JSON.stringify(lost.body).includes(input.body));assert.equal(lost.metrics.revocations,1);requirePrimary(lost.metrics);
   for(const [table,key]of [['operation_results','principal_id'],['issue_history','actor_id']])assert.equal(await db.prepare('SELECT count(*) n FROM '+table+' WHERE '+key+'=? AND operation_id=?').bind(principal,input.operationId).first('n'),1);
   report.scenarios.push({name:'primary_binding_commit_and_revoked_receipt_preserve_single_commit',metrics:lost.metrics});
   // MCP has an independent Worker branch. Its initialize auth must use the same binding.
   const mcp=await call('/mcp',{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'primary-test',version:'1.0'}}},{Accept:'application/json, text/event-stream'});
   assert.equal(mcp.status,200);requirePrimary(mcp.metrics);report.scenarios.push({name:'mcp_ingress_uses_primary_binding',metrics:mcp.metrics});
   for(const file of files)assert.equal(hash(await readFile(resolve(candidate,file))),sourceHashes[file],'source changed during test: '+file);
  }finally{if(mf)await mf.dispose();await rm(root,{recursive:true,force:true});}
 }
 assert.equal(report.externalRequests,0);report.passed=true;
}catch(error){report.passed=false;report.failure={message:error.message,stack:error.stack};throw error;}
finally{await writeFile(output,JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify({passed:report.passed,scenarios:report.scenarios,output},null,2));
