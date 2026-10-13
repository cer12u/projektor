// @module verification
// @role integration-http
// Focused exact-byte Worker/WASM proof. No build, provider call, or real credentials.
import assert from 'node:assert/strict';
import {readFile,readdir,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {argon2id} from 'hash-wasm';
import {prepareLocalD1,verifyCanonicalLedger} from '../../support/local-d1-fixture.mjs';
const candidate=fileURLToPath(new URL('../../../',import.meta.url));
const out=resolve(candidate,'.local/verification/independent-integration');
const hash=value=>createHash('sha256').update(value).digest('hex');
const manifestBytes=await readFile(resolve(candidate,'.local/verification/release/artifact-manifest.json'));
const manifest=JSON.parse(manifestBytes);
const report={passed:false,startedAt:new Date().toISOString(),scope:'Exact built Worker/WASM in actual local workerd/canonical D1; synthetic HTTP credentials; no product clock override',testedBuiltArtifact:true,artifactManifestSha256:hash(manifestBytes),artifactTreeSha256:manifest.artifactTreeSha256,externalRequests:0,productionActions:0,results:[],limits:'Counter/challenge timestamps are moved only in disposable D1 to test boundaries; this is not 900 seconds of elapsed time or production frontdoor proof.'};
await mkdir(out,{recursive:true});
const policyFiles=['src/modules/identity/rules.ts','src/adapters/d1/identity/auth-challenges.ts','src/modules/identity/application.ts','src/apps/http/auth.ts','tests/integration/http/check-auth-throttle-runtime.mjs','tests/support/local-d1-fixture.mjs'];
report.sourceHashes=Object.fromEntries(await Promise.all(policyFiles.map(async p=>[p,hash(await readFile(join(candidate,p)))])));
const policy=await readFile(join(candidate,policyFiles[0]),'utf8');
assert.match(policy,/LOGIN_POLICY=\{challengeSeconds:600,windowSeconds:900,contextPerSource:60,accountAttempts:5,sourceAttempts:30\}/);
report.policy={contextPerSource:60,loginPerSource:30,loginPerAccount:5,windowSeconds:900,challengeSeconds:600};
const root=await mkdtemp(join(tmpdir(),'projektor-throttle-')),origin='https://throttle.invalid',source='192.0.2.10';
const password='Synthetic-throttle-password!',loginId='throttle-human';
let mf,db;
const sql=async(q,...args)=>db.prepare(q).bind(...args).run();
const scalar=async(q,...args)=>db.prepare(q).bind(...args).first('n');
const countSessions=()=>scalar('SELECT count(*) n FROM sessions');
async function request(path,{body,headers={}}={}){const r=await mf.dispatchFetch(origin+path,{method:body?'POST':'GET',headers:{Origin:origin,'CF-Connecting-IP':source,...(body?{'Content-Type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json(),headers:r.headers};}
async function context(){const r=await request('/api/auth/context');assert.equal(r.status,200);return {Cookie:r.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':r.body.csrfToken};}
async function login(headers,id=loginId,pw=password){return request('/api/auth/login',{body:{loginId:id,password:pw},headers});}
function denied(r,status,error){assert.equal(r.status,status);assert.equal(r.body.error,error);assert.equal(r.headers.has('set-cookie'),false);assert(Object.keys(r.body).every(k=>k==='error'));}
async function limitsClear(){await sql('DELETE FROM login_limits');}
async function nearStartOfSecond(){while(Date.now()%1000>100)await new Promise(r=>setTimeout(r,15));}
async function boundarySet(key,age){await nearStartOfSecond();await sql('UPDATE login_limits SET window_start=unixepoch()-? WHERE key_hash=?',age,key);return scalar('SELECT unixepoch() n');}
async function artifactReadback(){for(const [p,expected]of Object.entries(manifest.artifacts)){const b=await readFile(join(candidate,'dist',p));assert.equal(hash(b),expected.sha256);assert.equal(b.length,expected.bytes);}}
try{
 await artifactReadback();
 const modules=[{type:'ESModule',path:join(root,'worker.mjs'),contents:await readFile(join(candidate,'dist/worker/index.js'),'utf8')}];
 for(const name of await readdir(join(candidate,'dist/worker')))if(name.endsWith('.wasm'))modules.push({type:'CompiledWasm',path:join(root,name),contents:await readFile(join(candidate,'dist/worker',name))});
 report.executedArtifacts=Object.fromEntries(modules.map(m=>[m.path.split('/').at(-1),{sha256:hash(m.contents),bytes:Buffer.byteLength(m.contents)}]));
 const fixture=await prepareLocalD1(root);
 mf=new Miniflare(convertV4MiniflareOptions({modules,modulesRoot:root,compatibilityDate:'2026-10-09',compatibilityFlags:['nodejs_compat'],...fixture,bindings:{AUTH_ORIGIN:origin},outboundService:()=>{report.externalRequests++;throw Error('External requests forbidden');},host:'127.0.0.1',port:0,cf:false,logRequests:false}));
 await mf.ready;db=await mf.getD1Database('DB');await verifyCanonicalLedger(db);
 const encoded=await argon2id({memorySize:19456,iterations:2,parallelism:1,hashLength:32,password,salt:new Uint8Array(16).fill(7),outputType:'encoded'});
 await sql("INSERT INTO principals VALUES('THROTTLE_HUMAN','human','Synthetic throttle human',?,1,1)",loginId);
 await sql("INSERT INTO passwords VALUES('THROTTLE_HUMAN',?)",encoded);await sql("INSERT INTO auth_settings VALUES('dummy_password_hash',?)",encoded);
 const accountKey=hash('account:'+loginId),sourceKey=hash('source:'+source),contextKey=hash('context-source:'+source);
 // Real requests exhaust context admission. Competing final-slot requests cannot both reserve a challenge.
 for(let n=0;n<59;n++)await context();
 const pair=await Promise.all([request('/api/auth/context'),request('/api/auth/context')]);assert.deepEqual(pair.map(r=>r.status).sort(),[200,429]);denied(pair.find(r=>r.status===429),429,'login_limited');
 assert.equal(await scalar('SELECT attempts n FROM login_limits WHERE key_hash=?',contextKey),60);
 assert.equal(await scalar('SELECT count(*) n FROM login_challenges'),60);assert.equal(await countSessions(),0);
 const stable=await boundarySet(contextKey,899);denied(await request('/api/auth/context'),429,'login_limited');assert.equal(await scalar('SELECT unixepoch() n'),stable,'The just-before-boundary call must remain in the same DB second');
 await boundarySet(contextKey,900);await context();assert.equal(await scalar('SELECT attempts n FROM login_limits WHERE key_hash=?',contextKey),1);
 report.results.push({name:'Context limit60: 59 sequential plus competing last-slot requests admit exactly60; 899-second age rejects, 900-second age admits and resets',passed:true,sessions:0});
 // Five genuine wrong-password checks exhaust the account without minting a session.
 await limitsClear();const proof=await context();
 for(let n=0;n<5;n++)denied(await login(proof,loginId,'Synthetic-wrong-password'),401,'invalid_credentials');
 assert.equal(await scalar('SELECT attempts n FROM login_limits WHERE key_hash=?',accountKey),5);
 denied(await login(proof),429,'login_limited');assert.equal(await countSessions(),0);
 const accountAt=await boundarySet(accountKey,899);denied(await login(proof),429,'login_limited');assert.equal(await scalar('SELECT unixepoch() n'),accountAt);
 await boundarySet(accountKey,900);const recovered=await login(proof);assert.equal(recovered.status,200);assert.equal(recovered.body.authenticated,true);assert.match(recovered.headers.get('set-cookie'),/__Host-projektor_session=/);assert.equal(await countSessions(),1);
 assert.equal(await scalar('SELECT attempts n FROM login_limits WHERE key_hash=?',accountKey),1);
 denied(await login(proof),403,'csrf_rejected');assert.equal(await countSessions(),1);
 report.results.push({name:'Account limit5: actual wrong passwords return401; valid sixth and 899-second boundary return429 with zero sessions; 900-second boundary authenticates once and consumed challenge cannot replay',passed:true});
 // Rotate unknown accounts to test the independent source threshold and dummy hash path.
 await limitsClear();const sourceProof=await context(),baseline=await countSessions();
 for(let n=0;n<30;n++)denied(await login(sourceProof,'unknown-'+n,'Synthetic-wrong-password'),401,'invalid_credentials');
 assert.equal(await scalar('SELECT attempts n FROM login_limits WHERE key_hash=?',sourceKey),30);
 assert.equal(await scalar('SELECT count(*) n FROM login_limits WHERE key_hash=?',accountKey),0);
 denied(await login(sourceProof),429,'login_limited');assert.equal(await scalar('SELECT count(*) n FROM login_limits WHERE key_hash=?',accountKey),0,'Denied source must not admit a new account key');assert.equal(await countSessions(),baseline);
 const sourceAt=await boundarySet(sourceKey,899);denied(await login(sourceProof),429,'login_limited');assert.equal(await scalar('SELECT unixepoch() n'),sourceAt);
 await boundarySet(sourceKey,900);assert.equal((await login(sourceProof)).status,200);assert.equal(await countSessions(),baseline+1);assert.equal(await scalar('SELECT attempts n FROM login_limits WHERE key_hash=?',sourceKey),1);
 report.results.push({name:'Source limit30: rotated unknown accounts execute dummy verification; next valid account is rejected before its counter/session insertion; 899-second rejection and 900-second recovery',passed:true});
 // A challenge at its exact expiry rejects before attempt accounting; a fresh context recovers normally.
 await limitsClear();const expiryProof=await context(),challengeToken=expiryProof.Cookie.split('=')[1];
 await sql('UPDATE login_challenges SET expires_at=unixepoch() WHERE token_hash=?',hash(challengeToken));
 const sessionsBeforeExpiry=await countSessions();denied(await login(expiryProof),403,'csrf_rejected');assert.equal(await countSessions(),sessionsBeforeExpiry);assert.equal(await scalar('SELECT count(*) n FROM login_limits WHERE key_hash IN (?,?)',sourceKey,accountKey),0);
 const fresh=await context();assert.equal((await login(fresh)).status,200);assert.equal(await countSessions(),sessionsBeforeExpiry+1);
 report.results.push({name:'Challenge exact-expiry rejects before login counter admission and creates no session; fresh context plus valid credentials recovers',passed:true});
 await artifactReadback();assert.equal(report.externalRequests,0);report.artifactsUnchanged=true;report.passed=true;
}catch(error){report.error={name:error.name,message:error.message};throw error;}
finally{report.finishedAt=new Date().toISOString();await writeFile(join(out,'auth-throttle-runtime.json'),JSON.stringify(report,null,2)+'\n');await mf?.dispose();await rm(root,{recursive:true,force:true});}
console.log(JSON.stringify({passed:report.passed,scenarios:report.results.length,artifactTreeSha256:report.artifactTreeSha256,externalRequests:report.externalRequests}));
