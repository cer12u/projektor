// @module verification
// @role operation-regression
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
// Focused transport boundary checks. Actual persistence/restart is covered by check-agent-operation-recovery.mjs.
const candidate=fileURLToPath(new URL("../../../",import.meta.url));
const bundle=await build({entryPoints:[candidate+'/src/agent/public.ts'],bundle:true,write:false,format:'esm',platform:'browser',metafile:true});
assert(!Object.keys(bundle.metafile.inputs).some(path=>/private-json-provider|agent-file-providers|access-service-auth/.test(path)));
assert(Object.values(bundle.metafile.outputs).every(output=>output.imports.every(item=>!item.path.startsWith('node:'))));
console.log('PASS: injected-loader primary client bundles for browser without Node builtins or optional file providers');
const {privateAgentClient,AgentHttpError}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const origin='https://synthetic.invalid',principalId='A',credentialId='A-key',token='a'.repeat(43),I='I_'+'1'.repeat(64),W='W_'+'2'.repeat(64),C='C_'+'3'.repeat(64);
const options={origin,principalId,credentialId,environment:'production',loadCredential:async()=>({version:1,origin,principalId,credentialId,environment:'production',token})};
const requests=[];let corrupt='',prepared,identityDenied=false;
const issueSnapshot={id:I,projectId:'P',body:'saved'};
const originalFetch=globalThis.fetch;
globalThis.fetch=async(url,options)=>{
 const parsed=new URL(url),path=parsed.pathname,body=options.body&&JSON.parse(options.body);requests.push({path,method:options.method,body});
 assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');assert.equal(options.headers.Authorization,'Bearer '+token);
 if(path==='/api/auth/me')return identityDenied?Response.json({error:'unauthenticated'},{status:401}):Response.json({principal:{id:'A',kind:'agent'},authentication:'api',projects:[]});
 if(corrupt.startsWith('evidence-')){
  const error={error:'forbidden',operationId:'original',application:'unknown'};
  if(corrupt==='evidence-id')error.operationId='other';
  if(corrupt==='evidence-invalid-id')error.operationId='../other';
  if(corrupt==='evidence-applied')error.application='confirmed';
  if(corrupt==='evidence-not-applied')error.application='not_applied';
  if(corrupt==='evidence-missing-id')delete error.operationId;
  return Response.json(error,{status:403});
 }
 if(corrupt==='malformed')return new Response(token,{status:401});
 if(corrupt==='transport')throw new Error(token);
 if(corrupt==='reflection')return Response.json({nested:{reflected:token}});
 if(path==='/api/auth/browser-session/tickets'){identityDenied=corrupt==='handoff-revoked';return Response.json({ticket:'t'.repeat(43),principalId:'A',expiresAt:1});}
 if(path==='/api/agent/operations'&&options.method==='POST'){
  prepared={sequence:1,operationId:body.input.operationId,formatVersion:1,recorded:true,inputHash:'f'.repeat(64),route:body.route,input:body.input,target:{kind:'issue.create',targetId:I,projectId:'P'},requiredPermissions:['view','edit'],preparedAt:1,result:{status:'unknown'}};
  const ack={operation:structuredClone(prepared),requestHash:createHash('sha256').update(JSON.stringify(body)).digest('hex')};
  if(corrupt==='hash')ack.requestHash='f'.repeat(64);
  if(corrupt==='id')ack.operation.operationId='other';
  if(corrupt==='route')ack.operation.route={kind:'wiki',projectId:'P'};
  if(corrupt==='recorded')ack.operation.recorded=false;
  if(corrupt==='unknown')throw Error('lost prepare response');
  return Response.json(ack);
 }
 if(path.endsWith('/execute'))return Response.json({operationId:corrupt==='receipt-id'?'other':path.split('/')[4],snapshot:issueSnapshot,source:'committed'});
 if(path==='/api/agent/operations')return Response.json({operations:[],nextAfter:null});
 if(path.startsWith('/api/agent/operations/'))return Response.json(prepared);
 return Response.json({ok:true});
};
try{
const client=await privateAgentClient(options);assert.equal(requests.length,1);
for(const mutation of ['hash','id','route','recorded','unknown']){
 corrupt=mutation;const at=requests.length;await assert.rejects(client.api('/api/projects/P/issues','POST',{operationId:'original',body:'saved'}));assert.equal(requests.length-at,1);assert.equal(requests.at(-1).path,'/api/agent/operations');
}
corrupt='';const at=requests.length;const input={operationId:'original',body:'saved'},pending=client.api('/api/projects/P/issues','POST',input);input.operationId='changed';input.body='changed';const result=await pending;assert.equal(result.operationId,'original');assert.equal(prepared.input.body,'saved');assert.equal(requests.length-at,2);
await client.operations.list();await client.operations.get('original');await client.operations.execute('original');assert.equal(requests.filter(r=>r.path==='/api/auth/me').length,1);
corrupt='receipt-id';await assert.rejects(client.operations.execute('original'),/operation_response_mismatch/);
for(const [path,method] of [[`/api/projects/P/issues/${I}/execution/unknown`,'POST'],[`/api/projects/P/issues/${I}`,'POST'],['/api/projects/P/issues?x=1','POST'],[`/api/projects/P/issues/${I}/history`,'PATCH'],['/api/agent/operations?limit=51','GET'],['/api/agent/operations?after=0&after=1','GET'],['/api/agent/operations/original/execute','GET'],[`/api/workspaces/W/issues/${I}/execution/acquire`,'POST']]){const count=requests.length;await assert.rejects(client.api(path,method,{}),/client_route_rejected/);assert.equal(requests.length,count);}
console.log('PASS: primary-client transport capture, prepare fail-closed, original-ID execute, read-only recovery, exact mutation routes, no routine identity polling');
corrupt='';issueSnapshot.projectId='OTHER';await assert.rejects(client.api('/api/projects/P/issues','POST',{operationId:'original',body:'saved'}),/operation_response_mismatch/);issueSnapshot.projectId='P';console.log('PASS: automatic receipt target mismatch rejected');

corrupt='evidence-valid';
for(const action of [()=>client.operations.get('original'),()=>client.operations.execute('original'),()=>client.api('/api/projects/P/issue-operations/original'),()=>client.api('/api/projects/P/issues','POST',{operationId:'original',body:'saved'})]){
 const count=requests.length;await assert.rejects(action,e=>e instanceof AgentHttpError&&e.status===403&&e.operationId==='original'&&e.application==='unknown'&&!('mutationOutcome' in e));assert.equal(requests.length,count+1);
}
for(const value of ['id','invalid-id','applied','not-applied','missing-id']){corrupt='evidence-'+value;await assert.rejects(client.operations.get('original'),e=>e.code==='application_response_invalid'&&e.operationId===undefined&&e.application===undefined);}
corrupt='evidence-valid';await assert.rejects(client.api('/api/projects/P/issues'),e=>e.code==='application_response_invalid');
console.log('PASS: validated request-correlated operation ID and unknown application survive errors; mismatched or positive certainty is rejected without retry');

corrupt='reflection';await assert.rejects(client.api('/api/projects/P/issues'),e=>e.code==='credential_reflection_rejected'&&!JSON.stringify(e).includes(token));console.log('PASS: plain API rejects credential reflection with a fixed secret-free error');
for(const [mode,code]of [['malformed','application_response_invalid'],['transport','application_transport_unavailable']]){corrupt=mode;await assert.rejects(client.api('/api/projects/P/issues'),e=>e.code===code&&!String(e).includes(token)&&!JSON.stringify(e).includes(token));}
await assert.rejects(privateAgentClient({...options,loadCredential:async()=>{throw new Error(token);}}),e=>e.message==='application_credential_provider_unavailable'&&!String(e).includes(token));
console.log('PASS: malformed response, transport and provider errors never expose raw plain-API credentials');
corrupt='handoff-revoked';let received=false;await assert.rejects(client.handoff('n'.repeat(43),async()=>{received=true;}),e=>e.status===401);assert.equal(received,false);console.log('PASS: browser handoff rechecks current identity before delivering ticket');

corrupt='';identityDenied=false;
const beforeLegacy=requests.length;let legacyCredentialLoads=0;await assert.rejects(privateAgentClient({...options,loadCredential:async()=>{legacyCredentialLoads++;return options.loadCredential();},access:{mode:'service-auth'}}),/client_configuration_invalid/);assert.equal(requests.length,beforeLegacy);assert.equal(legacyCredentialLoads,0);
let transportCalls=0;await privateAgentClient({...options,transport:async(url,request)=>{transportCalls++;return globalThis.fetch(url,request);}});assert.equal(transportCalls,1);
let admissionCalls=0;const admission={async authorize(target){admissionCalls++;assert.deepEqual(target,{origin,environment:'production'});return {headers:{'X-Test-Admission':'private-admission-value'}};}};
const isolated=await privateAgentClient({...options,admission});admission.authorize=async()=>{throw new Error('mutated');};await isolated.identity();assert.equal(admissionCalls,2);
for(const headers of [{Authorization:'replace'},{cookie:'replace'},{Origin:'https://other.invalid'},{'X-Test':'bad\nheader'}]){const before=requests.length;await assert.rejects(privateAgentClient({...options,admission:{authorize:async()=>({headers})}}),/admission_credential_invalid/);assert.equal(requests.length,before);}
await assert.rejects(privateAgentClient({...options,admission:{authorize:async()=>{throw new Error(token);}}}),e=>e.message==='admission_provider_unavailable'&&!String(e).includes(token));
console.log('PASS: generic admission is origin-bound, cannot replace authority headers, captures its callback and sanitizes provider failures');

let provided={version:1,origin,principalId,credentialId,environment:'production',token},credentialLoads=0,rotationActive=false;
const seen=[];
const transport=async(url,request)=>{seen.push(request.headers.Authorization);if(rotationActive&&request.headers.Authorization==='Bearer '+token)return Response.json({error:'unauthenticated'},{status:401});return Response.json(new URL(url).pathname==='/api/auth/me'?{principal:{id:principalId,kind:'agent'},authentication:'api',projects:[]}:{ok:true});};
const loadCredential=async()=>{credentialLoads++;return provided;};
const oldClient=await privateAgentClient({...options,loadCredential,transport});provided.token='z'.repeat(43);await oldClient.api('/api/projects/P/issues');assert.equal(credentialLoads,1);assert.deepEqual(seen,['Bearer '+token,'Bearer '+token]);
provided={...provided,credentialId:'B-key',token:'b'.repeat(43)};rotationActive=true;
const renewed=await privateAgentClient({...options,credentialId:'B-key',loadCredential,transport});await assert.rejects(oldClient.api('/api/projects/P/issues'),e=>e.status===401);assert.equal(credentialLoads,2);assert.equal((await renewed.api('/api/projects/P/issues')).ok,true);assert.equal(seen.at(-1),'Bearer '+'b'.repeat(43));
console.log('PASS: existing client keeps its immutable credential binding; explicit new client loads rotation without implicit refresh or a VM/file dependency');
}finally{globalThis.fetch=originalFetch;}
