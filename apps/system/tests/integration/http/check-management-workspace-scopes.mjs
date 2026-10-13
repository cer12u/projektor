// @module verification
// @role management-scope-runtime-contract
// Actual Worker HTTP, canonical local D1, and actual browser client transport/validation.
// Synthetic identities only; no deployed credentials, browser UI, or external requests.
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve,join,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {prepareLocalD1,verifyCanonicalLedger} from '../../support/local-d1-fixture.mjs';
const candidate=fileURLToPath(new URL('../../../',import.meta.url)),root=await mkdtemp(join(tmpdir(),'projektor-management-scope-'));
const origin='https://management.invalid',token='m'.repeat(43),workspace='workspace:11111111-1111-4111-8111-111111111111';
const hash=b=>createHash('sha256').update(b).digest('hex');
const report={passed:false,level:'source-bundled actual Worker HTTP and local workerd/D1; actual browser client in Node, not browser UI or deployed proof',externalRequests:0,productionActions:0,checks:[]};
let mf;
try{
 const spec=JSON.parse(await readFile('docs/openapi.json')),ajv=new Ajv({allErrors:true,strict:false,validateSchema:false});ajv.addSchema({...spec,$id:'contract'},'contract');
 for(const schema of [spec.components.schemas.ManagementMembership.properties.projectId,spec.components.schemas.ManagementScope.properties.projectId,spec.components.schemas.InitialProject.properties.projectId,spec.components.schemas.Project.properties.id]){const valid=ajv.compile(schema);assert(valid(workspace));assert(valid('P'));assert(!valid(workspace+'/escape'));}
 for(const [path,method]of [['/api/projects/{projectId}/memberships/{principalId}','put'],['/api/projects/{projectId}/credential-scopes/{credentialId}','put'],['/api/projects/{projectId}/principals/{principalId}/display','get'],['/api/management/records','get'],['/api/management/records/{targetId}','get'],['/api/management/history','get']]){const schema=spec.paths[path][method].parameters.find(p=>p.name==='projectId').schema;assert(ajv.compile(schema)(workspace));}
 assert(!ajv.compile(spec.components.schemas.Identifier)(workspace));report.checks.push('OpenAPI scopes include workspace; entity identifiers remain narrow');
 const fixture=await prepareLocalD1(root),bundle=join(root,'worker.mjs');
 const compilation=await build({stdin:{contents:`import product from '${candidate}/src/apps/worker.ts';export default {fetch(request,env){const headers=new Headers(request.headers);headers.set('Host',new URL(request.url).host);return product.fetch(new Request(request,{headers}),env);}};`,resolveDir:candidate,sourcefile:'management-scope-fixture.ts'},outfile:bundle,bundle:true,format:'esm',platform:'neutral',mainFields:['module','main'],conditions:['workerd','worker','browser'],external:['node:*','cloudflare:*'],metafile:true,plugins:[{name:'test-wasm',setup(b){b.onResolve({filter:/\.wasm$/},a=>({path:'./'+basename(a.path),external:true}));}}]});
 report.sourceHashes=Object.fromEntries(await Promise.all(Object.keys(compilation.metafile.inputs).filter(p=>!p.includes('node_modules')&&!p.endsWith('management-scope-fixture.ts')).map(async p=>[p,hash(await readFile(resolve(candidate,p)))])));
 const modules=[{type:'ESModule',path:bundle,contents:await readFile(bundle,'utf8')}];
 for(const name of ['argon2.wasm','blake2b.wasm'])modules.push({type:'CompiledWasm',path:join(root,name),contents:await readFile(join(candidate,'src/adapters/crypto/generated',name))});
 mf=new Miniflare(convertV4MiniflareOptions({name:'management-scope-check',modules,modulesRoot:root,compatibilityDate:'2026-10-09',compatibilityFlags:['nodejs_compat'],...fixture,bindings:{AUTH_ORIGIN:origin},serviceBindings:{ASSETS:()=>new Response('static')},outboundService:()=>{report.externalRequests++;throw Error('External request denied');},host:'127.0.0.1',port:0,cf:false,logRequests:false}));
 await mf.ready;const db=await mf.getD1Database('DB'),worker=await mf.getWorker();await verifyCanonicalLedger(db);
 for(const id of ['OWNER','TARGET']){await db.prepare('INSERT INTO principals VALUES(?,?,?,NULL,1,1)').bind(id,'agent',id).run();await db.prepare('INSERT INTO api_credentials VALUES(?,?,?,unixepoch()+3600,NULL)').bind(id+'_KEY',id,hash(id==='OWNER'?token:'t'.repeat(43))).run();}
 await db.prepare("UPDATE principal_management SET global_administrator=1 WHERE principal_id='OWNER'").run();
 for(const scope of [workspace,'P'])for(const id of ['OWNER','TARGET'])for(const p of id==='OWNER'?['view','manage','edit']:['view']){await db.prepare('INSERT INTO memberships VALUES(?,?,?)').bind(id,scope,p).run();await db.prepare('INSERT INTO api_grants VALUES(?,?,?)').bind(id+'_KEY',scope,p).run();}
 async function fetchHttp(path,init={}){return worker.fetch(origin+path,{...init,headers:{...Object.fromEntries(new Headers(init.headers)),Authorization:'Bearer '+token}});}
 async function http(path,method='GET',body){const r=await fetchHttp(path,{method,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});return{status:r.status,body:await r.json()};}
 const query=(kind,scope)=>new URLSearchParams({kind,projectId:scope}).toString();
 for(const scope of [workspace,'P']){
  const list=await http('/api/management/records?'+query('membership',scope));assert.equal(list.status,200,JSON.stringify(list));assert(list.body.records.some(r=>r.principalId==='TARGET'&&r.projectId===scope));
  for(const raw of [scope,encodeURIComponent(scope)]){const display=await http(`/api/projects/${raw}/principals/TARGET/display`);assert.equal(display.status,200,JSON.stringify(display));assert.equal(display.body.id,'TARGET');}
  const suffix=scope==='P'?'project':'workspace';
  for(const [kind,target,segment]of [['membership','TARGET','memberships'],['scope','TARGET_KEY','credential-scopes']]){
   const current=await http('/api/management/records/'+target+'?'+query(kind,scope));assert.equal(current.status,200,JSON.stringify(current));
   const operationId=suffix+'-'+kind,change={operationId,revision:current.body.snapshot.revision,permissions:['view','edit']};
   const saved=await http(`/api/projects/${encodeURIComponent(scope)}/${segment}/${target}`,'PUT',change);assert.equal(saved.status,200,JSON.stringify(saved));assert.equal(saved.body.snapshot.projectId,scope);assert.deepEqual(saved.body.snapshot.permissions,['edit','view']);
   const replay=await http(`/api/projects/${scope}/${segment}/${target}`,'PUT',change);assert.equal(replay.status,200,JSON.stringify(replay));assert.equal(replay.body.source,'recovered');
   const recovered=await http('/api/management/operations/'+operationId);assert.equal(recovered.status,200);assert.deepEqual(recovered.body.snapshot,saved.body.snapshot);
   const history=await http('/api/management/history?'+query(kind,scope)+'&targetId='+target);assert.equal(history.status,200);assert.equal(history.body.history.length,1);assert.deepEqual(history.body.history[0].after,saved.body.snapshot);
   const table=kind==='membership'?'memberships':'api_grants',column=kind==='membership'?'principal_id':'credential_id';assert.deepEqual((await db.prepare(`SELECT permission FROM ${table} WHERE ${column}=? AND project_id=? ORDER BY permission`).bind(target,scope).all()).results.map(r=>r.permission),['edit','view']);
  }
 }
 report.checks.push('workspace and project list/detail/display/membership/credential scope/replay/result/history and persisted rights');
 const input={operationId:'register-workspace',principalId:'REGISTERED',kind:'agent',displayName:'Registered',loginId:null,projects:[{projectId:workspace,permissions:['view']}]};
 const registered=await http('/api/management/principals','POST',input);assert.equal(registered.status,200,JSON.stringify(registered));
 const audit=await http('/api/management/history?kind=principal&targetId=REGISTERED');assert.equal(audit.status,200,JSON.stringify(audit));assert.deepEqual(audit.body.history[0].initialProjects,input.projects);
 report.checks.push('explicit workspace registration and creation audit');
 await build({stdin:{contents:"export {ManagementClient} from './src/web/administration/management-client';export * from './src/web/administration/management-model';",resolveDir:candidate,sourcefile:'management-browser-contract.ts'},outfile:join(root,'browser.mjs'),bundle:true,platform:'node',format:'esm'});
 const browser=await import(pathToFileURL(join(root,'browser.mjs')).href);Object.defineProperty(globalThis.navigator,'locks',{configurable:true,value:{request:(_name,_options,work)=>work()}});globalThis.fetch=fetchHttp;
 const client=new browser.ManagementClient('OWNER',()=>{}),context=await client.context();assert(context.projects.some(p=>p.id===workspace));
 const listing=await client.list('membership',workspace);assert(listing.records.some(r=>r.snapshot.principalId==='TARGET'));
 const current=await client.current('membership','TARGET',workspace),submission={operationId:'browser-workspace-edit',record:current.record,draft:{displayName:'',active:false,permissions:['view']}};
 assert.deepEqual(browser.restoreSubmission(submission),submission);const saved=await client.send(submission);assert.equal(saved.snapshot.projectId,workspace);assert.deepEqual(saved.snapshot.permissions,['view']);assert.deepEqual(await client.result(submission.operationId),saved);assert.equal((await client.history(saved)).history.length,2);
 assert.deepEqual(browser.registrationInput(input),input);assert.deepEqual(browser.historyInitialProjects(input.projects),input.projects);
 report.checks.push('actual browser client query/response/command/receipt/history/recovery and registration workspace contracts');
 const before=await db.prepare('SELECT count(*) n FROM management_audit').first('n');
 for(const invalid of ['workspace:bad',workspace+'/escape',workspace+'?x=1',workspace+'#fragment',workspace+'%2Fescape','workspace:'+ 'g'.repeat(36)]){
  assert.throws(()=>browser.managementQuery('membership',invalid));assert.throws(()=>browser.managementRecord({...saved.snapshot,projectId:invalid}));assert.throws(()=>browser.registrationInput({...input,projects:[{projectId:invalid,permissions:['view']}]}));
  assert.equal((await http('/api/management/records?'+query('membership',invalid))).status,400);
  const result=await http(`/api/projects/${encodeURIComponent(invalid)}/memberships/TARGET`,'PUT',{operationId:'invalid-scope',revision:saved.snapshot.revision,permissions:[]});assert(result.status>=400);
 }
 for(const field of ['principalId','operationId'])assert.throws(()=>browser.registrationInput({...input,[field]:workspace}));
 assert.throws(()=>browser.managementRecord({...saved.snapshot,principalId:workspace}));
 for(const path of [`/api/management/principals/${encodeURIComponent(workspace)}`,`/api/management/credentials/${encodeURIComponent(workspace)}/revoke`,`/api/management/operations/${encodeURIComponent(workspace)}`])assert((await http(path)).status>=400);
 assert.equal((await http(`/api/projects/${encodeURIComponent(workspace)}/memberships/TARGET`,'PUT',{operationId:workspace,revision:saved.snapshot.revision,permissions:[]})).status,400);
 assert.equal(await db.prepare('SELECT count(*) n FROM management_audit').first('n'),before);report.checks.push('malformed/injected scope IDs rejected; entity and operation IDs remain narrow; no mutation');
 await db.prepare("UPDATE principal_management SET global_administrator=0 WHERE principal_id='OWNER'").run();
 // Revocation of workspace management does not become a global-admin override.
 await db.prepare("DELETE FROM memberships WHERE principal_id='OWNER' AND project_id=? AND permission='manage'").bind(workspace).run();
 assert.equal((await http('/api/management/records?'+query('membership',workspace))).status,403);assert.equal((await http('/api/management/operations/browser-workspace-edit')).status,403);assert.equal((await http('/api/management/records?'+query('membership','P'))).status,200);
 report.checks.push('workspace authorization remains current and isolated from project/global authority');assert.equal(report.externalRequests,0);report.passed=true;
}catch(error){report.failure=error.message;throw error;}finally{await mf?.dispose();await mkdir('.local/evidence',{recursive:true});await writeFile('.local/evidence/management-workspace-scopes.json',JSON.stringify(report,null,2)+'\n');await rm(root,{recursive:true,force:true});}
console.log(JSON.stringify({passed:report.passed,checks:report.checks}));
