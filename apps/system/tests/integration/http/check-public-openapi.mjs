// @module verification
// @role public-openapi
import {prepareLocalD1, verifyCanonicalLedger} from "../../support/local-d1-fixture.mjs";
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFile,writeFile,mkdtemp,rm,mkdir,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join,basename} from 'node:path';import {createHash} from 'node:crypto';
const spec=JSON.parse(await readFile('docs/openapi.json')),ajv=new Ajv({allErrors:true,strict:false,validateSchema:false});
ajv.addSchema({...spec,$id:'contract'},'contract');
const operations=[];const ids=new Set();
for(const [path,item]of Object.entries(spec.paths))for(const [method,o]of Object.entries(item)){
 assert.ok(o.operationId&&!ids.has(o.operationId),'unique operation ID '+path);ids.add(o.operationId);assert.ok(Array.isArray(o.security));assert.ok(o.responses['200']?.content?.['application/json']?.schema);
 for(const scheme of o.security)for(const n of Object.keys(scheme))assert.ok(spec.components.securitySchemes[n]);
 const names=[...path.matchAll(/\{([^}]+)\}/g)].map(m=>m[1]);for(const n of names)assert.ok(o.parameters?.some(p=>p.in==='path'&&p.name===n&&p.required));
 const regex=new RegExp('^'+path.replace(/\{[^}]+\}/g,'[^/]+')+'$');
 const validators={};for(const [status,r]of Object.entries(o.responses)){assert.ok(r.content?.['application/json']?.schema,'response schema '+method+' '+path+' '+status);validators[status]=ajv.compile({$ref:'contract#/paths/'+path.replaceAll('~','~0').replaceAll('/','~1')+'/'+method+'/responses/'+status+'/content/application~1json/schema'});}
 operations.push({path,method,regex,o,validators});
}
const evidenceDir=process.env.PUBLIC_CONTRACT_EVIDENCE_DIR??'.local/evidence';
const report={startedAt:new Date().toISOString(),status:'running',sourceHashes:{},runtime:'actual local workerd and D1, synthetic ephemeral only',productionActions:0,schemaOperations:operations.length,responses:[],passed:false};
const root=await mkdtemp(join(tmpdir(),'public-contract-')),origin='https://synthetic.invalid',token='a'.repeat(43),hash=x=>createHash('sha256').update(x).digest('hex');let mf,db,lastSetCookie;
const sql=async(q,...v)=>db.prepare(q).bind(...v).run();
async function call(path,method='GET',body,options={}){
 const operation=operations.find(x=>x.method===method.toLowerCase()&&x.regex.test(path.split('?')[0]));assert.ok(operation,'documented '+method+' '+path);
 if(body&&(!options.status||options.status===200)){const validateInput=ajv.compile({$ref:'contract#/paths/'+operation.path.replaceAll('~','~0').replaceAll('/','~1')+'/'+method.toLowerCase()+'/requestBody/content/application~1json/schema'});assert.ok(validateInput(body),JSON.stringify({path,body,inputErrors:validateInput.errors}));}
 const r=await mf.dispatchFetch(origin+path,{method,headers:{...(options.anonymous?{}:{Authorization:'Bearer '+token}),...(body?{'Content-Type':'application/json'}:{}),...options.headers},...(body?{body:JSON.stringify(body)}:{})});lastSetCookie=r.headers.get('set-cookie');const value=await r.json();
 if(options.status!==undefined)assert.equal(r.status,options.status,JSON.stringify({path,method,value}));
 const validator=operation.validators[r.status];assert.ok(validator,'documented status '+r.status+' '+path);assert.ok(validator(value),JSON.stringify({path,method,status:r.status,value,errors:validator.errors}));assert.equal(r.headers.get('cache-control'),'no-store');
 report.responses.push({path:operation.path,method,status:r.status,error:value.error});return value;
}
await mkdir(evidenceDir,{recursive:true});await writeFile(join(evidenceDir,'public-contract-results.json'),JSON.stringify(report,null,2)+'\n');
try{
 const built=process.env.PROJEKTOR_TEST_BUILT==='1';report.testedBuiltArtifact=built;
 const compilation=built?null:await build({metafile:true,entryPoints:['src/apps/worker.ts'],outfile:root+'/worker.mjs',bundle:true,format:'esm',platform:'neutral',mainFields:['module','main'],conditions:['workerd','worker','browser'],external:['node:*','cloudflare:*'],plugins:[{name:'wasm',setup(b){b.onResolve({filter:/\.wasm$/},a=>({path:'./'+basename(a.path),external:true}));}}]});
 const sources=[...Object.keys(compilation?.metafile?.inputs??{}).filter(p=>p.startsWith('src/')),'src/adapters/crypto/generated/argon2.wasm','src/adapters/crypto/generated/blake2b.wasm','docs/openapi.json','tests/integration/http/check-public-openapi.mjs','tests/support/local-d1-fixture.mjs','package-lock.json',...(await readdir('migrations')).filter(n=>n.endsWith('.sql')).map(n=>'migrations/'+n)];
 report.sourceHashes=Object.fromEntries(await Promise.all(sources.map(async p=>[p,hash(await readFile(p))])));
 const workerPath=built?'dist/worker/index.js':root+'/worker.mjs';
 const modules=[{type:'ESModule',path:root+'/worker.mjs',contents:await readFile(workerPath,'utf8')}];
 const wasmRoot=built?'dist/worker':'src/adapters/crypto/generated';
 for(const name of (await readdir(wasmRoot)).filter(name=>name.endsWith('.wasm')))modules.push({type:'CompiledWasm',path:root+'/'+name,contents:await readFile(wasmRoot+'/'+name)});
 report.executedArtifacts=Object.fromEntries(modules.map(module=>[basename(module.path),{sha256:hash(module.contents),bytes:Buffer.byteLength(module.contents)}]));
 if(built)report.artifactManifestSha256=hash(await readFile('.local/verification/release/artifact-manifest.json'));
 const fixture=await prepareLocalD1(root);
 mf=new Miniflare(convertV4MiniflareOptions({modules,modulesRoot:root,compatibilityDate:'2026-10-09',compatibilityFlags:['nodejs_compat'],...fixture,bindings:{AUTH_ORIGIN:origin},host:'127.0.0.1',port:0,cf:false,logRequests:false}));await mf.ready;db=await mf.getD1Database('DB');
 await verifyCanonicalLedger(db);
 await sql("INSERT INTO principals VALUES('A','agent','Synthetic A',NULL,1,1)");await sql("INSERT INTO api_credentials VALUES('A-key','A',?,unixepoch()+10000,NULL)",hash(token));
 const workspace='11111111-1111-4111-8111-111111111111';await sql("INSERT INTO workspaces VALUES(?,'Synthetic workspace','{}')",workspace);await sql("INSERT INTO projects VALUES('P',?,'P','p','Synthetic project','','{}')",workspace);
 for(const scope of ['P','workspace:'+workspace])for(const permission of ['view','edit','assign','transition','execute','manage']){await sql('INSERT INTO memberships VALUES(?,?,?)','A',scope,permission);await sql('INSERT INTO api_grants VALUES(?,?,?)','A-key',scope,permission);}
 await call('/api/health');await call('/api/auth/context','GET',null,{anonymous:true});await call('/api/auth/me');await call('/api/projects/P/access');await call('/api/directory');await call('/api/projects/P/assignees');await call('/api/management/context');
 const refs=[{kind:'link',url:' https://example.invalid/raw '},{kind:'library',libraryFileId:'libfile_synthetic',versionId:'001'}];
 const operationPreparation={route:{kind:'issue',projectId:'P'},input:{operationId:'rest_prepared',body:'durable REST body',title:'Recovery'}};
 const prepared=await call('/api/agent/operations','POST',operationPreparation,{status:200});assert.equal(prepared.operation.recorded,true);assert.equal(prepared.operation.result.status,'unknown');assert.equal(prepared.requestHash,hash(JSON.stringify(operationPreparation)));
 const pending=await call('/api/agent/operations/rest_prepared');assert.deepEqual(pending.input,prepared.operation.input);
 const summaries=await call('/api/agent/operations?after=0&limit=20');assert(summaries.operations.some(o=>o.operationId==='rest_prepared'));assert(summaries.operations.every(o=>!('input' in o)&&!('snapshot' in o.result)));
 const executed=await call('/api/agent/operations/rest_prepared/execute','POST',{}, {status:200});assert.equal(executed.operationId,'rest_prepared');assert.equal((await call('/api/agent/operations/rest_prepared')).result.status,'confirmed');
 const issue=await call('/api/projects/P/issues','POST',{operationId:'create',body:'body',title:'Title',references:refs},{status:200});const issuePath='/api/projects/P/issues/'+issue.snapshot.id;
 await call(issuePath);await call('/api/projects/P/issues?mine=0');await call('/api/projects/P/issue-operations/create');const missingReceipt=await call('/api/projects/P/issue-operations/never-recorded','GET',null,{status:404});assert.equal(missingReceipt.operationId,'never-recorded');assert.equal(missingReceipt.application,'unknown');
 const edited=await call(issuePath,'PATCH',{operationId:'edit',revision:1,title:'Edited',body:'updated',references:[],priority:5,assigneeId:'A',state:'Done',schedule:{start:{kind:'date',date:'2026-10-12'},end:null,due:{kind:'unknown'}},parentId:null,typeId:null},{status:200});assert.equal(edited.snapshot.revision,2);await call(issuePath+'/history');
 await call(issuePath,'PATCH',{operationId:'conflict',revision:1,body:'stale'},{status:409});await call(issuePath,'PATCH',{operationId:'spoof',revision:2,body:'spoof',actorId:'B'},{status:400});
 for(const scope of ['/api/projects/P','/api/workspaces/'+workspace]){
 const w=await call(scope+'/wikis','POST',{operationId:'wiki'+(scope.includes('workspaces')?'w':'p'),body:'',title:'Wiki',references:refs},{status:200});const wp=scope+'/wikis/'+w.snapshot.id;
 await call(wp);await call(scope+'/wikis');await call(scope+'/wiki-operations/'+w.operationId);await call(wp,'PATCH',{operationId:'wiki_edit'+w.snapshot.id.slice(-4),revision:1,references:[]},{status:200});await call(wp+'/history');
 const parentPaths=[wp,...(scope.includes('projects')?[issuePath]:[])];
 for(const pp of parentPaths){const op='comment_'+pp.split('/').at(-1).slice(-8),c=await call(pp+'/comments','POST',{operationId:op,body:'comment'},{status:200}),cp=pp+'/comments/'+c.snapshot.id;await call(cp);await call(pp+'/comments');await call(cp,'PATCH',{operationId:op+'_edit',revision:1,body:'changed'},{status:200});await call(cp+'/history');await call(pp+'/comment-operations/'+op);}
 }
 await call('/api/management/records?kind=principal','GET',null,{status:403});
 await sql("UPDATE principal_management SET global_administrator=1 WHERE principal_id='A'");
 await call('/api/management/records?kind=principal');await call('/api/management/records/A?kind=principal');await call('/api/management/records?kind=membership&projectId=P');await call('/api/management/records?kind=credential');await call('/api/management/records?kind=scope&projectId=P');await call('/api/projects/P/credential-scopes/A-key','PUT',{operationId:'scope_update',revision:1,permissions:['view','edit','assign','transition','execute','manage']},{status:200});
 await call('/api/management/principals','POST',{operationId:'register',principalId:'B',kind:'human',displayName:'Synthetic B',loginId:'synthetic-b',projects:[{projectId:'P',permissions:['view']}]},{status:200});
 await call('/api/management/history?kind=principal&targetId=B');await call('/api/management/operations/register');await call('/api/projects/P/principals/B/display');
 await call('/api/management/principals/B','PATCH',{operationId:'rename',revision:1,displayName:'Renamed'},{status:200});await call('/api/management/history?kind=principal&targetId=B');
 await call('/api/projects/P/memberships/B','PUT',{operationId:'member',revision:1,permissions:['view','edit']},{status:200});
 const recipientBase='/api/auth/password-setup/recipient';
 const newChallenge=async()=>{const result=await call('/api/auth/context','GET',null,{anonymous:true});return{Origin:origin,Cookie:lastSetCookie.split(';')[0],'X-CSRF-Token':result.csrfToken};};
 const newRecipient=async()=>{const h=await newChallenge(),r=await call(recipientBase+'/context','POST',{}, {anonymous:true,headers:h,status:200});return{...r,headers:{...h,Cookie:lastSetCookie.split(';')[0]}};};
 const firstRecipient=await newRecipient();assert.equal((await call(recipientBase+'/status','POST',{}, {anonymous:true,headers:firstRecipient.headers,status:200})).state,'waiting');
 await call('/api/management/principals/B/password-setup');const setup=await call('/api/management/principals/B/password-setup/issue','POST',{operationId:'setup',revision:1,purpose:'initial',recipientRequestId:firstRecipient.requestId},{status:200});assert.equal(setup.setupRight,undefined);await call('/api/management/password-setup/operations/setup');
 const activeChallenge=await newChallenge();await call(recipientBase+'/abandon','POST',{requestId:firstRecipient.requestId}, {anonymous:true,headers:{...activeChallenge,Cookie:activeChallenge.Cookie+'; '+firstRecipient.headers.Cookie},status:403});assert.equal(lastSetCookie,null);
 await call('/api/management/principals/B/password-setup/revoke','POST',{operationId:'revoke_setup',revision:setup.snapshot.revision},{status:200});
 const abandonChallenge=await newChallenge();assert.deepEqual(await call(recipientBase+'/abandon','POST',{requestId:firstRecipient.requestId}, {anonymous:true,headers:{...abandonChallenge,Cookie:abandonChallenge.Cookie+'; '+firstRecipient.headers.Cookie},status:200}),{abandoned:true});assert.equal(lastSetCookie,null);
 assert.deepEqual(await call(recipientBase+'/abandon','POST',{requestId:firstRecipient.requestId}, {anonymous:true,headers:await newChallenge(),status:200}),{abandoned:false,reason:'context_missing'});
 const recipient=await newRecipient(),browserHeaders=recipient.headers;
 await call('/api/management/principals/B/password-setup/issue','POST',{operationId:'setup_second',revision:setup.snapshot.revision+1,purpose:'initial',recipientRequestId:recipient.requestId},{status:200});
 const state=await call(recipientBase+'/status','POST',{}, {anonymous:true,headers:browserHeaders,status:200});assert.equal(state.state,'ready');
 const passwordCommand={operationId:state.operationId,principalId:state.principalId,issuerId:state.issuerId,purpose:state.purpose,password:'Synthetic-testing-password!'};
 const denied=await call(recipientBase+'/complete','POST',{...passwordCommand,principalId:'A'}, {anonymous:true,headers:browserHeaders,status:403});assert.deepEqual(Object.keys(denied).sort(),['application','error','operationId']);assert.equal(denied.application,'unknown');assert.equal(denied.operationId,state.operationId);
 const completed=await call(recipientBase+'/complete','POST',passwordCommand, {anonymous:true,headers:browserHeaders,status:200});assert.equal(completed.state,'completed');
 assert.equal((await call(recipientBase+'/status','POST',{}, {anonymous:true,headers:browserHeaders,status:200})).state,'completed');
 assert.equal((await call(recipientBase+'/complete','POST',passwordCommand, {anonymous:true,headers:browserHeaders,status:200})).source,'recovered');
 await call(recipientBase+'/status','POST',{}, {anonymous:true,headers:{...browserHeaders,Origin:'https://attacker.invalid'},status:403});
 // Only an already-issued unbound grant retains the old migration consumption routes.
 await sql("INSERT INTO principals VALUES('LEGACY','human','Legacy synthetic','legacy-contract',1,1)");const legacyRight='v'.repeat(43);await sql("INSERT INTO password_setup_rights(id,principal_id,token_hash,purpose,target_auth_version,issued_at,expires_at) VALUES('legacy-contract-right','LEGACY',?,'initial',1,unixepoch(),unixepoch()+600)",hash(legacyRight));await sql("UPDATE password_setup_states SET latest_right_id='legacy-contract-right' WHERE principal_id='LEGACY'");const legacyHeaders=await newChallenge();
 await call('/api/auth/password-setup/context','POST',{setupRight:legacyRight},{anonymous:true,headers:legacyHeaders,status:200});
 await call('/api/auth/password-setup/complete','POST',{setupRight:legacyRight,operationId:'legacy_complete',password:'Synthetic-legacy-password!'},{anonymous:true,headers:legacyHeaders,status:200});
 await call('/api/auth/password-setup/result','POST',{setupRight:legacyRight,operationId:'legacy_complete'},{anonymous:true,headers:legacyHeaders,status:200});
 await sql("INSERT INTO auth_settings SELECT 'dummy_password_hash',encoded_hash FROM passwords WHERE principal_id='B'");
 const lc=await mf.dispatchFetch(origin+'/api/auth/context'),lb=await lc.json(),lh={Origin:origin,Cookie:lc.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':lb.csrfToken};
 await call('/api/auth/login','POST',{loginId:'synthetic-b',password:'Synthetic-testing-password!'},{anonymous:true,headers:lh,status:200});
 const sessionCookie=lastSetCookie.split(';')[0],me=await call('/api/auth/me','GET',null,{anonymous:true,headers:{Cookie:sessionCookie},status:200});
 await call('/api/auth/logout','POST',undefined,{anonymous:true,headers:{Cookie:sessionCookie,Origin:origin,'X-CSRF-Token':me.csrfToken},status:200});
 await call('/api/auth/me','GET',null,{anonymous:true,headers:{Cookie:sessionCookie},status:401});
 await call('/api/auth/password-setup/owner-initial','POST',{operationId:'owner_denied'},{anonymous:true,headers:browserHeaders,status:403});
 // New owner routes must be documented even when this fixture has no owner capability/bootstrap.
 await call('/api/auth/password-setup/owner-initial/context','POST',{}, {anonymous:true,headers:{Origin:origin},status:403});
 await call('/api/auth/password-setup/owner-initial/status','POST',{operationId:'owner_denied'}, {anonymous:true,headers:browserHeaders,status:403});
 await call('/api/auth/password-setup/owner-initial/complete','POST',{operationId:'owner_denied',password:'Synthetic-testing-password!'}, {anonymous:true,headers:browserHeaders,status:403});
 const nonce='n'.repeat(43),bc=await mf.dispatchFetch(origin+'/api/auth/context'),bcBody=await bc.json(),bcHeaders={Origin:origin,Cookie:bc.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':bcBody.csrfToken};
 await call('/api/auth/browser-session/context','POST',{nonce:'z'.repeat(43)},{anonymous:true,headers:{Origin:origin},status:403});
 const bx=await mf.dispatchFetch(origin+'/api/auth/browser-session/context',{method:'POST',headers:{...bcHeaders,'Content-Type':'application/json'},body:JSON.stringify({nonce})});assert.equal(bx.status,200);const bxBody=await bx.json();assert.ok(operations.find(o=>o.path==='/api/auth/browser-session/context').validators[200](bxBody));report.responses.push({path:'/api/auth/browser-session/context',method:'POST',status:200});
 const ticket=await call('/api/auth/browser-session/tickets','POST',{nonce},{status:200});
 await call('/api/auth/browser-session/redeem','POST',{nonce,ticket:ticket.ticket},{anonymous:true,headers:{...bcHeaders,Cookie:bx.headers.get('set-cookie').split(';')[0]},status:200});
 await call('/api/auth/browser-session/redeem','POST',{nonce,ticket:ticket.ticket},{anonymous:true,headers:{...bcHeaders,Cookie:bx.headers.get('set-cookie').split(';')[0]},status:403});
 await sql("UPDATE issues SET number=99 WHERE id=?",issue.snapshot.id);await call('/api/resolve?path='+encodeURIComponent('/projects/P/issues/99/title'), 'GET',null,{status:200});
 await sql("INSERT INTO imported_entities VALUES('issues',?,?,?,'{\"id\":\"source-fixed\",\"version\":0}',?)",issue.snapshot.id,workspace,'P','synthetic-hash');
 await call('/api/projects/P/source/issues/'+issue.snapshot.id,'GET',null,{status:200});await call('/api/projects/P/source/issues/missing','GET',null,{status:404});await sql("INSERT INTO imported_entities VALUES('wiki_pages','source-wiki',?,?,'{}','synthetic')",workspace,'workspace:'+workspace);await call('/api/workspaces/'+workspace+'/source/wiki_pages/source-wiki','GET',null,{status:200});
 await sql("INSERT INTO api_credentials VALUES('revoke-key','A',?,unixepoch()+10000,NULL)",hash('r'.repeat(43)));await call('/api/management/credentials/revoke-key/revoke','POST',{operationId:'credential_revoke',revision:1},{status:200});

 const ex=issuePath+'/execution',rp=issuePath+'/execution-reports';await call(ex);const acquired=await call(ex+'/acquire','POST',{operationId:'acquire'},{status:200});
 const lease={attemptId:acquired.snapshot.attemptId,leaseVersion:acquired.snapshot.leaseVersion};
 await call(ex+'/renew','POST',{operationId:'early_renew',...lease},{status:409});
 for(const action of ['progress','failed','completed'])await call(rp+'/'+action,'POST',{operationId:action,attemptId:lease.attemptId,message:'Synthetic '+action,...(action==='failed'?{failureReason:'Synthetic failure'}:{}),references:refs},{status:200});
 await call(rp);await call(rp+'/history');await call('/api/projects/P/execution-operations/acquire');await call('/api/projects/P/execution-report-operations/progress');
 const interrupted=await call(ex+'/interrupt','POST',{operationId:'interrupt',...lease},{status:200});
 const confirmed=await call(rp+'/reconcile','POST',{operationId:'reconcile',attemptId:lease.attemptId,leaseVersion:interrupted.snapshot.leaseVersion,outcome:'not_performed',message:'Synthetic observation',externalOperationId:'synthetic-external'},{status:200});

 await call(rp+'/restart','POST',{operationId:'restart_blocked',attemptId:lease.attemptId,leaseVersion:confirmed.snapshot.confirmation.leaseVersion,confirmationOperationId:'reconcile'},{status:409});
 const second=await call('/api/projects/P/issues','POST',{operationId:'second_issue',body:'second'},{status:200}),secondPath='/api/projects/P/issues/'+second.snapshot.id;
 await call(secondPath,'PATCH',{operationId:'assign_second',revision:1,assigneeId:'A'},{status:200});const secondEx=secondPath+'/execution',secondRp=secondPath+'/execution-reports';
 const a2=await call(secondEx+'/acquire','POST',{operationId:'acquire_second'},{status:200}),i2=await call(secondEx+'/interrupt','POST',{operationId:'interrupt_second',attemptId:a2.snapshot.attemptId,leaseVersion:1},{status:200});
 const c2=await call(secondRp+'/reconcile','POST',{operationId:'reconcile_second',attemptId:a2.snapshot.attemptId,leaseVersion:i2.snapshot.leaseVersion,outcome:'not_performed',message:'Synthetic observation',externalOperationId:'synthetic-external-second'},{status:200});
 const restarted=await call(secondRp+'/restart','POST',{operationId:'restart',attemptId:a2.snapshot.attemptId,leaseVersion:c2.snapshot.confirmation.leaseVersion,confirmationOperationId:'reconcile_second'},{status:200});
 await call(secondEx+'/end','POST',{operationId:'end',attemptId:restarted.snapshot.attempt.attemptId,leaseVersion:restarted.snapshot.attempt.leaseVersion},{status:200});await call(secondRp+'/history');
 await sql("UPDATE write_gate SET mode='stopped'");await call(issuePath);await call(issuePath,'PATCH',{operationId:'stopped',revision:2,body:'denied'},{status:503});await call('/api/auth/me');
 await sql("UPDATE write_gate SET mode='importing'");await call(issuePath,'GET',null,{status:503});await call('/api/management/context','GET',null,{status:503});await call('/api/management/principals/B/password-setup');await call('/api/auth/me');await call('/api/health');
 await sql("UPDATE write_gate SET mode='open'");await sql("UPDATE api_credentials SET revoked_at=unixepoch() WHERE id='A-key'");await call(issuePath,'GET',null,{status:401});await call('/api/projects/P/issue-operations/create','GET',null,{status:401});
 report.observedOperations=new Set(report.responses.map(x=>x.method+' '+x.path)).size;assert.equal(report.observedOperations,operations.length);report.unobservedSuccessfulOperations=operations.filter(o=>!report.responses.some(x=>x.path===o.path&&x.method.toLowerCase()===o.method&&x.status===200)).map(o=>({path:o.path,method:o.method}));report.passed=true;report.status='passed';
}catch(error){report.status='failed';report.failure=error instanceof Error?error.message:'unavailable';throw error;}finally{report.finishedAt=new Date().toISOString();await writeFile(join(evidenceDir,'public-contract-results.json'),JSON.stringify(report,null,2)+'\n');if(mf)await mf.dispose();await rm(root,{recursive:true,force:true});}
console.log(JSON.stringify({passed:report.passed,schemaOperations:report.schemaOperations,runtimeResponses:report.responses.length}));
