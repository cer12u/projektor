// @module verification
// @role result-lookup-http-contract
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const temp=await mkdtemp(join(tmpdir(),'projektor-result-boundaries-'));
const files=['outcomes','issue','content','issue-execution','execution-reports','management','password-setup','owner-initial-setup','result-route'];
const report={level:'actual bundled HTTP adapters with synthetic typed ports; no D1/runtime claim',sources:{},results:[]};
for(const file of files)report.sources[file]=createHash('sha256').update(await readFile('src/apps/http/'+file+'.ts')).digest('hex');
try{
 await build({stdin:{contents:files.map(f=>`export * from './src/apps/http/${f}';`).join('\n')+"\nexport {IdentityError} from './src/modules/identity/public';export {MutationError} from './src/adapters/d1/persistence/public';",resolveDir:process.cwd(),sourcefile:'boundary-tests.ts'},outfile:join(temp,'test.mjs'),bundle:true,platform:'node',format:'esm',loader:{'.wasm':'binary'}});
 const api=await import(pathToFileURL(join(temp,'test.mjs')).href),origin='https://test.example.invalid',operationId='known-operation';
 const cases=[['issueApi','/api/projects/P/issue-operations/'],['contentApi','/api/projects/P/wiki-operations/'],['contentApi','/api/projects/P/issues/I/comment-operations/'],['issueExecutionApi','/api/projects/P/execution-operations/'],['executionReportsApi','/api/projects/P/execution-report-operations/'],['managementApi','/api/management/operations/'],['passwordSetupApi','/api/management/password-setup/operations/'],['passwordSetupApi','/api/auth/password-setup/result']];
 for(const [handler,path]of cases){
  for(const mode of ['pre-auth','denied','unavailable','missing','unexpected','legacy-protected']){
   const produce=async()=>{if(mode==='unexpected')throw new Error('private database detail');if(mode==='legacy-protected')throw new api.MutationError(403,'forbidden',undefined,{privateBody:'hidden'});return mode==='missing'?{status:'missing',operationId,application:'unknown',failure:{kind:'not_found',code:'operation_not_found'}}:{status:mode==='denied'?'denied':'unavailable',failure:{kind:mode==='denied'?'forbidden':'unavailable',code:mode}};};
   const identity={validateChallenge:async()=>{if(mode==='pre-auth')throw new api.IdentityError('unauthenticated','expired');},setupResult:produce,setupManagementResult:produce,managementResult:produce};
   const requests={identity,authenticate:async()=>{if(mode==='pre-auth')throw new api.IdentityError('unauthenticated','expired');return{actor:{authentication:'api'},identity,work:{issueResult:produce,contentResult:produce},execution:{result:produce,reportResult:produce}};}};
   const holder=path.endsWith('/result');const request=new Request(origin+path+(holder?'':operationId),{method:holder?'POST':'GET',headers:holder?{'Content-Type':'application/json',Origin:origin,'X-CSRF-Token':'c'.repeat(43)}:{},...(holder?{body:JSON.stringify({operationId,setupRight:'s'.repeat(43)})}:{})});
   const response=await api[handler](request,requests,origin),body=await response.json();
   assert.equal(response.status,mode==='pre-auth'?401:mode==='missing'?404:mode==='denied'||mode==='legacy-protected'?403:503,handler+':'+mode);
   assert.equal(body.operationId,operationId,handler+':'+mode);assert.equal(body.application,'unknown');
   for(const key of ['current','snapshot','mutationOutcome','body'])assert.ok(!(key in body));assert.ok(!JSON.stringify(body).includes('private'));
  }
  report.results.push({route:path,passed:true});
 }
 for(const path of ['','/status','/complete']){
  const request=new Request(origin+'/api/auth/password-setup/owner-initial'+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,'X-CSRF-Token':'c'.repeat(43),Cookie:'__Host-projektor_owner_setup='+'b'.repeat(43)},body:JSON.stringify({operationId,...(path==='/complete'?{password:'synthetic-password'}:{})})});
  const fail=async()=>{throw new api.IdentityError('forbidden','owner_setup_unavailable');};const response=await api.ownerInitialSetupApi(request,{identity:{ownerInitial:fail,ownerStatus:fail,ownerComplete:fail}},origin),body=await response.json();assert.equal(response.status,403);assert.equal(body.operationId,operationId);assert.ok(!('snapshot'in body));
 }
 report.results.push({name:'owner issue/status/complete retain known operation ID on typed denial',passed:true});
 const absent=await api.resultValue(Promise.resolve({status:'denied',failure:{kind:'forbidden'}}),undefined,operationId).catch(error=>error);assert.equal(absent.body.operationId,operationId);assert.equal(absent.body.application,'unknown');
 await build({entryPoints:['src/apps/worker.ts'],outfile:join(temp,'outer.mjs'),bundle:true,platform:'node',format:'esm',loader:{'.wasm':'binary'},plugins:[{name:'outer-boundary-synthetic-ports',setup(builder){
  builder.onLoad({filter:/\/apps\/composition\.ts$/},()=>({contents:'export function createRequestServices(){return {}}',loader:'ts'}));
  builder.onLoad({filter:/\/d1\/runtime\.ts$/},()=>({contents:'export async function readRequestGate(){return "importing"} export async function readDatabaseHealth(){}',loader:'ts'}));
  builder.onLoad({filter:/\/retained-namespaces\.ts$/},()=>({contents:'export class RateLimiter{} export class WorkspaceHub{}',loader:'ts'}));
 }}]});
 report.sources.index=createHash('sha256').update(await readFile('src/apps/worker.ts')).digest('hex');
 const outer=(await import(pathToFileURL(join(temp,'outer.mjs')).href)).default,env={AUTH_ORIGIN:origin,DB:{withSession:()=>({})}};
 for(const path of ['/api/projects/P/issue-operations/','/api/projects/P/wiki-operations/','/api/projects/P/issues/I/comment-operations/','/api/projects/P/execution-operations/','/api/projects/P/execution-report-operations/','/api/management/operations/','/api/workspaces/11111111-1111-4111-8111-111111111111/wiki-operations/','/api/workspaces/11111111-1111-4111-8111-111111111111/wikis/W/comment-operations/']){
  const response=await outer.fetch(new Request(origin+path+operationId),env),body=await response.json();assert.equal(response.status,503);assert.deepEqual(body,{error:'import_in_progress',operationId,application:'unknown'});assert.equal(response.headers.get('Retry-After'),'1');
 }
 for(const path of ['/api/unrelated/issue-operations/'+operationId,'/api/projects/P/issues/'+operationId,'/api/projects/P/issue-operations/not%20valid'])assert.equal(api.resultLookupOperationId(path),undefined);
 report.results.push({name:'outer import gate preserves exact bounded receipt-route ID without auth/body reads or cert; unrelated suffixes excluded',passed:true});
 report.passed=true;
}catch(error){report.passed=false;report.failure=error.message;throw error;}
finally{await mkdir('.local/evidence',{recursive:true});await writeFile('.local/evidence/result-lookup-boundaries.json',JSON.stringify(report,null,2)+'\n');await rm(temp,{recursive:true,force:true});}
console.log(JSON.stringify(report));
