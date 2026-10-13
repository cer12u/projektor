// @module verification
// @role legacy-audit-integration
// Synthetic additive source-audit import through actual D1, then ordinary Worker source HTTP/MCP.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {CfWorkerJsonSchemaValidator} from '@modelcontextprotocol/client/validators/cf-worker';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {resolve,join,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {prepareLocalD1,verifyCanonicalLedger} from '../../support/local-d1-fixture.mjs';
const candidate=fileURLToPath(new URL('../../../',import.meta.url)),root=await mkdtemp(join(tmpdir(),'projektor-audit-'));
const hash=x=>createHash('sha256').update(x).digest('hex'),origin='https://audit.invalid',token='a'.repeat(43);
const output=resolve(candidate,'.local/evidence/legacy-audit-workerd.json');await mkdir(resolve(candidate,'.local/evidence'),{recursive:true});
const report={startedAt:new Date().toISOString(),passed:false,runnerSha256:hash(await readFile(fileURLToPath(import.meta.url))),syntheticOnly:true,privateRecordsLoaded:false,productionActions:0,externalRequests:0,scenarios:[]};
let mf,client;const captured=[];
try{
 const source=`import product from '${candidate}/src/apps/worker.ts';import {importLegacyGateAudit} from '${candidate}/src/adapters/d1/work/legacy-audit-import.ts';import {InputError} from '${candidate}/src/modules/change-outcomes.ts';import {ApiError} from '${candidate}/src/adapters/protocol-errors.ts';
 export default {async fetch(request,env){const mode=request.headers.get('X-Test-Mode'),raw=env.DB.withSession('first-primary');if(new URL(request.url).pathname==='/__audit'){
 const db={prepare:text=>raw.prepare(text),async batch(statements){const result=await raw.batch(mode==='fail_midway'?[...statements.slice(0,5),raw.prepare(\"INSERT INTO mutation_guards VALUES('synthetic-failure',999,0)\"),...statements.slice(5)]:statements);if(mode==='lose_ack')throw Error('Synthetic lost acknowledgment');return result;}};
 try{return Response.json(await importLegacyGateAudit(db,await request.text()));}catch(e){return Response.json({error:e instanceof ApiError||e instanceof InputError?e.code:'fixture_unavailable'},{status:e instanceof ApiError?e.status:e instanceof InputError?400:503});}}
 const wrap=(stmt,text)=>new Proxy(stmt,{get(t,k){if(k==='bind')return(...args)=>wrap(t.bind(...args),text);if(k==='first')return async(...args)=>{if(mode==='revoke_before_read'&&text.includes('FROM imported_entities e WHERE'))await raw.prepare(\"DELETE FROM memberships WHERE principal_id='AUDIT_AGENT' AND permission='view'\").run();return t.first(...args);};const v=Reflect.get(t,k);return typeof v==='function'?v.bind(t):v;}});
 const DB={withSession(){return {prepare:text=>wrap(raw.prepare(text),text),batch:statements=>raw.batch(statements)}}};
 const headers=new Headers(request.headers);headers.set('Host',new URL(request.url).host);return product.fetch(new Request(request,{headers}),{...env,DB});}};`;
 const bundle=join(root,'fixture.mjs'),compiled=await build({stdin:{contents:source,resolveDir:candidate,sourcefile:'legacy-audit-fixture.ts'},outfile:bundle,bundle:true,format:'esm',platform:'neutral',mainFields:['module','main'],conditions:['workerd','worker','browser'],external:['node:*','cloudflare:*'],metafile:true,plugins:[{name:'wasm',setup(b){b.onResolve({filter:/\.wasm$/},a=>({path:'./'+basename(a.path),external:true}));}}]});
 captured.push(...Object.keys(compiled.metafile.inputs).filter(p=>!p.includes('node_modules')&&!p.endsWith('legacy-audit-fixture.ts')));
 report.sourceHashes=Object.fromEntries(await Promise.all(captured.map(async p=>[p,hash(await readFile(resolve(candidate,p)))])));report.bundleSha256=hash(await readFile(bundle));report.fixtureSha256=hash(source);
 const modules=[{type:'ESModule',path:bundle,contents:await readFile(bundle,'utf8')}];for(const name of ['argon2.wasm','blake2b.wasm'])modules.push({type:'CompiledWasm',path:join(root,name),contents:await readFile(join(candidate,'src/adapters/crypto/generated',name))});
 const fixture=await prepareLocalD1(root);mf=new Miniflare(convertV4MiniflareOptions({name:'legacy-audit-test',modules,modulesRoot:root,compatibilityDate:'2026-10-09',compatibilityFlags:['nodejs_compat'],...fixture,bindings:{AUTH_ORIGIN:origin,MCP_ENABLED:'true'},serviceBindings:{ASSETS:()=>new Response('static')},outboundService:()=>{report.externalRequests++;throw Error('Outbound denied');},host:'127.0.0.1',port:0,cf:false,logRequests:false}));await mf.ready;
 const db=await mf.getD1Database('DB'),worker=await mf.getWorker();await verifyCanonicalLedger(db);
 await db.prepare("INSERT INTO principals VALUES('AUDIT_AGENT','agent','Synthetic audit reader',NULL,1,1)").run();await db.prepare("INSERT INTO api_credentials VALUES('AUDIT_KEY','AUDIT_AGENT',?,unixepoch()+3600,NULL)").bind(hash(token)).run();
 await db.prepare("INSERT INTO memberships VALUES('AUDIT_AGENT','P','view')").run();await db.prepare("INSERT INTO api_grants VALUES('AUDIT_KEY','P','view')").run();
 const issueP='I_'+'1'.repeat(64),issueQ='I_'+'2'.repeat(64),canonical=x=>JSON.stringify(Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))));
 await db.prepare("INSERT INTO import_runs VALUES('original-core',?,'verified','{\"issues\":2}',1)").bind('b'.repeat(64)).run();
 for(const [project,workspace,id]of [['P','W1',issueP],['Q','W2',issueQ]]){
  await db.prepare('INSERT INTO workspaces VALUES(?,?,?)').bind(workspace,'Synthetic workspace','{}').run();await db.prepare('INSERT INTO projects VALUES(?,?,?,?,?,?,?)').bind(project,workspace,project,project.toLowerCase(),'Synthetic project','','{}').run();
  const row={id,project_id:project,workspace_id:workspace,body:'Synthetic imported body',created_at:100};const json=canonical(row);
  await db.prepare("INSERT INTO issues(id,project_id,workspace_id,body,revision,created_at,updated_at,metadata_json) VALUES(?,?,?,'Synthetic imported body',1,'2000-01-01T00:00:00Z','2000-01-01T00:00:00Z','{}')").bind(id,project,workspace).run();
  await db.prepare("INSERT INTO imported_entities VALUES('issues',?,?,?,?,?)").bind(id,workspace,project,json,hash(json)).run();await db.prepare("INSERT INTO import_row_receipts VALUES('original-core','issues',?,?)").bind(id,hash(json)).run();
 }
 const rows=[{id:'audit-1',workspace_id:'W1',issue_id:issueP,occurred_at:0},{id:'audit-2',workspace_id:'W1',issue_id:issueP,occurred_at:100},{id:'audit-3',workspace_id:'W1',issue_id:issueP,occurred_at:101},{id:'audit-4',workspace_id:'W2',issue_id:issueQ,occurred_at:102}];
 const makeArtifact=rows=>({version:1,kind:'legacy-operational-audit-preservation',sourceTable:'issue_gate_rejections',sourceCount:rows.length,retrievedAt:'2026-10-13T00:00:00Z',rows,rowHashes:rows.map(r=>({id:r.id,sha256:hash(canonical(r))})),rowsSha256:hash('['+rows.map(canonical).join(',')+']')});
 const artifact=makeArtifact(rows),serialized=JSON.stringify(artifact);
 const callImport=async(text,mode='')=>{const response=await worker.fetch(origin+'/__audit',{method:'POST',headers:{'Content-Type':'application/json','X-Test-Mode':mode},body:text});return {status:response.status,body:await response.json()};};
 const counts=async()=>({audit:await db.prepare("SELECT count(*) n FROM imported_entities WHERE kind='issue_gate_rejections'").first('n'),runs:await db.prepare('SELECT count(*) n FROM import_runs').first('n'),receipts:await db.prepare('SELECT count(*) n FROM import_row_receipts').first('n'),history:await db.prepare('SELECT count(*) n FROM issue_history').first('n'),operations:await db.prepare('SELECT count(*) n FROM operation_results').first('n'),gate:await db.prepare('SELECT mode FROM write_gate WHERE id=1').first('mode')});
 assert.equal((await callImport(serialized)).status,409);await db.prepare("UPDATE write_gate SET mode='stopped' WHERE id=1").run();const before=await counts();
 assert.equal((await callImport(JSON.stringify({...artifact,rowsSha256:'0'.repeat(64)}))).status,400);assert.deepEqual(await counts(),before);
 const wrong=makeArtifact(rows.map((r,i)=>i===0?{...r,workspace_id:'W2'}:r));assert.equal((await callImport(JSON.stringify(wrong))).status,409);assert.deepEqual(await counts(),before);
 assert.equal((await callImport(serialized,'fail_midway')).status,409);assert.deepEqual(await counts(),before);
 report.scenarios.push({name:'stopped-gate_hash_and_original_relation_guards_and_midbatch_rollback',passed:true});
 let imported=await callImport(serialized,'lose_ack');assert.equal(imported.status,200,JSON.stringify(imported));assert.equal(imported.body.replayed,true);assert.equal(imported.body.count,4);
 const after=await counts();assert.deepEqual(after,{audit:4,runs:2,receipts:6,history:0,operations:0,gate:'stopped'});
 assert.equal((await callImport(serialized)).body.replayed,true);assert.deepEqual(await counts(),after);assert.equal((await callImport(serialized+' ')).status,409);assert.deepEqual(await counts(),after);
 assert.deepEqual(await db.prepare("SELECT input_hash,phase,counts FROM import_runs WHERE id='original-core'").first(),{input_hash:'b'.repeat(64),phase:'verified',counts:'{"issues":2}'});
 assert.deepEqual((await db.prepare("SELECT record,record_hash FROM imported_entities WHERE kind='issue_gate_rejections' ORDER BY id").all()).results,rows.map(r=>({record:canonical(r),record_hash:hash(canonical(r))})));
 report.scenarios.push({name:'additive_four_rows_exact_identifiers_unix_values_hashes_receipts_and_ack_recovery_without_native_history',passed:true});
 async function get(project,id,mode=''){const r=await worker.fetch(origin+'/api/projects/'+project+'/source/issues/'+id,{headers:{Authorization:'Bearer '+token,'X-Test-Mode':mode}});return {status:r.status,body:await r.json()};}
 let value=await get('P',issueP);assert.equal(value.status,200);assert.equal(value.body.historyTotal,3);assert.deepEqual(value.body.history.map(h=>({sourceTable:h.sourceTable,sourceId:h.sourceId,record:h.record})),rows.slice(0,3).map(r=>({sourceTable:'issue_gate_rejections',sourceId:r.id,record:r})));
 assert.equal((await get('Q',issueQ)).status,403);assert.equal((await get('P',issueQ)).status,404);
 client=new Client({name:'audit-reader',version:'1'},{jsonSchemaValidator:new CfWorkerJsonSchemaValidator()});await client.connect(new StreamableHTTPClientTransport(new URL(origin+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+token}},fetch:(url,init)=>worker.fetch(String(url),init)}));
 const mcp=await client.callTool({name:'source_get',arguments:{scopeId:'P',kind:'issues',id:issueP}});assert(!mcp.isError);assert.deepEqual(mcp.structuredContent,value.body);
 value=await get('P',issueP,'revoke_before_read');assert.equal(value.status,403);assert.equal(value.body.history,undefined);assert(!JSON.stringify(value.body).includes('audit-'));
 report.scenarios.push({name:'ordinary_http_and_official_mcp_source_history_with_current_scope_and_read_time_revocation',passed:true});
 report.changedSourcesDuringRun=[];for(const p of captured)if(hash(await readFile(resolve(candidate,p)))!==report.sourceHashes[p])report.changedSourcesDuringRun.push(p);
 assert.deepEqual(report.changedSourcesDuringRun,[]);assert.equal(report.externalRequests,0);report.passed=true;
}catch(error){report.failure=error.message;throw error;}finally{await client?.close();await mf?.dispose();report.finishedAt=new Date().toISOString();await writeFile(output,JSON.stringify(report,null,2)+'\n');await rm(root,{recursive:true,force:true});}
console.log(JSON.stringify({passed:report.passed,scenarios:report.scenarios,evidence:output}));
