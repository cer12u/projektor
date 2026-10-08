import {test} from 'node:test';
import assert from 'node:assert/strict';
import {route,queryArgs,body} from '../service/http.mjs';
const workspace='10000000-0000-4000-8000-000000000001',issue='10000000-0000-4000-8000-000000000002',revision='10000000-0000-4000-8000-000000000003';
const config={origin:'https://projektor.test',workspaces:[workspace]};
const request=(path,init)=>new Request(`${config.origin}/v1/workspaces/${workspace}/${path}`,init);
test('content routes bind project, parent issue, and revision IDs with identical human/machine shapes',()=>{
 for(const [path,action,entityId,revisionId] of [[`projects`,'projects'],[`projects/${issue}`,'projects',issue],[`issues/${issue}/entries`,'entries',issue],[`issues/${issue}/revisions`,'revisions',issue],[`issues/${issue}/revisions/${revision}`,'revisions',issue,revision]]){
  const r=route(request(`${path}?workspaceEpoch=${workspace}`),config);assert.equal(r.action,action);assert.equal(r.entityId,entityId);assert.equal(r.revisionId,revisionId);
  assert.deepEqual(queryArgs(r),{workspaceId:workspace,workspaceEpoch:workspace,...(entityId?{entityId}:{}),...(revisionId?{revisionId}:{})});
  const machine=route(new Request(`${config.origin}/machine${new URL(request(path).url).pathname}?workspaceEpoch=${workspace}`),config);assert.equal(machine.action,action);assert.equal(machine.kind,'machine');
 }
});
test('read routes reject duplicate/unknown parameters, missing epochs and invented nested resources',()=>{
 for(const suffix of ['','?workspaceEpoch='+workspace+'&workspaceEpoch='+workspace,'?workspaceEpoch='+workspace+'&actorId='+issue,'?workspaceEpoch='+workspace+'&revisionId='+revision])assert.throws(()=>queryArgs(route(request(`issues/${issue}/entries${suffix}`),config)),{code:'VALIDATION'});
 for(const path of [`projects/${issue}/entries`,`operations/${issue}/revisions`,`issues/${issue}/entries/${revision}`,`issues/${issue}/revisions/${revision}/extra`])assert.throws(()=>route(request(path),config),{code:'NOT_FOUND'});
 assert.throws(()=>route(request(`issues/${issue}/entries`,{method:'POST'}),config),{code:'METHOD_NOT_ALLOWED'});
});
test('bounded body accepts full escaped Markdown source verbatim and retains legacy title byte cap',async()=>{
 const description='\u0000'.repeat(256*1024);const content={commandType:'Issue.UpdateBody',payload:{description}};
 assert.deepEqual(await body(request('commands',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(content)}),1000),content);
 await assert.rejects(body(request('commands',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({commandType:'Issue.UpdateTitle',payload:{title:'a'.repeat(17000)}})}),1000),{code:'BODY_TOO_LARGE'});
 await assert.rejects(body(request('commands',{method:'POST',headers:{'content-type':'application/json'},body:' '.repeat(2*1024*1024+1)}),1000),{code:'BODY_TOO_LARGE'});
});
