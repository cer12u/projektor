// @module verification
// @role independent-owner-workerd
import {prepareLocalD1, verifyCanonicalLedger} from "../../support/local-d1-fixture.mjs";
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFile,readdir,writeFile,mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,basename} from 'node:path';
import {randomUUID,argon2Sync,createHash} from 'node:crypto';
const root=await mkdtemp(join(tmpdir(),'projektor-owner-workerd-'));
await mkdir('.local/evidence',{recursive:true});
const report={runtime:'actual local workerd and local D1',productionActions:0,results:[]};
const origin='https://projektor.example.invalid',owner='11111111-1111-4111-8111-111111111111';
const issuer='https://synthetic-owner.cloudflareaccess.com',aud='a'.repeat(64),sub='11111111-1111-4111-8111-111111111111';
const key=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const jwk={...await crypto.subtle.exportKey('jwk',key.publicKey),kid:'synthetic-key',alg:'RS256',use:'sig'};
const otherKey=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);const otherJwk={...await crypto.subtle.exportKey('jwk',otherKey.publicKey),kid:'synthetic-key',alg:'RS256',use:'sig'};
const enc=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
async function token(changes={}){const now=Math.floor(Date.now()/1000),h=enc({alg:'RS256',kid:jwk.kid}),p=enc({iss:issuer,aud:[aud],sub,email:'synthetic@example.invalid',type:'app',iat:now,nbf:now,exp:now+600,...changes});const sig=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key.privateKey,new TextEncoder().encode(h+'.'+p));return h+'.'+p+'.'+Buffer.from(sig).toString('base64url');}
let mf, jwksMode='valid';
try{
 const built=process.env.PROJEKTOR_TEST_BUILT==='1';
 if(!built)await build({entryPoints:['src/apps/worker.ts'],outfile:root+'/worker.mjs',bundle:true,format:'esm',platform:'neutral',mainFields:['module','main'],conditions:['workerd','worker','browser'],external:['node:*','cloudflare:*'],plugins:[{name:'wasm',setup(b){b.onResolve({filter:/\.wasm$/},a=>({path:'./'+basename(a.path),external:true}));}}]});
 report.testedBuiltArtifact=built;
 const modules=[{type:'ESModule',path:root+'/worker.mjs',contents:await readFile(built?'dist/worker/index.js':root+'/worker.mjs','utf8')}];
 for(const name of (await readdir(built?'dist/worker':'src/adapters/crypto/generated')).filter(name=>name.endsWith('.wasm')))modules.push({type:'CompiledWasm',path:root+'/'+name,contents:await readFile((built?'dist/worker/':'src/adapters/crypto/generated/')+name)});
 report.workerSha256=createHash('sha256').update(modules[0].contents).digest('hex');
 report.migrations=(await readdir('migrations')).filter(name=>name.endsWith('.sql')).sort();
 const fixture=await prepareLocalD1(root);
 const options={name:'owner-synthetic',modules,modulesRoot:root,compatibilityDate:'2026-10-09',compatibilityFlags:['nodejs_compat'],...fixture,bindings:{AUTH_ORIGIN:origin},outboundService:async request=>{report.jwksRequests=(report.jwksRequests??0)+1;report.jwksUrlMatches=request.url===issuer+'/cdn-cgi/access/certs';assert.equal(request.url,issuer+'/cdn-cgi/access/certs');if(jwksMode==='redirect')return new Response(null,{status:302,headers:{Location:'https://untrusted.example.invalid/keys'}});if(jwksMode==='wrong-signing-key')return Response.json({keys:[otherJwk]});if(jwksMode==='bad-keys')return Response.json({keys:[]});if(jwksMode==='malformed')return new Response('{',{headers:{'Content-Type':'application/json'}});return Response.json({keys:[jwk]});},host:'127.0.0.1',port:0,cf:false,logRequests:false};
 const start=async()=>{mf=new Miniflare(convertV4MiniflareOptions(options));await mf.ready;return mf.getD1Database('DB');};
 let db=await start();
 await verifyCanonicalLedger(db);
 await db.prepare('INSERT INTO principals VALUES(?,?,?,?,1,1)').bind(owner,'human','Synthetic Owner','synthetic-owner').run();
 await db.prepare('UPDATE principal_management SET global_administrator=1 WHERE principal_id=?').bind(owner).run();
 await db.prepare('INSERT INTO auth_settings VALUES(?,?)').bind('owner_web_bootstrap',JSON.stringify({ownerId:owner,issuer,audience:aud,subject:sub,closesAt:Math.floor(Date.now()/1000)+600})).run();
 const salt=Buffer.alloc(16,7),dummy=argon2Sync('argon2id',{message:'Synthetic dummy only',nonce:salt,parallelism:1,tagLength:32,memory:19456,passes:2});
 await db.prepare('INSERT INTO auth_settings VALUES(?,?)').bind('dummy_password_hash','$argon2id$v=19$m=19456,t=2,p=1$'+salt.toString('base64').replace(/=+$/,'')+'$'+dummy.toString('base64').replace(/=+$/,'')).run();
 async function call(path,body,headers={}){const r=await mf.dispatchFetch(origin+path,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json',Origin:origin}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0],setCookie:r.headers.get('set-cookie')};}
 const base='/api/auth/password-setup/owner-initial';
 const passed=name=>report.results.push({name,passed:true});
 const browserSecrets=[];
 const noSecrets=value=>{const text=JSON.stringify(value);assert.doesNotMatch(text,/setupRight|browserToken|token_hash|context_hash|encoded_hash|Synthetic-owner-password/);for(const secret of browserSecrets)assert.ok(!text.includes(secret),'no browser capability leaks into body');};
 async function newContext(){
  const login=await call('/api/auth/context');assert.equal(login.status,200);
  const h={Cookie:login.cookie,'X-CSRF-Token':login.body.csrfToken};
  const pre=await call(base+'/context',{},h);assert.equal(pre.status,200,JSON.stringify(pre.body));
  assert.match(pre.setCookie,/^__Host-projektor_owner_setup=/);assert.match(pre.setCookie,/; Secure/);assert.match(pre.setCookie,/; HttpOnly/);assert.match(pre.setCookie,/; Path=\//);assert.doesNotMatch(pre.setCookie,/Domain=/i);
  assert.deepEqual(Object.keys(pre.body),['expiresAt']);browserSecrets.push(pre.cookie.split('=')[1]);noSecrets(pre.body);
  return {headers:{Cookie:login.cookie+'; '+pre.cookie,'X-CSRF-Token':login.body.csrfToken},cookie:pre.cookie,expiresAt:pre.body.expiresAt};
 }
 const context=await newContext(),headers={...context.headers,'Cf-Access-Jwt-Assertion':await token()};
 passed('server-generated host-only Secure HttpOnly binding established before issue');
 const beforeContexts=await db.prepare('SELECT count(*) n FROM owner_setup_contexts').first('n');
 for(const h of [{...headers,Origin:'https://evil.example.invalid'},{...headers,'X-CSRF-Token':'x'.repeat(43)}])assert.equal((await call(base+'/context',{},h)).status,403);
 assert.equal((await call(base+'/context',{browserToken:'x'.repeat(43)},headers)).status,400);
 assert.equal(await db.prepare('SELECT count(*) n FROM owner_setup_contexts').first('n'),beforeContexts);
 assert.equal((await call(base,{operationId:randomUUID()},{'Cf-Access-Jwt-Assertion':await token(),'X-CSRF-Token':context.headers['X-CSRF-Token']})).status,403);
 const bad=await call(base,{operationId:randomUUID()},{...headers,'Cf-Access-Jwt-Assertion':await token({sub:'22222222-2222-4222-8222-222222222222'})});assert.equal(bad.status,403);
 assert.equal(report.jwksRequests??0,0,'wrong subject must not fetch keys');passed('wrong identity and missing browser proof denied');
 for(const mode of ['redirect','bad-keys','malformed','wrong-signing-key']){
  jwksMode=mode;const before=report.jwksRequests??0;
  const failure=await call(base,{operationId:randomUUID()},headers);
  assert.equal(failure.status,['redirect','malformed'].includes(mode)?503:403);assert.equal(failure.body.error,['redirect','malformed'].includes(mode)?'identity_provider_unavailable':'owner_initial_rejected');assert.equal(report.jwksRequests,before+1,'exactly one fetch, no redirect follow');
  assert.equal(await db.prepare('SELECT count(*) n FROM password_setup_rights').first('n'),0);
  assert.equal(await db.prepare("SELECT count(*) n FROM auth_settings WHERE key='owner_web_bootstrap'").first('n'),1);
  passed(mode+' denied without grant/config mutation or redirect follow');
 }
 jwksMode='valid';
 const operationId=randomUUID(),initial=await call(base,{operationId},headers);
 assert.equal(initial.status,200,JSON.stringify(initial.body));assert.equal(initial.body.principalId,owner);assert.equal(initial.cookie,undefined);noSecrets(initial.body);
 const grant=await db.prepare('SELECT right_id,expires_at FROM owner_setup_contexts WHERE operation_id=?').bind(operationId).first();
 assert.ok(grant.right_id);assert.ok(grant.expires_at<=context.expiresAt);
 // Deliberately discard issue payload. Recover through capability+operation, without assertion or a bearer right.
 const recovered=await call(base+'/status',{operationId},context.headers);assert.equal(recovered.status,200);assert.equal(recovered.body.state,'ready');noSecrets(recovered.body);
 assert.equal(await db.prepare('SELECT count(*) n FROM password_setup_rights').first('n'),1);
 assert.equal((await call(base,{operationId},context.headers)).status,200);
 assert.equal((await call(base,{operationId:randomUUID()},headers)).status,409);
 assert.equal((await call(base+'/status',{operationId},{'X-CSRF-Token':context.headers['X-CSRF-Token']})).status,403);
 const otherContext=await newContext();assert.equal((await call(base+'/status',{operationId},otherContext.headers)).status,404);
 passed('lost issue acknowledgement recovers same grant; no secret response or implicit reissue');
 await mf.dispose();db=await start();await verifyCanonicalLedger(db);
 assert.equal((await call(base+'/status',{operationId},context.headers)).body.state,'ready');
 const refresh=await call('/api/auth/context'),refreshHeaders={Cookie:refresh.cookie+'; '+context.cookie,'X-CSRF-Token':refresh.body.csrfToken};
 const refreshed=await call(base+'/context',{operationId},refreshHeaders);assert.equal(refreshed.status,200,JSON.stringify(refreshed.body));assert.equal(refreshed.cookie,context.cookie);assert.equal(refreshed.body.expiresAt,grant.expires_at);
 assert.equal((await call(base+'/status',{operationId},context.headers)).status,403);assert.equal((await call(base+'/status',{operationId},refreshHeaders)).status,200);
 const conflictChallenge=await call('/api/auth/context');
 assert.equal((await call(base+'/context',{operationId:randomUUID()},{Cookie:conflictChallenge.cookie+'; '+context.cookie,'X-CSRF-Token':conflictChallenge.body.csrfToken})).status,409);
 assert.equal((await call(base+'/context',{operationId},refreshHeaders)).status,403,'consumed login challenge cannot mint or refresh again');
 passed('worker restart and CSRF refresh preserve binding and absolute deadline');
 const completion={operationId,password:'Synthetic-owner-password!'};
 const completions=await Promise.all([call(base+'/complete',completion,refreshHeaders),call(base+'/complete',completion,refreshHeaders)]);
 for(const result of completions){assert.equal(result.status,200,JSON.stringify(result.body));noSecrets(result.body);}
 assert.equal(await db.prepare('SELECT count(*) n FROM password_setup_audit WHERE kind=\'complete\'').first('n'),1);
 assert.equal(await db.prepare('SELECT auth_version FROM principals WHERE id=?').bind(owner).first('auth_version'),2);
 await mf.dispose();db=await start();
 const receipt=await call(base+'/status',{operationId},refreshHeaders);assert.equal(receipt.body.state,'completed');assert.equal(receipt.body.completedAuthVersion,2);noSecrets(receipt.body);
 const replay=await call(base+'/complete',completion,refreshHeaders);assert.equal(replay.status,200);assert.equal(replay.body.source,'recovered');
 const mismatch=await call(base+'/complete',{...completion,password:'Different-owner-password!'},refreshHeaders);assert.equal(mismatch.status,409);assert.equal(mismatch.body.error,'operation_input_mismatch');
 assert.equal((await call(base+'/complete',{...completion,operationId:randomUUID()},refreshHeaders)).status,403);
 passed('concurrent consumption commits one password version/audit; lost completion acknowledgement recovers after restart; changed replay denied');
 const fresh=await call('/api/auth/context'),login=await call('/api/auth/login',{loginId:'synthetic-owner',password:completion.password},{Cookie:fresh.cookie,'X-CSRF-Token':fresh.body.csrfToken});assert.equal(login.status,200);assert.equal((await call('/api/auth/me',null,{Cookie:login.cookie})).body.principal.id,owner);
 passed('actual Argon2 Wasm password and ordinary session login');
 await db.prepare('UPDATE principals SET active=0 WHERE id=?').bind(owner).run();assert.equal((await call(base+'/status',{operationId},refreshHeaders)).status,403);
 await db.prepare('UPDATE principals SET active=1 WHERE id=?').bind(owner).run();
 await db.prepare('UPDATE principals SET auth_version=auth_version+1 WHERE id=?').bind(owner).run();assert.equal((await call(base+'/status',{operationId},refreshHeaders)).status,403);assert.equal((await call(base+'/complete',completion,refreshHeaders)).status,403);
 passed('subsequent auth-version change denies completion disclosure and replay');
 async function issueScenario(closesIn,assertionIn){
  await mf.dispose();const scenarioRoot=join(root,randomUUID());await mkdir(scenarioRoot);Object.assign(options,await prepareLocalD1(scenarioRoot),{outboundService:options.outboundService});db=await start();await verifyCanonicalLedger(db);
  const now=Math.floor(Date.now()/1000),closesAt=now+closesIn,assertionExpiresAt=now+assertionIn;
  const id=owner;await db.prepare('INSERT INTO principals VALUES(?,?,?,?,1,1)').bind(id,'human','Scenario Owner','synthetic-owner').run();await db.prepare('UPDATE principal_management SET global_administrator=1 WHERE principal_id=?').bind(id).run();
  await db.prepare('INSERT INTO auth_settings VALUES(?,?)').bind('owner_web_bootstrap',JSON.stringify({ownerId:id,issuer,audience:aud,subject:sub,closesAt})).run();
  const c=await newContext(),op=randomUUID();const issued=await call(base,{operationId:op},{...c.headers,'Cf-Access-Jwt-Assertion':await token({exp:assertionExpiresAt})});assert.equal(issued.status,200,JSON.stringify(issued.body));
  return {id,op,c,issued,closesAt,assertionExpiresAt};
 }
 const rightRevoked=await issueScenario(3600,3600);assert.equal(rightRevoked.issued.body.expiresAt,rightRevoked.c.expiresAt,'pre-context absolute lifetime bounds later issue');
 await db.prepare('UPDATE password_setup_rights SET revoked_at=unixepoch() WHERE id=(SELECT right_id FROM owner_setup_contexts WHERE operation_id=?)').bind(rightRevoked.op).run();
 assert.equal((await call(base+'/status',{operationId:rightRevoked.op},rightRevoked.c.headers)).status,403);assert.equal((await call(base+'/complete',{operationId:rightRevoked.op,password:completion.password},rightRevoked.c.headers)).status,403);
 assert.equal(await db.prepare('SELECT count(*) n FROM passwords').first('n'),0);passed('context absolute lifetime caps issue and revoked grant cannot complete');
 const revoked=await issueScenario(600,300);
 assert.equal(revoked.issued.body.expiresAt,revoked.assertionExpiresAt,'external assertion expiry bounds the grant');
 await db.prepare('UPDATE owner_setup_contexts SET revoked_at=unixepoch() WHERE operation_id=?').bind(revoked.op).run();
 for(const path of ['/status','/complete'])assert.equal((await call(base+path,{operationId:revoked.op,...(path==='/complete'?{password:completion.password}:{})},revoked.c.headers)).status,403);
 assert.equal(await db.prepare('SELECT count(*) n FROM passwords WHERE principal_id=?').bind(revoked.id).first('n'),0);passed('revoked capability cannot disclose or consume grant');
 const expiring=await issueScenario(3,600),expiry=expiring.closesAt;assert.equal(expiring.issued.body.expiresAt,expiry,'bootstrap deadline bounds grant');
 await new Promise(resolve=>setTimeout(resolve,Math.max(0,expiry*1000-Date.now())+1100));
 assert.equal((await call(base+'/status',{operationId:expiring.op},expiring.c.headers)).status,403);assert.equal((await call(base+'/complete',{operationId:expiring.op,password:completion.password},expiring.c.headers)).status,403);
 assert.equal(await db.prepare('SELECT count(*) n FROM passwords WHERE principal_id=?').bind(expiring.id).first('n'),0);passed('absolute expiry denies status and consumption without extension');
 assert.equal(await db.prepare('SELECT count(*) n FROM password_setup_rights WHERE consumed_at IS NOT NULL').first('n'),0);
 report.passed=true;
}catch(error){report.passed=false;report.failureType=error.constructor.name;report.failure=error.message;throw error;}finally{await writeFile('.local/evidence/independent-owner-workerd-check.json',JSON.stringify(report,null,2)+'\n');if(mf)await mf.dispose();await rm(root,{recursive:true,force:true});}
console.log(JSON.stringify(report));
