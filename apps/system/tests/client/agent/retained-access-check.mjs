// @module verification
// @role retained-access
import {prepareLocalD1, verifyCanonicalLedger} from "../../support/local-d1-fixture.mjs";
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {mkdtemp,readFile,writeFile,rm,chmod,symlink,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join,basename} from 'node:path';import {createServer} from 'node:http';import {createHash} from 'node:crypto';
await mkdir('.local/evidence',{recursive:true});
const tmp=await mkdtemp(join(tmpdir(),'retained-access-')),report={scope:'synthetic front gate plus actual Node HTTP client/workerd/D1; not Cloudflare admission',productionActions:0,results:[]};
const hash=x=>createHash('sha256').update(x).digest('hex');let mf,server,trap;
const applicationId='11111111-1111-4111-8111-111111111111',serviceTokenId='22222222-2222-4222-8222-222222222222';
const appToken='a'.repeat(43),clientId='synthetic-client.access',clientSecret='synthetic-SECRET-never-in-receipt';let requests=0,workerRequests=0,trapRequests=0,gate='allow';
async function test(name,fn){await fn();report.results.push({name,passed:true});}
try{
 await build({entryPoints:['src/agent/public.ts','src/adapters/credentials/file-providers.ts','src/adapters/credentials/cloudflare-admission.ts'],outdir:tmp,bundle:true,format:'esm',platform:'node',outExtension:{'.js':'.mjs'}});
 const {privateAgentClient:createClient}=await import(tmp+'/agent-private-client.mjs');const {accessServiceAdmission}=await import(tmp+'/access-service-auth.mjs');async function privateAgentClient(options){const {access,...core}=options;return createClient({...core,admission:accessServiceAdmission(core.origin,core.environment,access)});}const {privateFileProvider,accessServiceFileProvider}=await import(tmp+'/agent-file-providers.mjs');
 await build({entryPoints:['src/apps/worker.ts'],outfile:tmp+'/worker.mjs',bundle:true,format:'esm',platform:'neutral',mainFields:['module','main'],conditions:['workerd','worker','browser'],external:['node:*','cloudflare:*'],plugins:[{name:'wasm',setup(b){b.onResolve({filter:/\.wasm$/},a=>({path:'./'+basename(a.path),external:true}));}}]});
 const modules=[{type:'ESModule',path:tmp+'/worker.mjs',contents:await readFile(tmp+'/worker.mjs','utf8')}];for(const n of ['argon2.wasm','blake2b.wasm'])modules.push({type:'CompiledWasm',path:tmp+'/'+n,contents:await readFile('src/adapters/crypto/generated/'+n)});
 const fixture=await prepareLocalD1(tmp);
 mf=new Miniflare(convertV4MiniflareOptions({name:'retained-access-synthetic',modules,modulesRoot:tmp,compatibilityDate:'2026-10-09',compatibilityFlags:['nodejs_compat'],...fixture,bindings:{AUTH_ORIGIN:'https://synthetic.invalid'},host:'127.0.0.1',port:0,cf:false,logRequests:false}));await mf.ready;
 const db=await mf.getD1Database('DB');await verifyCanonicalLedger(db);
 await db.prepare("INSERT INTO principals VALUES('A','agent','Synthetic A',NULL,1,1)").run();await db.prepare("INSERT INTO api_credentials VALUES('A-key','A',?,unixepoch()+3600,NULL)").bind(hash(appToken)).run();for(const permission of ['view','edit']){await db.prepare("INSERT INTO memberships VALUES('A','P',?)").bind(permission).run();await db.prepare("INSERT INTO api_grants VALUES('A-key','P',?)").bind(permission).run();}
 trap=createServer((req,res)=>{trapRequests++;res.end('trap');});await new Promise(r=>trap.listen(0,'127.0.0.1',r));const trapOrigin='http://127.0.0.1:'+trap.address().port;
 let origin;
 server=createServer(async(req,res)=>{requests++;try{
  assert.equal(req.headers.cookie,undefined);
  if(gate==='redirect'){res.writeHead(302,{Location:trapOrigin});res.end();return;}
  if(gate==='html'){res.writeHead(403,{'Content-Type':'text/html'});res.end('<html>'+clientSecret+'</html>');return;}
  if(req.headers['cf-access-client-id']!==clientId||req.headers['cf-access-client-secret']!==clientSecret){res.writeHead(403,{'Content-Type':'text/html'});res.end('Access denied');return;}
  const chunks=[];for await(const chunk of req)chunks.push(chunk);workerRequests++;
  const response=await mf.dispatchFetch(origin+req.url,{method:req.method,headers:req.headers,...(chunks.length?{body:Buffer.concat(chunks)}:{})});res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch{res.writeHead(500);res.end('synthetic boundary failure');}});await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
 let service={version:1,environment:'synthetic-local',origin,applicationId,serviceTokenId,expiresAt:Math.floor(Date.now()/1000)+600,clientId,clientSecret};
 const app={version:1,environment:'synthetic-local',origin,principalId:'A',credentialId:'A-key',token:appToken};
 const options={origin,environment:'synthetic-local',principalId:'A',credentialId:'A-key',loadCredential:async()=>app,access:{mode:'service-auth',applicationId,serviceTokenId,loadCredential:async()=>service}};
 let client;
 await test('dual admission and independent app identity; one write through unchanged API/receipt/history',async()=>{client=await privateAgentClient(options);const r=await client.api('/api/projects/P/issues','POST',{operationId:'access-one-create',title:'synthetic',body:'test'});assert.equal(r.snapshot.createdById,'A');assert.deepEqual((await client.api('/api/projects/P/issue-operations/access-one-create')).snapshot,r.snapshot);assert.equal((await client.api('/api/projects/P/issues/'+r.snapshot.id)).issue.body,'test');assert((await client.api('/api/projects/P/issues/'+r.snapshot.id+'/history')).history.some(h=>h.actorId==='A'||h.principalId==='A'));});
 await test('mutating caller targets and provider cannot retarget either credential',async()=>{options.origin=trapOrigin;options.principalId='B';options.access.applicationId='33333333-3333-4333-8333-333333333333';options.access.loadCredential=async()=>{throw Error('mutated')};assert.equal((await client.identity()).principal.id,'A');assert.equal(trapRequests,0);});
 await test('expiry and mismatched envelope are rejected before every wire',async()=>{const before=requests;const saved=service;for(const changed of [{expiresAt:0},{origin:trapOrigin},{applicationId:'wrong'},{serviceTokenId:'wrong'},{clientSecret:'bad\nheader'},{environment:'production'},{extra:true}]){service={...saved,...changed};await assert.rejects(client.identity(),/admission_provider_unavailable/);}service=saved;assert.equal(requests,before);});
 const fresh=()=>({...options,origin,principalId:'A',access:{mode:'service-auth',applicationId,serviceTokenId,loadCredential:async()=>service}});
 await test('invalid configuration and provider failure have fixed secret-free errors',async()=>{let n=requests;await assert.rejects(privateAgentClient({...fresh(),access:{mode:'service-auth',applicationId,serviceTokenId}}),/access_service_configuration_invalid/);await assert.rejects(privateAgentClient({...fresh(),access:{...fresh().access,loadCredential:async()=>{throw Error(clientSecret)}}}),e=>e.message==='admission_provider_unavailable'&&!JSON.stringify(e).includes(clientSecret));assert.equal(requests,n);});
 await test('real HTTP redirect not followed and HTML response never exposes body',async()=>{let before=workerRequests;gate='redirect';await assert.rejects(client.identity(),e=>e.code==='application_transport_unavailable'&&!JSON.stringify(e).includes(clientSecret));assert.equal(trapRequests,0);gate='html';await assert.rejects(client.identity(),e=>e.code==='application_response_invalid'&&!JSON.stringify(e).includes(clientSecret));assert.equal(workerRequests,before);gate='allow';});
 await test('Access headers never replace application authentication or current scope',async()=>{await assert.rejects(privateAgentClient({...fresh(),loadCredential:async()=>({...app,token:'z'.repeat(43)})}),e=>e.status===401&&e.code==='unauthenticated');await assert.rejects(client.api('/api/projects/OTHER/issues'),e=>e.status===403&&e.code==='forbidden');await db.prepare("UPDATE api_credentials SET revoked_at=unixepoch() WHERE id='A-key'").run();await assert.rejects(client.identity(),e=>e.status===401&&e.code==='unauthenticated');await db.prepare("UPDATE api_credentials SET revoked_at=NULL WHERE id='A-key'").run();});
 await test('explicit private file provider shares no-discovery owner/mode/symlink boundary',async()=>{const p=tmp+'/service.json';await writeFile(p,JSON.stringify(service),{mode:0o600});assert.deepEqual(await accessServiceFileProvider(tmp,p)(),service);await chmod(p,0o644);await assert.rejects(accessServiceFileProvider(tmp,p)(),/private_file_required/);await chmod(p,0o600);await symlink(p,tmp+'/alias.json');await assert.rejects(accessServiceFileProvider(tmp,tmp+'/alias.json')());await writeFile(tmp+'/app.json',JSON.stringify(app),{mode:0o600});assert.deepEqual(await privateFileProvider(tmp,tmp+'/app.json')(),app);});
 assert.equal(await db.prepare('SELECT count(*) n FROM issues').first('n'),1);report.passed=true;
}finally{if(server)await new Promise(r=>server.close(r));if(trap)await new Promise(r=>trap.close(r));if(mf)await mf.dispose();await rm(tmp,{recursive:true,force:true});await writeFile('.local/evidence/retained-access-check.json',JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify(report));
