// @module verification
// @role review-sql-list-size
// Scoped review: real official client + production router + local workerd/D1.
// Synthetic identity/content only. No remote OAuth or production action.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {CfWorkerJsonSchemaValidator} from '@modelcontextprotocol/client/validators/cf-worker';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,basename} from 'node:path';
import {prepareLocalD1,verifyCanonicalLedger} from "../../support/local-d1-fixture.mjs";
const root=await mkdtemp(join(tmpdir(),'projektor-list-review-'));
await mkdir('.local/evidence',{recursive:true});
const report={scope:'SQL-summary MCP list and full input recovery; isolated workerd/D1',operationIntentsHash:createHash('sha256').update(await readFile('src/adapters/d1/persistence/prepared-operations.ts')).digest('hex'),productionActions:0,sourceHash:createHash('sha256').update(await readFile('src/apps/mcp/tools.ts')).digest('hex'),results:[]};
const origin='https://projektor.example.invalid',issuer='https://synthetic-owner.cloudflareaccess.com',aud='a'.repeat(64),subject='list-review';
const pair=await generateKeyPair('RS256',{extractable:true}),jwk={...await exportJWK(pair.publicKey),kid:'list-review',alg:'RS256',use:'sig'};
let mf,db,worker,client,fixture,maxD1ListResultBytes=0,maxD1ListResultRows=0;
async function start(){
 if(client){await client.close();client=undefined;}if(mf)await mf.dispose();
 mf=new Miniflare(convertV4MiniflareOptions({name:'list-size-review',modules:[{type:'ESModule',path:root+'/worker.mjs',contents:await readFile(root+'/worker.mjs','utf8')},...await Promise.all(['argon2.wasm','blake2b.wasm'].map(async name=>({type:'CompiledWasm',path:root+'/'+name,contents:await readFile('src/adapters/crypto/generated/'+name)})))],modulesRoot:root,compatibilityDate:'2026-10-09',compatibilityFlags:['nodejs_compat'],...fixture,bindings:{AUTH_ORIGIN:origin,MCP_ENABLED:'true',MCP_ACCESS_ISSUER:issuer,MCP_ACCESS_AUDIENCE:aud,MCP_RESOURCE_METADATA_URL:origin+'/.well-known/cloudflare-access-protected-resource/'},serviceBindings:{ASSETS:()=>new Response('SPA')},outboundService:r=>{assert.equal(r.url,issuer+'/cdn-cgi/access/certs');return Response.json({keys:[jwk]});},host:'127.0.0.1',port:0,cf:false,logRequests:false}));
 await mf.ready;db=await mf.getD1Database('DB');worker=await mf.getWorker();
}
async function connect(who=subject){if(client)await client.close();const now=Math.floor(Date.now()/1000),token=await new SignJWT({iss:issuer,aud:[aud],sub:who,type:'app',iat:now,nbf:now,exp:now+600}).setProtectedHeader({alg:'RS256',kid:jwk.kid}).sign(pair.privateKey);client=new Client({name:'independent-list-review',version:'1.0.0'},{jsonSchemaValidator:new CfWorkerJsonSchemaValidator()});await client.connect(new StreamableHTTPClientTransport(new URL(origin+'/mcp/federated'),{requestInit:{headers:{Host:new URL(origin).host,'Cf-Access-Jwt-Assertion':token},redirect:'error'},fetch:async(url,init)=>{const response=await worker.fetch(String(url),init);maxD1ListResultBytes=Math.max(maxD1ListResultBytes,Number(response.headers.get('X-Review-List-Result-Bytes')));maxD1ListResultRows=Math.max(maxD1ListResultRows,Number(response.headers.get('X-Review-List-Result-Rows')));return response;}}));}
async function call(name,args={}){const result=await client.callTool({name,arguments:args});assert.equal(result.isError,undefined,JSON.stringify(result));return result;}
try{
 await build({entryPoints:['tests/integration/d1/__independent_list_sql_fixture.ts'],outfile:root+'/worker.mjs',bundle:true,format:'esm',platform:'neutral',conditions:['workerd','worker','browser'],mainFields:['module','main'],external:['node:*','cloudflare:*'],plugins:[{name:'wasm',setup(b){b.onResolve({filter:/\.wasm$/},a=>({path:'./'+basename(a.path),external:true}));}}]});
 fixture=await prepareLocalD1(root);await start();await verifyCanonicalLedger(db);
 await db.prepare("INSERT INTO principals VALUES('A','agent','List review',NULL,1,1)").run();
 for(const p of ['view','edit'])await db.prepare("INSERT INTO memberships VALUES('A','P',?)").bind(p).run();
 await db.prepare('INSERT INTO federated_bindings VALUES(?,?,?,?,?,unixepoch())').bind('list-binding','A',issuer,aud,subject).run();
 await db.prepare("INSERT INTO federated_credentials(id,binding_id,principal_auth_version,created_at,expires_at) VALUES('list-credential','list-binding',1,unixepoch()-100,unixepoch()+3600)").run();
 for(const p of ['view','edit'])await db.prepare("INSERT INTO federated_grants VALUES('list-credential','P',?)").bind(p).run();
 await db.prepare("UPDATE write_gate SET mode='open' WHERE id=1").run();await connect();
 const inputBody='PRIVATE LARGE RECOVERY INPUT '+ 'x'.repeat(31960),inputs=[];
 for(let n=0;n<50;n++){const input={operationId:'large-'+String(n).padStart(2,'0'),title:'Large wiki '+n,body:inputBody};inputs.push(input);const prepared=(await call('wiki_create_prepare',{scopeId:'P',input})).structuredContent;assert.equal(prepared.recorded,true);assert.equal(prepared.result.status,'unknown');}
 assert.equal(await db.prepare('SELECT count(*) FROM content_documents').first('count(*)'),0);
 await call('operation_execute',{operationId:inputs[0].operationId});await start();await connect();
 const normal=await call('operation_list');assert.equal(normal.structuredContent.operations.length,20);assert(normal.structuredContent.nextAfter!==null);
 const maximum=await call('operation_list',{limit:50});assert.equal(maximum.structuredContent.operations.length,50);assert.equal(maximum.structuredContent.nextAfter,null);
 const bytes=Buffer.byteLength(JSON.stringify(maximum));assert(bytes<50000,'Discovery wire payload '+bytes+' bytes');
 for(const row of maximum.structuredContent.operations){assert(!Object.hasOwn(row,'input'));assert(!Object.hasOwn(row,'route'));assert(!Object.hasOwn(row.result,'snapshot'));assert(['confirmed','unknown'].includes(row.result.status));}
 assert(!JSON.stringify(maximum).includes('PRIVATE LARGE RECOVERY INPUT'));report.results.push({name:'fifty large durable inputs yield bounded summary-only discovery',passed:true,retainedInputBytes:Buffer.byteLength(inputBody)*50,discoveryResultBytes:bytes});
 const ids=[];let after=0;do{const page=(await call('operation_list',{after,limit:7})).structuredContent;ids.push(...page.operations.map(o=>o.operationId));after=page.nextAfter;}while(after!==null);assert.deepEqual(ids,inputs.map(i=>i.operationId));
 for(const index of [0,49]){const recovered=(await call('operation_get',{operationId:ids[index]})).structuredContent;assert.deepEqual(recovered.input,inputs[index]);assert.equal(recovered.result.status,index===0?'confirmed':'unknown');if(index===0)assert.equal(recovered.result.snapshot.body,inputBody);}
 assert.equal((await call('operation_execute',{operationId:ids[0]})).structuredContent.source,'recovered');assert.equal(await db.prepare('SELECT count(*) FROM content_documents').first('count(*)'),1);assert.equal(await db.prepare('SELECT count(*) FROM operation_results').first('count(*)'),1);
 report.results.push({name:'paginated summary IDs recover exact full input and confirmed result after new runtime',passed:true});
 const catalogueA=await client.listTools();assert.equal(catalogueA.tools.length,29);
 await db.prepare("INSERT INTO principals VALUES('B','agent','Second list reviewer',NULL,1,1)").run();
 await db.prepare('INSERT INTO federated_bindings VALUES(?,?,?,?,?,unixepoch())').bind('binding-B','B',issuer,aud,'list-review-B').run();
 await db.prepare("INSERT INTO federated_credentials(id,binding_id,principal_auth_version,created_at,expires_at) VALUES('credential-B','binding-B',1,unixepoch()-100,unixepoch()+3600)").run();
 await connect('list-review-B');assert.deepEqual(await client.listTools(),catalogueA);assert.equal((await call('identity_current')).structuredContent.principal.id,'B');assert.deepEqual((await call('operation_list')).structuredContent.operations,[]);
 const cross=await client.callTool({name:'operation_get',arguments:{operationId:ids[0]}});assert.equal(cross.isError,true);assert(!JSON.stringify(cross).includes(inputBody));await connect();assert.equal((await call('identity_current')).structuredContent.principal.id,'A');
 report.results.push({name:'cached public catalogue is shared while identities and recovery remain principal-local',passed:true});
 await db.prepare(`INSERT INTO operation_intents(principal_id,operation_id,format_version,operation_kind,target_id,project_id,route_json,input_json,input_hash,required_permissions,prepared_at)
 SELECT principal_id,'future-known-shape',2,operation_kind,target_id,project_id,route_json,json_set(input_json,'$.operationId','future-known-shape'),input_hash,required_permissions,prepared_at FROM operation_intents WHERE operation_id=?`).bind(ids[49]).run();
 const future=(await call('operation_get',{operationId:'future-known-shape'})).structuredContent;assert.equal(future.formatVersion,2);assert.equal(future.input.body,inputBody);
 const futurePage=(await call('operation_list',{after:maximum.structuredContent.operations.at(-1).sequence,limit:2})).structuredContent;assert.equal(futurePage.operations[0].formatVersion,2);assert(!Object.hasOwn(futurePage.operations[0],'input'));
 const blocked=await client.callTool({name:'operation_execute',arguments:{operationId:'future-known-shape'}});assert.equal(blocked.isError,true);assert.equal(blocked.structuredContent.status,409);assert.equal(blocked.structuredContent.error,'operation_format_unsupported');assert.equal(await db.prepare('SELECT count(*) FROM operation_results').first('count(*)'),1);
 await call('operation_list',{limit:50});report.results.push({name:'retained known-shape future version remains discoverable and readable but cannot execute',passed:true});
 await db.prepare("DELETE FROM federated_grants WHERE credential_id='list-credential' AND permission='edit'").run();assert.deepEqual((await call('operation_list')).structuredContent.operations,[]);const denied=await client.callTool({name:'operation_get',arguments:{operationId:ids[0]}});assert.equal(denied.isError,true);assert(!JSON.stringify(denied).includes(inputBody));report.results.push({name:'summary discovery and full recovery retain current grant ceiling',passed:true});
 const firstPage=await call('operation_list',{limit:50});assert.deepEqual(firstPage.structuredContent.operations,[]);
 assert.equal(maxD1ListResultRows,51);assert(maxD1ListResultBytes<30000,'Internal D1 result '+maxD1ListResultBytes+' bytes');report.results.push({name:'D1 list serializes only bounded summaries including pagination probe row',passed:true,maxD1ListResultBytes,maxD1ListResultRows});
 report.passed=true;
}catch(error){report.passed=false;report.failure=String(error);throw error;}finally{if(client)await client.close();if(mf)await mf.dispose();await rm(root,{recursive:true,force:true});await writeFile('.local/evidence/independent-sql-list-size.json',JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify(report));
