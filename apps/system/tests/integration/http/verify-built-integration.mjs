// @module verification
// @role independent-built-integration
// Independent integration evidence. Loads release bytes; never rebuilds product or calls a provider.
import assert from 'node:assert/strict';
import {readFile,readdir,writeFile,mkdtemp,rm,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
const candidate=fileURLToPath(new URL('../../../',import.meta.url));
const out=resolve(candidate,'.local/verification/independent-integration');
await mkdir(out,{recursive:true});
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {CfWorkerJsonSchemaValidator} from '@modelcontextprotocol/client/validators/cf-worker';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {prepareLocalD1,verifyCanonicalLedger} from '../../support/local-d1-fixture.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
async function inventory(root,prefix=''){const records={};for(const d of await readdir(join(root,prefix),{withFileTypes:true})){const p=prefix+d.name;if(d.isDirectory())Object.assign(records,await inventory(root,p+'/'));else if(d.isFile()){const bytes=await readFile(join(root,p));records[p]={bytes:bytes.length,sha256:hash(bytes)};}else throw Error('Unexpected non-file artifact');}return Object.fromEntries(Object.entries(records).sort(([a],[b])=>Buffer.compare(Buffer.from(a),Buffer.from(b))));}
const tree=records=>hash(Buffer.concat(Object.entries(records).map(([p,r])=>Buffer.from(p+'\0'+r.bytes+'\0'+r.sha256+'\n'))));
const artifacts=await inventory(join(candidate,'dist'));
assert(artifacts['worker/index.js'],'Frozen worker is required');
const report={scope:'exact built Worker/WASM; actual local workerd and canonical D1; official MCP client; synthetic identities; no browser, network TLS, frontdoor or production',startedAt:new Date().toISOString(),passed:false,productionActions:0,externalRequests:0,artifactTreeSha256:tree(artifacts),artifacts,routeChecks:[],scenarios:[]};
const root=await mkdtemp(join(tmpdir(),'projektor-independent-built-'));
const origin='https://integration.invalid',token='j'.repeat(43),principal='INDEPENDENT_AGENT',credential='INDEPENDENT_KEY';
const spec=JSON.parse(await readFile(join(candidate,'docs/openapi.json')));
report.openapiSha256=hash(await readFile(join(candidate,'docs/openapi.json')));
let mf,db,client,worker,syntheticJwk;
const issuer='https://synthetic-owner.cloudflareaccess.com',audience='a'.repeat(64);
report.syntheticJwksRequests=0;
const fixtureSource=`import product from './index.js';export {RateLimiter,WorkspaceHub} from './index.js';export default {fetch(request,env,context){const headers=new Headers(request.headers);headers.set('Host',headers.get('X-Independent-Original-Host')??new URL(request.url).host);headers.delete('X-Independent-Original-Host');return product.fetch(new Request(request,{headers}),env,context);}};`;
report.fixture={sha256:hash(fixtureSource),transformation:'Restore Host from original request URL because Miniflare overwrites it with loopback host; explicit wrong-host case uses synthetic X-Independent-Original-Host. No URL, Origin, auth, body or product byte transformation.',networkTls:false};
const modules=[{type:'ESModule',path:join(root,'entry.mjs'),contents:fixtureSource},{type:'ESModule',path:join(root,'index.js'),contents:await readFile(join(candidate,'dist/worker/index.js'),'utf8')}];
for(const name of await readdir(join(candidate,'dist/worker')))if(name.endsWith('.wasm'))modules.push({type:'CompiledWasm',path:join(root,name),contents:await readFile(join(candidate,'dist/worker',name))});
let options;
async function start(){mf=new Miniflare(convertV4MiniflareOptions(options));await mf.ready;db=await mf.getD1Database('DB');worker=await mf.getWorker();await verifyCanonicalLedger(db);}
function classify(path){
 if(path==='/api/health')return 'public-nonbusiness-health';
 if(path==='/api/auth/context')return 'public-login-challenge-context';
 if(path==='/api/auth/login')return 'login-challenge-csrf-and-password';
 if(path.startsWith('/api/auth/password-setup/owner-initial'))return path.endsWith('/context')?'login-challenge-csrf-mints-owner-capability':path==='/api/auth/password-setup/owner-initial'?'owner-capability-csrf-and-verified-external-owner':'owner-capability-csrf';
 if(path.startsWith('/api/auth/password-setup/'))return 'login-challenge-csrf-and-bearer-setup-right';
 if(path==='/api/auth/browser-session/context')return 'login-challenge-csrf-mints-exchange-capability';
 if(path==='/api/auth/browser-session/redeem')return 'exchange-capability-csrf-nonce-and-one-time-ticket';
 if(path==='/api/auth/browser-session/tickets')return 'individual-agent-app-credential';
 if(path==='/api/auth/logout')return 'human-or-derived-app-session-csrf';
 return 'app-session-or-individual-agent-credential-current-authorization';
}
const substitution=name=>/workspace/i.test(name)?'11111111-1111-4111-8111-111111111111':name==='sourceTable'?'issues':/project/i.test(name)?'P':/issue|parent/i.test(name)?'I_'+'1'.repeat(64):/content/i.test(name)?'W_'+'2'.repeat(64):'known';
async function http(path,method='GET',body,headers={}){const response=await worker.fetch(origin+path,{method,headers:{Host:'integration.invalid',Origin:origin,...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});return{status:response.status,headers:response.headers,body:await response.json()};}
async function protectedState(){const tables=['principals','memberships','api_credentials','api_grants','passwords','password_setup_rights','owner_setup_contexts','sessions','operation_results','operation_intents','issues','issue_history','issue_execution_attempts','issue_execution_report_events'];const out={};for(const name of tables)out[name]=(await db.prepare('SELECT count(*) n FROM '+name).first()).n;return out;}
async function connect(){client=new Client({name:'independent-built-integration',version:'1.0.0'},{jsonSchemaValidator:new CfWorkerJsonSchemaValidator()});await client.connect(new StreamableHTTPClientTransport(new URL(origin+'/mcp'),{requestInit:{headers:{Host:'integration.invalid',Authorization:'Bearer '+token},redirect:'error'},fetch:(url,init)=>worker.fetch(String(url),init)}));}
async function tool(name,args={}){const r=await client.callTool({name,arguments:args});assert(!r.isError,JSON.stringify(r));assert.deepEqual(JSON.parse(r.content[0].text),r.structuredContent);return r.structuredContent;}
try{
 const fixture=await prepareLocalD1(root);
 options={name:'independent-built',routes:['integration.invalid/*','wrong.invalid/*'],modules,modulesRoot:root,compatibilityDate:'2026-10-09',compatibilityFlags:['nodejs_compat'],...fixture,bindings:{AUTH_ORIGIN:origin,MCP_ENABLED:'true'},serviceBindings:{ASSETS:()=>new Response('public static asset')},outboundService:request=>{if(syntheticJwk&&request.url===issuer+'/cdn-cgi/access/certs'){for(const h of ['Authorization','Cookie','Cf-Access-Jwt-Assertion'])assert.equal(request.headers.get(h),null);report.syntheticJwksRequests++;return Response.json({keys:[syntheticJwk]});}report.externalRequests++;throw Error('External request denied');},host:'127.0.0.1',port:0,cf:false,logRequests:false};
 await start();
 const canary='UNAUTHORIZED_PRIVATE_CANARY';
 await db.prepare("INSERT INTO issues(id,project_id,body,revision,created_at,updated_at) VALUES(?, 'P', ?, 1, '2026-10-12T00:00:00Z', '2026-10-12T00:00:00Z')").bind('I_'+'1'.repeat(64),canary).run();
 const before=await protectedState();
 for(const [path,item]of Object.entries(spec.paths))for(const [method,operation]of Object.entries(item)){
  if(!['get','post','put','patch','delete','head','options'].includes(method))continue;
  const classification=classify(path),actual=path.replace(/\{([^}]+)\}/g,(_,name)=>substitution(name));
  const publicRoute=classification.startsWith('public-');
  const body=path==='/api/auth/login'?{loginId:'synthetic',password:'Synthetic-test-password'}:path.startsWith('/api/auth/password-setup/owner-initial')?{...(path.endsWith('/context')?{}:{operationId:'known'}),...(path.endsWith('/complete')?{password:'Synthetic-test-password'}:{})}:path.startsWith('/api/auth/password-setup/')?{setupRight:'z'.repeat(43),...(path.endsWith('/context')?{}:{operationId:'known'}),...(path.endsWith('/complete')?{password:'Synthetic-test-password'}:{})}:path.startsWith('/api/auth/browser-session/')?{nonce:'z'.repeat(43),...(path.endsWith('/redeem')?{ticket:'t'.repeat(43)}:{})}:{};
  const result=await http(actual,method.toUpperCase(),method==='get'?undefined:body);
  const expected=publicRoute?200:classification==='app-session-or-individual-agent-credential-current-authorization'||classification==='individual-agent-app-credential'||classification==='human-or-derived-app-session-csrf'?401:403;
  assert.equal(result.status,expected,JSON.stringify({path,method,status:result.status,body:result.body}));
  if(!publicRoute){assert(Object.keys(result.body).every(k=>['error','operationId','application'].includes(k)),JSON.stringify({path,leakedKeys:Object.keys(result.body)}));assert(!JSON.stringify(result.body).includes(canary));assert(!['not_found','operation_not_found'].includes(result.body.error),'Authentication must not disclose existence');}
  report.routeChecks.push({method:method.toUpperCase(),path,classification,anonymousStatus:result.status,expectedAnonymousStatus:expected,error:result.body.error??null});
  if(classification.includes('app-credential')||classification==='app-session-or-individual-agent-credential-current-authorization'){
   const invalid=await http(actual,method.toUpperCase(),method==='get'?undefined:{},{Authorization:'Bearer invalid','Cf-Access-Jwt-Assertion':'forged'});
   assert.equal(invalid.status,401,JSON.stringify({path,method,status:invalid.status}));
   report.routeChecks.at(-1).malformedAppCredentialStatus=invalid.status;
  }
 }
 assert.deepEqual(await protectedState(),before,'Unauthenticated sweep must not change protected identity or business state');
 report.scenarios.push({name:'all documented routes classify and reject anonymous protected operations without protected-state mutation',passed:true});
 for(const [path,headers,status]of [['/mcp',{},401],['/mcp',{'Cf-Access-Jwt-Assertion':'forged'},401],['/mcp',{Cookie:'__Host-projektor_session='+'x'.repeat(43)},400],['/mcp/federated',{},404],['/.well-known/oauth-protected-resource',{},404],['/mcp/other',{},404],['/mcp',{Origin:'https://wrong.invalid'},403],['/mcp',{'X-Independent-Original-Host':'wrong.invalid'},403]]){
  const r=await http(path,'POST',{},headers);assert.equal(r.status,status,JSON.stringify({path,headers,actual:r.status,body:r.body}));report.routeChecks.push({method:'POST',path,classification:'mcp-reserved-explicit-entrance',expectedStatus:status,status:r.status,error:r.body.error});
 }
 report.scenarios.push({name:'MCP application entrance has no assertion fallback; optional federation and reserved discovery remain separate',passed:true});
 await db.prepare('INSERT INTO principals VALUES(?,?,?,NULL,1,1)').bind(principal,'agent','Independent synthetic Agent').run();
 await db.prepare('INSERT INTO api_credentials VALUES(?,?,?,unixepoch()+3600,NULL)').bind(credential,principal,hash(token)).run();
 for(const permission of ['view','edit','assign','transition','execute']){await db.prepare('INSERT INTO memberships VALUES(?,?,?)').bind(principal,'P',permission).run();await db.prepare('INSERT INTO api_grants VALUES(?,?,?)').bind(credential,'P',permission).run();}
 await connect();
 const me=await tool('identity_current');assert.equal(me.principal.id,principal);assert.equal(me.authentication,'api');
 const catalogue=await client.listTools();assert(catalogue.tools.some(t=>t.name==='issue_get'));assert(catalogue.tools.some(t=>t.name==='operation_execute'));assert(catalogue.tools.every(t=>!t.securitySchemes&&!t._meta?.securitySchemes));
 const created=await http('/api/projects/P/issues','POST',{operationId:'cross_protocol_issue',body:'Independent original body 日本語',title:'Shared Work contract'},{Authorization:'Bearer '+token});assert.equal(created.status,200);
 const issue=await tool('issue_get',{projectId:'P',issueId:created.body.snapshot.id});assert.equal(issue.issue.body,'Independent original body 日本語');assert.equal(issue.issue.revision,1);
 const prepared=await tool('issue_update_prepare',{projectId:'P',issueId:issue.issue.id,input:{operationId:'cross_protocol_edit',revision:1,body:'Prepared MCP body'}});assert.equal(prepared.recorded,true);assert.equal(prepared.result.status,'unknown');
 assert.equal(await db.prepare('SELECT revision FROM issues WHERE id=?').bind(issue.issue.id).first('revision'),1);
 await client.close();client=undefined;await mf.dispose();mf=undefined;await start();await connect();
 const found=await tool('operation_list',{after:0,limit:20});assert(found.operations.some(x=>x.operationId==='cross_protocol_edit'));assert(found.operations.every(x=>!('input' in x)&&!('snapshot' in x.result)));
 const stored=await tool('operation_get',{operationId:'cross_protocol_edit'});assert.equal(stored.input.body,'Prepared MCP body');
 const committed=await tool('operation_execute',{operationId:'cross_protocol_edit'});assert.equal(committed.source,'committed');
 // Discard the successful execution payload before recovery, as if a transport response was lost.
 await client.close();client=undefined;await mf.dispose();mf=undefined;await start();
 const recovered=await http('/api/projects/P/issue-operations/cross_protocol_edit','GET',undefined,{Authorization:'Bearer '+token});assert.equal(recovered.status,200);assert.equal(recovered.body.snapshot.body,'Prepared MCP body');assert.equal(recovered.body.snapshot.revision,2);
 await connect();const replay=await tool('operation_execute',{operationId:'cross_protocol_edit'});assert.equal(replay.source,'recovered');
 assert.equal(await db.prepare("SELECT count(*) n FROM issue_history WHERE operation_id='cross_protocol_edit'").first('n'),1);assert.equal(await db.prepare("SELECT count(*) n FROM operation_results WHERE operation_id='cross_protocol_edit'").first('n'),1);
 report.scenarios.push({name:'REST-created issue read by official MCP; MCP preparation survives workerd restart; REST recovers result after discarded completion response; same-ID MCP execute recovers one receipt/history',passed:true,processStarts:3});
 await db.prepare('UPDATE api_credentials SET revoked_at=unixepoch() WHERE id=?').bind(credential).run();
 const denied=await http('/api/projects/P/issue-operations/cross_protocol_edit','GET',undefined,{Authorization:'Bearer '+token});assert.equal(denied.status,401);assert.equal(denied.body.application,'unknown');assert.equal(denied.body.operationId,'cross_protocol_edit');assert(!JSON.stringify(denied.body).includes('Prepared MCP body'));
 let mcpDenied=false;try{await client.callTool({name:'operation_get',arguments:{operationId:'cross_protocol_edit'}});}catch{mcpDenied=true;}assert(mcpDenied,'Existing official-client connection must fail on current revoked app credential');
 assert.equal(await db.prepare("SELECT count(*) n FROM operation_results WHERE operation_id='cross_protocol_edit'").first('n'),1);
 report.scenarios.push({name:'credential revocation denies REST receipt and existing MCP client without erasing committed result',passed:true});
 await client.close();client=undefined;await mf.dispose();mf=undefined;
 const pair=await generateKeyPair('RS256',{extractable:true});syntheticJwk={...await exportJWK(pair.publicKey),kid:'independent-synthetic',alg:'RS256',use:'sig'};
 options.bindings={...options.bindings,MCP_ACCESS_ISSUER:issuer,MCP_ACCESS_AUDIENCE:audience,MCP_RESOURCE_METADATA_URL:origin+'/.well-known/oauth-protected-resource'};
 await start();
 const sign=async(subject,expires=600)=>{const now=Math.floor(Date.now()/1000);return new SignJWT({iss:issuer,aud:[audience],sub:subject,type:'app',iat:now,nbf:now,exp:now+expires}).setProtectedHeader({alg:'RS256',kid:syntheticJwk.kid}).sign(pair.privateKey);};
 const federated='INDEPENDENT_FEDERATED',subject='independent-federated-subject',assertion=await sign(subject);
 const beforeUnbound=await db.prepare('SELECT count(*) n FROM principals').first('n');
 const unbound=await http('/mcp/federated','POST',{}, {'Cf-Access-Jwt-Assertion':assertion});assert.equal(unbound.status,403);assert.equal(await db.prepare('SELECT count(*) n FROM principals').first('n'),beforeUnbound);
 await db.prepare('INSERT INTO principals VALUES(?,?,?,NULL,1,1)').bind(federated,'agent','Independent federated synthetic Agent').run();
 await db.prepare('INSERT INTO federated_bindings VALUES(?,?,?,?,?,unixepoch())').bind('INDEPENDENT_BINDING',federated,issuer,audience,subject).run();
 await db.prepare("INSERT INTO federated_credentials(id,binding_id,principal_auth_version,created_at,expires_at) VALUES('INDEPENDENT_FED_KEY','INDEPENDENT_BINDING',1,unixepoch(),unixepoch()+3600)").run();
 await db.prepare('INSERT INTO memberships VALUES(?,?,?)').bind(federated,'P','view').run();await db.prepare('INSERT INTO federated_grants VALUES(?,?,?)').bind('INDEPENDENT_FED_KEY','P','view').run();
 client=new Client({name:'independent-final-federated',version:'1.0.0'},{jsonSchemaValidator:new CfWorkerJsonSchemaValidator()});
 await client.connect(new StreamableHTTPClientTransport(new URL(origin+'/mcp/federated'),{requestInit:{headers:{Host:'integration.invalid','Cf-Access-Jwt-Assertion':assertion},redirect:'error'},fetch:(url,init)=>worker.fetch(String(url),init)}));
 assert.equal((await tool('identity_current')).principal.id,federated);assert.equal((await tool('issue_get',{projectId:'P',issueId:issue.issue.id})).issue.body,'Prepared MCP body');
 const federatedTools=await client.listTools();assert(federatedTools.tools.every(t=>Array.isArray(t._meta?.securitySchemes)&&t._meta.securitySchemes[0].type==='oauth2'));
 await client.close();client=undefined;
 const revokedApp=await http('/mcp','POST',{}, {Authorization:'Bearer '+token,'Cf-Access-Jwt-Assertion':assertion});assert.equal(revokedApp.status,401);assert.equal(revokedApp.headers.get('www-authenticate'),'Bearer realm="Projektor"');
 const appOnFederated=await http('/mcp/federated','POST',{}, {Authorization:'Bearer '+token,'Cf-Access-Jwt-Assertion':assertion});assert.equal(appOnFederated.status,400);
 await db.prepare('UPDATE api_credentials SET revoked_at=NULL WHERE id=?').bind(credential).run();const jwksBefore=report.syntheticJwksRequests;await connect();assert.equal((await tool('identity_current')).principal.id,principal);assert.equal(report.syntheticJwksRequests,jwksBefore);await client.close();client=undefined;
 await db.prepare("UPDATE federated_credentials SET revoked_at=unixepoch(),revision=revision+1 WHERE id='INDEPENDENT_FED_KEY'").run();
 const revokedFederation=await http('/mcp/federated','POST',{}, {'Cf-Access-Jwt-Assertion':assertion});assert.equal(revokedFederation.status,403);assert.equal(revokedFederation.headers.get('www-authenticate'),null);assert(!JSON.stringify(revokedFederation.body).includes('Prepared MCP body'));
 report.scenarios.push({name:'exact-artifact optional federation verifies a synthetic signature and explicit app binding; unbound assertion never creates identity; app route never falls back to federation; current federation revoke denies without refresh loop',passed:true,provider:'synthetic in-memory JWKS response only',networkTls:false});
 assert.equal(report.externalRequests,0);report.passed=true;
}catch(error){report.failure={type:error.constructor.name,message:error.message};throw error;}
finally{if(client)await client.close();if(mf)await mf.dispose();await rm(root,{recursive:true,force:true});report.artifactsUnchanged=JSON.stringify(await inventory(join(candidate,'dist')))===JSON.stringify(artifacts);if(!report.artifactsUnchanged)report.passed=false;report.finishedAt=new Date().toISOString();await writeFile(join(out,'built-integration-result.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:report.passed,artifactsUnchanged:report.artifactsUnchanged,artifactTreeSha256:report.artifactTreeSha256,routes:report.routeChecks.length,scenarios:report.scenarios.length,externalRequests:report.externalRequests}));}
