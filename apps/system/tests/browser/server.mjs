// @module verification
// @role browser-fixture
// Real built Worker/WASM/Web on disposable canonical D1. No build or deployment.
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {argon2id} from 'hash-wasm';
import {randomBytes,createHash} from 'node:crypto';
import {prepareLocalD1,verifyCanonicalLedger} from '../support/local-d1-fixture.mjs';
const candidate=fileURLToPath(new URL('../../',import.meta.url));
process.chdir(candidate);
const setup=process.argv.includes('--setup');
assert(process.argv.slice(2).every(arg=>arg==='--setup'),'only --setup is supported');
const mode=setup?'setup':'core',port=setup?8904:8903,origin=`http://localhost:${port}`;
// This mapping exists ONLY in the setup QA adapter. It cannot prove TLS/Access.
const workerOrigin=setup?'https://projektor.example.invalid':origin;
const runRoot=resolve('.local/verification/browser-run',mode+'-'+Date.now()),evidence=join(runRoot,'evidence'),state=join(runRoot,'state');
await mkdir(evidence,{recursive:true});await mkdir(state,{recursive:true});
const manifestPath=resolve('.local/verification/release/artifact-manifest.json');
const manifestText=await readFile(manifestPath,'utf8'),approved=JSON.parse(manifestText),artifactBytes=new Map();
assert.equal(approved.format,3);assert.equal(approved.state,'frozen');assert.equal(approved.build.exitCode,0);
assert.equal(approved.build.inputSourceTreeSha256,approved.build.outputSourceTreeSha256);
assert(approved.artifacts['worker/index.js']&&approved.artifacts['web/index.html']);
for(const [file,entry]of Object.entries(approved.artifacts)){
 assert(/^(worker|web)\//.test(file)&&!file.split('/').includes('..')&&/^[a-f0-9]{64}$/.test(entry.sha256));
 const bytes=await readFile(join(candidate,'dist',file));assert.equal(bytes.length,entry.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.sha256,'artifact changed: '+file);artifactBytes.set(file,bytes);
}
const present=[];for(const dir of ['worker','web'])for(const file of await readdir(join(candidate,'dist',dir),{recursive:true,withFileTypes:true}))if(file.isFile())present.push((join(file.parentPath,file.name).slice(join(candidate,'dist').length+1)).replaceAll('\\','/'));
assert.deepEqual(present.sort(),Object.keys(approved.artifacts).sort(),'manifest must include every built artifact');
const workerRoot=join(candidate,'dist/worker'),modules=[{type:'ESModule',path:join(workerRoot,'index.js'),contents:artifactBytes.get('worker/index.js').toString('utf8')}];
for(const [file,contents]of artifactBytes)if(file.startsWith('worker/')&&file.endsWith('.wasm'))modules.push({type:'CompiledWasm',path:join(candidate,'dist',file),contents});
const issuer='https://synthetic-owner.cloudflareaccess.com',audience='a'.repeat(64),subject='11111111-1111-4111-8111-111111111111',owner='11111111-2222-4333-8444-555555555555';
// The same synthetic signing recipe as independent-owner-workerd-check.mjs.
const key=setup?await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']):null;
const jwk=key?{...await crypto.subtle.exportKey('jwk',key.publicKey),kid:'synthetic-browser-key',alg:'RS256',use:'sig'}:null;
const encoded=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
async function assertion(){const now=Math.floor(Date.now()/1000),head=encoded({alg:'RS256',kid:jwk.kid}),body=encoded({iss:issuer,aud:[audience],sub:subject,email:'synthetic@example.invalid',type:'app',iat:now,nbf:now,exp:now+900});const signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key.privateKey,new TextEncoder().encode(head+'.'+body));return head+'.'+body+'.'+Buffer.from(signature).toString('base64url');}
const fixture=await prepareLocalD1(state);let syntheticJwksCalls=0,blockedOutboundCalls=0;
const assets=request=>{const path=new URL(request.url).pathname,file=path.startsWith('/assets/')?'web'+path:'web/index.html',bytes=artifactBytes.get(file);return bytes?new Response(bytes,{headers:{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html','Cache-Control':'no-store'}}):new Response('missing approved asset',{status:404});};
const mf=new Miniflare(convertV4MiniflareOptions({name:'browser-synthetic-'+mode,modules,modulesRoot:workerRoot,compatibilityDate:'2026-10-09',compatibilityFlags:['nodejs_compat'],...fixture,bindings:{AUTH_ORIGIN:workerOrigin,MCP_ENABLED:'false'},serviceBindings:{ASSETS:assets},outboundService:request=>{if(setup&&request.url===issuer+'/cdn-cgi/access/certs'){syntheticJwksCalls++;return Response.json({keys:[jwk]});}blockedOutboundCalls++;return new Response('external network disabled',{status:503});},host:'127.0.0.1',port:0,cf:false,logRequests:false}));
await mf.ready;const db=await mf.getD1Database('DB');await verifyCanonicalLedger(db);
const migrations=(await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all()).results.map(row=>row.name);
assert(migrations.includes('0018_owner_setup_contexts.sql'));assert(migrations.includes('0019_recipient_setup_contexts.sql'));
for(const [id,kind,name,login] of [['qa-human','human','Browser Human','qa-human'],['qa-other','human','Browser Other','qa-other'],['qa-agent','agent','Browser Agent',null]])await db.prepare('INSERT INTO principals VALUES(?,?,?,?,1,1)').bind(id,kind,name,login).run();
const password=await argon2id({password:'Synthetic-Browser-QA-Only!',salt:randomBytes(16),memorySize:19456,iterations:2,parallelism:1,hashLength:32,outputType:'encoded'});
for(const id of ['qa-human','qa-other'])await db.prepare('INSERT INTO passwords VALUES(?,?)').bind(id,password).run();
await db.prepare('INSERT INTO auth_settings VALUES(?,?)').bind('dummy_password_hash',password).run();
await db.prepare("INSERT INTO workspaces VALUES('QA','Browser QA','{}')").run();
await db.prepare("INSERT INTO projects VALUES('P','QA','QA','browser-qa','Synthetic Browser QA','','{}')").run();
for(const id of ['qa-human','qa-agent','qa-other'])for(const right of ['view','edit','assign','transition','execute'])await db.prepare('INSERT INTO memberships VALUES(?,?,?)').bind(id,'P',right).run();
if(setup){
 await db.prepare('INSERT INTO principals VALUES(?,?,?,?,1,1)').bind(owner,'human','Synthetic Browser Owner','qa-owner').run();
 await db.prepare('UPDATE principal_management SET global_administrator=1 WHERE principal_id=?').bind(owner).run();
 await db.prepare('INSERT INTO auth_settings VALUES(?,?)').bind('owner_web_bootstrap',JSON.stringify({ownerId:owner,issuer,audience,subject,closesAt:Math.floor(Date.now()/1000)+3600})).run();
 await db.prepare("INSERT INTO memberships VALUES(?,'P','view')").bind(owner).run();
}
 await db.prepare('INSERT INTO principals VALUES(?,?,?,?,1,1)').bind('qa-recipient','human','Synthetic Setup Recipient','qa-recipient').run();
await db.prepare("INSERT INTO memberships VALUES('qa-recipient','P','view')").run();
await db.prepare("UPDATE principal_management SET global_administrator=1 WHERE principal_id='qa-human'").run();
const storageFaultBytes=await readFile(join(candidate,'tests/browser/storage-fault.js'));
const productIndex=artifactBytes.get('web/index.html').toString('utf8'),appScript=productIndex.match(/src="([^"]+\.js)"/)[1];
const appStyles=[...productIndex.matchAll(/href="([^"]+\.css)"/g)].map(m=>m[1]);
const requests=[];let dropPath=null,replayActiveAbandon=false;
const query=async sql=>(await db.prepare(sql).all()).results;
async function save(){await writeFile(join(evidence,'runtime-evidence.json'),JSON.stringify({origin,workerOrigin,mode,observedAt:new Date().toISOString(),runtime:'actual frozen Worker/WASM/Web, local Miniflare/workerd, canonical D1 and separate real Chromium observations',limits:setup?'Fixed localhost URL/Origin mapping and synthetic signed assertion; no real TLS, Access or identity-provider proof':'Local HTTP fixture; no production or real edge proof',manifestSha256:createHash('sha256').update(manifestText).digest('hex'),approvedArtifacts:approved,migrations,syntheticJwksCalls,blockedOutboundCalls,requests,issues:await query('SELECT * FROM issues'),history:await query('SELECT issue_id,revision,operation_id,actor_id,actor_name,change_kind,after_body FROM issue_history ORDER BY issue_id,revision'),operations:await query('SELECT principal_id,operation_id,operation_kind,target_id,state FROM operation_results'),setupRights:await query('SELECT id,principal_id,purpose,consumed_at,revoked_at,completed_operation_id,completed_auth_version FROM password_setup_rights'),setupAudit:await query('SELECT kind,operation_id,principal_id,right_id FROM password_setup_audit'),recipientContexts:await query('SELECT request_id,issuer_id,operation_id,principal_id,right_id,purpose,target_auth_version,created_at,expires_at,revoked_at FROM recipient_setup_contexts'),storageFaultScriptSha256:createHash('sha256').update(storageFaultBytes).digest('hex'),storageFaultScope:'Optional fixture launcher loads exact pinned app JS/CSS; native IndexedDB abort injection, not physical quota. Product index HTML itself is not used on this launcher.',ownerContexts:await query('SELECT owner_id,operation_id,right_id,created_at,expires_at,revoked_at FROM owner_setup_contexts'),principals:await query('SELECT id,auth_version,active FROM principals')},null,2)+'\n');}
const ownerBase='/api/auth/password-setup/owner-initial';
const drops=new Map([['owner-initial',ownerBase],['owner-complete',ownerBase+'/complete'],['recipient-complete','/api/auth/password-setup/recipient/complete'],['legacy-recipient-complete','/api/auth/password-setup/complete'],['recipient-issue','/api/management/principals/qa-recipient/password-setup/issue'],['issue-create','/api/projects/P/issues'],['recipient-abandon','/api/auth/password-setup/recipient/abandon']]);
const server=createServer(async(req,res)=>{try{
 if(req.headers.host!==`localhost:${port}`){res.writeHead(400);res.end('local QA host only');return;}
 const path=new URL(req.url,origin).pathname;
 if(path==='/__qa/storage-control.js'){res.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-store'});res.end(storageFaultBytes);return;}
 if(path==='/__qa/storage'){res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});res.end('<!doctype html><html><head><meta charset="utf-8"><title>Projektor local storage QA</title>'+appStyles.map(href=>'<link rel="stylesheet" href="'+href+'">').join('')+'</head><body><div id="root"></div><script src="/__qa/storage-control.js"></script><script type="module" src="'+appScript+'"></script></body></html>');return;}
 if(path==='/__qa/expire'){await db.prepare('UPDATE sessions SET revoked_at=unixepoch() WHERE revoked_at IS NULL').run();res.setHeader('Content-Type','text/html');res.end('<p>expired synthetic sessions</p>');return;}
 if(path==='/__qa/evidence'){await save();res.setHeader('Content-Type','text/html');res.end('<p>saved sanitized evidence</p>');return;}
 // Presentation-only replay: no Worker dispatch, capability change or grant creation.
 if(path==='/__qa/replay-active-abandon'){replayActiveAbandon=true;res.setHeader('Content-Type','text/html');res.end('<p>Next same-origin abandonment will receive a recorded active-context403; Worker dispatch is skipped.</p>');return;}
 if(path==='/__qa/revoke-owner-binding'&&setup){await db.prepare('UPDATE owner_setup_contexts SET revoked_at=unixepoch() WHERE revoked_at IS NULL').run();res.end('revoked synthetic owner binding');return;}
 if(path.startsWith('/__qa/drop-next/')){const target=drops.get(path.slice('/__qa/drop-next/'.length));if(!target||!setup&&target.startsWith(ownerBase)){res.writeHead(404);res.end();return;}dropPath=target;res.setHeader('Content-Type','text/html');res.end('<p>One synthetic response will be replaced after Worker completion.</p>');return;}

 const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks);const input=body.length?JSON.parse(body.toString()):null;
 if(replayActiveAbandon&&path==='/api/auth/password-setup/recipient/abandon'&&req.method==='POST'&&req.headers.origin===origin){replayActiveAbandon=false;requests.push({at:new Date().toISOString(),method:req.method,path:req.url,workerStatus:null,browserStatus:403,mappedOrigin:false,responseReplayedWithoutWorkerDispatch:true,replayedError:'recipient_setup_still_active',cookieAttributes:[]});res.writeHead(403,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({error:'recipient_setup_still_active'}));return;}
 const incoming=new Headers(req.headers);let mapped=false;
 if(setup){if(incoming.has('origin')){if(incoming.get('origin')!==origin){res.writeHead(403);res.end('unexpected local origin');return;}incoming.set('origin',workerOrigin);mapped=true;}incoming.delete('cf-access-jwt-assertion');if(path===ownerBase&&req.method==='POST')incoming.set('cf-access-jwt-assertion',await assertion());}
 const response=await mf.dispatchFetch(workerOrigin+req.url,{method:req.method,headers:incoming,...(body.length?{body}:{}),redirect:'manual'});
 const bytes=Buffer.from(await response.arrayBuffer()),dropped=dropPath===path&&req.method==='POST'&&response.ok;
 const cookies=response.headers.getSetCookie();requests.push({at:new Date().toISOString(),method:req.method,path:req.url,workerStatus:response.status,browserStatus:dropped?502:response.status,mappedOrigin:mapped,...(input?.operationId?{operationId:input.operationId}:{}),...(dropped?{responseReplacedAfterWorkerSuccess:true}:{}),cookieAttributes:cookies.map(value=>({name:value.split('=')[0],secure:/; Secure/i.test(value),httpOnly:/; HttpOnly/i.test(value),hostOnly:!/; Domain=/i.test(value),pathRoot:/; Path=\//i.test(value)}))});
 if(dropped){dropPath=null;res.writeHead(502,{'Content-Type':'text/plain','Cache-Control':'no-store'});res.end('Synthetic lost acknowledgement after local Worker response');return;}
 res.statusCode=response.status;for(const [key,value]of response.headers)if(key!=='set-cookie')res.setHeader(key,value);if(cookies.length)res.setHeader('set-cookie',cookies);res.end(bytes);
}catch(error){console.error('QA_HARNESS_ERROR',error?.constructor?.name??'Error');res.statusCode=500;res.end('harness failure');}});
await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
await writeFile(join(evidence,'server-info.json'),JSON.stringify({origin,workerOrigin,mode,evidence,node:process.version,workerSha256:approved.artifacts['worker/index.js'].sha256,manifestSha256:createHash('sha256').update(manifestText).digest('hex'),migrations},null,2)+'\n');
await mkdir(resolve('.local/verification/browser-run'),{recursive:true});await writeFile(resolve('.local/verification/browser-run',mode+'-latest.json'),JSON.stringify({origin,evidence,state},null,2)+'\n');
console.log('SYNTHETIC_BROWSER_QA_READY '+origin+' EVIDENCE '+evidence);
async function stop(){await save();server.close();await mf.dispose();process.exit(0);}process.on('SIGTERM',stop);process.on('SIGINT',stop);
