// @module verification
// @role identity-application
// Hypothesis: raw browser/setup proofs or state-dependent policy leak through to persistence.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const directory=await mkdtemp(join(tmpdir(),'projektor-identity-application-')),results=[];
const hash=x=>createHash('sha256').update(x).digest('hex');
const check=async(name,run)=>{await run();results.push({name,passed:true});};
const agent={id:'agent',kind:'agent',display_name:'Agent',auth_version:1,authentication:'api',credential_id:'key',token_hash:'key-hash',csrf_token:null};
const human={...agent,id:'human',kind:'human',authentication:'session',credential_id:null};
const proof='p'.repeat(43),a='a'.repeat(43),b='b'.repeat(43),c='c'.repeat(43);
const source={memberships:[{projectId:'P',permission:'view'},{projectId:'P',permission:'edit'},{projectId:'Q',permission:'view'}],grants:[{projectId:'P',permission:'view'},{projectId:'P',permission:'execute'}]};
function harness(create,actor=agent,overrides={},verifier={}){
 let sequence=0;const calls=[];
 const store=new Proxy({authenticateApi:async()=>actor,authenticateSessionAndTouch:async()=>actor,...overrides},{get(target,key){if(key in target)return async(...args)=>{calls.push({method:key,args});return target[key](...args);};return()=>{throw Error('unexpected persistence '+String(key));};}});
 const effects={digest:async x=>hash(x),randomToken:()=>String(++sequence).padStart(43,'0'),verifyPassword:async()=>true,hashPassword:async()=>'<encoded>',setupInputHash:async(x,y)=>hash(x+':'+y)};
 return{app:create(store,effects,verifier,1000),calls,generated:()=>sequence};
}
try{
 const bundle=async(name,negative=false)=>{
  await build({entryPoints:['src/modules/identity/application.ts'],outfile:join(directory,name+'.mjs'),bundle:true,format:'esm',platform:'node',plugins:negative?[{name:'remove-eligibility',setup(b){b.onLoad({filter:/identity\/application\.ts$/},async args=>({contents:(await readFile(args.path,'utf8')).replace('const issuer=browserIssuer(auth);browserProof(nonce);','const issuer=auth;'),loader:'ts'}));}}]:[]});
  return (await import(pathToFileURL(join(directory,name+'.mjs')))).createIdentityApplication;
 };
 const create=await bundle('application');
 await check('human/session/federated sources are rejected before ticket persistence',async()=>{
  for(const actor of [human,{...agent,authentication:'session'},{...agent,authentication:'federated'}]){const h=harness(create,actor);const user=await h.app.authenticate({kind:'api',token:proof});await assert.rejects(user.api.browserTicket(a),e=>e.failure?.code==='api_credential_required');assert.equal(h.calls.length,1);assert.equal(h.generated(),0);}
 });
 await check('negative control detects bypass of application eligibility before storage',async()=>{
  const h=harness(await bundle('unsafe',true),human,{readBrowserScope:async()=>source,commitBrowserTicket:async()=>({principalId:'human',expiresAt:1060})});
  const user=await h.app.authenticate({kind:'api',token:proof});await user.api.browserTicket(a);assert(h.calls.some(c=>c.method==='commitBrowserTicket'));
 });
 await check('every malformed redemption proof is rejected before crypto or persistence',async()=>{
  for(let i=0;i<4;i++){const h=harness(create),proofs=[proof,a,b,c];proofs[i]='invalid';await assert.rejects(h.app.entry.browserRedeem(...proofs),e=>e.failure?.kind==='invalid');assert.equal(h.calls.length,0);assert.equal(h.generated(),0);}
 });
 await check('scope is an exact intersection, with hashed proofs and authoritative ticket bounds',async()=>{
  const h=harness(create,agent,{readBrowserScope:async()=>source,commitBrowserTicket:async()=>({principalId:agent.id,expiresAt:1055})});const user=await h.app.authenticate({kind:'api',token:proof});const result=await user.api.browserTicket(a),command=h.calls.find(c=>c.method==='commitBrowserTicket').args[1];
  assert.deepEqual(command.scope,[{projectId:'P',permission:'view'}]);assert.equal(command.lifetimeSeconds,60);assert.equal(command.nonceHash,hash(a));assert.equal(command.ticketHash,hash(result.ticket));assert.equal(result.expiresAt,1055);assert.equal(JSON.stringify(command).includes(result.ticket),false);assert.notDeepEqual(command.scope,source.memberships);
 });
 await check('redemption creates effects in application, persists only hash and explicit session bound',async()=>{
  const h=harness(create,agent,{redeemBrowserOnce:async()=>{}}),result=await h.app.entry.browserRedeem(proof,a,b,c),command=h.calls[0].args[0];assert.equal(command.sessionHash,hash(result.sessionToken));assert.equal(command.absoluteSeconds,90*86400);assert.equal(command.ticketHash,hash(proof));assert.equal(command.browserHash,hash(b));assert(!JSON.stringify(command).includes(result.sessionToken));
 });
 await check('browser context reports actual database deadline rather than a separate client-clock guess',async()=>{
  const h=harness(create,agent,{challengeValid:async()=>true,reserveBrowserContext:async()=>({expiresAt:1127})});const result=await h.app.entry.browserContext(a,b,c),command=h.calls.find(c=>c.method==='reserveBrowserContext').args[0];assert.equal(command.lifetimeSeconds,120);assert.equal(result.expiresAt,1127);assert.equal(command.browserHash,hash(result.browserToken));
 });
 await check('login limit and challenge policy is supplied by application',async()=>{
  const h=harness(create,agent,{reserveLoginContext:async()=>true,challengeValid:async()=>true,countAttempts:async()=>false});await h.app.entry.createLoginContext('synthetic-source');const context=h.calls[0].args[0];assert.equal(context.lifetimeSeconds,600);assert.equal(context.windowSeconds,900);assert.equal(context.maximum,60);
  await assert.rejects(h.app.entry.passwordLogin({loginId:'person',password:'password'},{challenge:a,csrf:b,source:'synthetic'}),e=>e.failure?.kind==='rate_limited');const limits=h.calls.find(c=>c.method==='countAttempts').args[0];assert.equal(limits.accountMaximum,5);assert.equal(limits.sourceMaximum,30);assert.equal(limits.windowSeconds,900);
 });
 await check('setup capability readers receive hashes, never the raw bearer',async()=>{
  const h=harness(create,agent,{readOwnerBrowserBinding:async()=>null,setupContext:async()=>({}),setupResult:async()=>({status:'missing'})});await h.app.entry.setupContext(a,null);await h.app.entry.setupResult(a,'op',null);for(const call of h.calls)assert.equal(call.args[0],hash(a));
 });
 await check('setup replacement binds a prior recipient context and never emits a bearer',async()=>{
  const expected={principalId:'target',revision:3,authVersion:2,rightId:'old',purpose:'initial',expiresAt:1500,consumedAt:null,revokedAt:null};
  for(const purpose of ['initial','reset',null])for(const resultSource of ['committed']){const h=harness(create,human,{readSetupManagement:async()=>({kind:'observed',observation:{snapshot:expected,pendingRightIds:['old'],recipient:{requestId:a,expiresAt:1600}}}),commitSetupManagement:async()=>({application:'confirmed',disclosure:'allowed',source:resultSource,receipt:{operationId:'op',snapshot:expected}})});const user=await h.app.authenticate({kind:'session',token:proof}),result=await user.api.setupManage('target','op',3,purpose,purpose?a:undefined),plan=h.calls.find(c=>c.method==='commitSetupManagement').args[1];assert.deepEqual(plan.expected,expected);assert.deepEqual(plan.revokeRightIds,['old']);assert.equal(plan.nextRightId,purpose?plan.action.rightId:'old');assert.equal(result.setupRight,undefined);if(purpose){assert.equal(plan.action.expectedPasswordCount,purpose==='initial'?0:1);assert.equal(plan.action.lifetimeSeconds,1800);assert.equal(plan.action.expiresAt,1600);assert.equal(plan.action.recipientRequestId,a);assert(!JSON.stringify(plan).includes('setupRight'));}}
 });
 await check('principal auth-version planning changes only on activation transition; recovery bypasses planning',async()=>{
  const snapshot={principalId:'target',kind:'human',displayName:'Target',active:1,authVersion:7,globalAdministrator:0,revision:3};
  for(const active of [true,false,null]){const h=harness(create,human,{readManagementForChange:async()=>({kind:'observed',snapshot}),commitManagement:async()=>({application:'unknown'})});const user=await h.app.authenticate({kind:'session',token:proof});await user.api.managementExecute({operationId:'op',kind:'management.principal.update',targetId:'target',projectId:'GLOBAL',input:{revision:3,displayName:'Renamed',active}});const plan=h.calls.find(c=>c.method==='commitManagement').args[1];assert.equal(plan.principal.authVersion,active===false?8:7);assert.equal(plan.principal.displayName,'Renamed');}
  const outcome={application:'confirmed',disclosure:'allowed',source:'recovered',receipt:{operationId:'op',snapshot}},h=harness(create,human,{readManagementForChange:async()=>({kind:'outcome',outcome})});const user=await h.app.authenticate({kind:'session',token:proof});assert.deepEqual(await user.api.managementExecute({operationId:'op',kind:'management.principal.update',targetId:'target',projectId:'GLOBAL',input:{revision:3,displayName:'Renamed',active:false}}),outcome);
 });
 await check('owner domain accepts provider-neutral normalized binding but rejects mismatched verifier identity',async()=>{
  const configuration={ownerId:'configured-owner',issuer:'issuer',audience:'audience',subject:'subject',closesAt:1600};
  for(const mismatch of [false,true]){const h=harness(create,human,{readOwnerContext:async()=>({expiresAt:1700,operationId:null,ownerId:null}),readOwnerConfiguration:async()=>'<opaque provider configuration>',issueOwnerSetup:async c=>({state:'ready',principalId:c.configuration.ownerId,expiresAt:c.expiresAt})},{ownerConfiguration:()=>configuration,owner:async()=>({...configuration,subject:mismatch?'other':'subject',expiresAt:1500,notBefore:900})});
   if(mismatch){await assert.rejects(h.app.entry.ownerInitial('verified-elsewhere','op',a,b),e=>e.failure?.code==='owner_initial_rejected');assert(!h.calls.some(c=>c.method==='issueOwnerSetup'));}else{const result=await h.app.entry.ownerInitial('verified-elsewhere','op',a,b);assert.equal(result.principalId,'configured-owner');assert.equal(result.expiresAt,1500);}}
 });
 await check('recipient HTTP generic completion failure retains only known operation identity and uncertainty',async()=>{
  await build({entryPoints:['src/apps/http/recipient-setup.ts'],outfile:join(directory,'recipient-http.mjs'),bundle:true,format:'esm',platform:'node',loader:{'.wasm':'binary'}});const {recipientSetupApi}=await import(pathToFileURL(join(directory,'recipient-http.mjs')));
  const origin='https://recipient.invalid',request=new Request(origin+'/api/auth/password-setup/recipient/complete',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-CSRF-Token':a,Cookie:'__Host-projektor_recipient_setup='+b},body:JSON.stringify({operationId:'known-completion',principalId:'target',issuerId:'admin',purpose:'initial',password:'Synthetic-password!'})});
  const response=await recipientSetupApi(request,{identity:{recipientComplete:async()=>{throw Error('private persistence fault');}}},origin);assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'recipient_setup_unavailable',operationId:'known-completion',application:'unknown'});
 });
 const paths=['src/modules/identity/application.ts','src/modules/identity/rules.ts','src/modules/identity/ports.ts','src/apps/http/recipient-setup.ts'];await mkdir('.local/evidence',{recursive:true});await writeFile('.local/evidence/identity-application.json',JSON.stringify({passed:true,runtime:'pure application and injected in-memory ports, not D1',results,sourceHashes:Object.fromEntries(await Promise.all(paths.map(async p=>[p,hash(await readFile(p))])))},null,2)+'\n');console.log(JSON.stringify({passed:true,groups:results.length}));
}finally{await rm(directory,{recursive:true,force:true});}
