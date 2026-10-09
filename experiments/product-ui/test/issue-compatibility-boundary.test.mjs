// Focused NodeSQLite/controller integration, not browser evidence. The same
// imported IDs and saved fields cross the real command/query boundary and the
// same Request/Response transport classifier as product ports. No custom classifier.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {migrate,executeCommand,queryIssues,queryIssueEntries,operationGet} from '../../atomic-command-poc/src/core.mjs';
import {importIssueCompatibility} from '../../atomic-command-poc/src/issue-compat.mjs';
import {createContentAPI} from '../vendor/client/issue-content.mjs';
import {resultResponse} from '../../atomic-command-poc/service/http.mjs';
import {HumanWorkflowController} from '../vendor/session-ports/human-workflow.mjs';
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const now=1800000000000;
const statuses=[{id:'A'.repeat(32),key:'review',name:'Synthetic review',toStatus:'in_progress',isReviewStep:true,position:0},{id:id(10),key:'active',name:'Synthetic active',toStatus:'in_progress',isReviewStep:false,position:1},{id:'b'.repeat(32),key:'done',name:'Synthetic done',toStatus:'done',isReviewStep:false,position:2}];
test('real imported state crosses protected human draft, body edit, review transition, rejection and CAS',{timeout:10000},async t=>{
 const db=new DatabaseSync(':memory:');migrate(db);t.after(()=>db.close());
 const workspace=id(1),epoch=id(2),principalId=id(3),credentialId=id(4),project=id(5),issueId=id(6),scopes=['issue:read','issue:write','comment:write','history:read','progress:write','issue:transition','operations:read_own'];
 db.prepare('INSERT INTO workspace VALUES(?,?,1,0)').run(workspace,epoch);db.prepare("INSERT INTO membership VALUES(?,'human',0,1)").run(principalId);db.prepare('INSERT INTO credential VALUES(?,?,?,0,1,1)').run(credentialId,principalId,now+3600000);db.prepare('INSERT INTO project VALUES(?,?,1,0)').run(project,'Synthetic project');db.prepare('INSERT INTO project_grant VALUES(?,?,1,1)').run(principalId,project);
 for(const scope of scopes){db.prepare('INSERT INTO principal_scope VALUES(?,?)').run(principalId,scope);db.prepare('INSERT INTO credential_scope VALUES(?,?)').run(credentialId,scope);}
 const actor={principalId,actorKind:'human',credentialId,workspaceId:workspace,authMethod:'synthetic-fixture-only',credentialExpiresAt:now+3600000,authenticatedAt:now};
 const command=(commandType,payload,expectedVersion)=>({schemaVersion:1,workspaceId:workspace,workspaceEpoch:epoch,operationId:randomUUID(),commandType,entityId:issueId,expectedVersion,payload});
 const execute=c=>executeCommand(db,actor,c,{now});
 assert.equal(execute(command('Issue.Create',{projectId:project,title:'Synthetic imported issue',description:'Synthetic imported body',assigneeId:principalId,priority:null,parentId:null,initialStatus:'ready'},0)).data?.outcome,'committed');
 assert.equal(execute(command('Issue.Transition',{payloadVersion:2,entryId:randomUUID(),toStatus:'in_progress'},1)).data?.outcome,'committed');
 const revision=db.prepare('SELECT body_revision_id FROM issue_content WHERE issue_id=?').get(issueId).body_revision_id;
 importIssueCompatibility(db,{statuses,issues:[{issueId,statusId:statuses[0].id,typeId:'c'.repeat(32),typeName:'Synthetic type',completionReportAt:now,dorReady:false,dorMissingRaw:'["Synthetic evidence"]',dorRevisionId:revision}]});
 const session={...actor,workspaceEpoch:epoch,sessionId:credentialId,authzVersion:1,expiresAt:now+3600000,scopes};
 const args={workspaceId:workspace,workspaceEpoch:epoch,entityId:issueId};const bind=r=>({...r,meta:{...r.meta,workspaceId:workspace,workspaceEpoch:epoch,actorId:principalId}});let persisted,unknownReply=false;
 const api=createContentAPI({baseUrl:'https://synthetic.invalid',fetchImpl:async(url,init)=>{
   const request=new Request(url,init),path=new URL(request.url).pathname;
   if(path==='/v1/session')return Response.json(session);
   if(path.endsWith('/commands')){
     assert.equal(request.method,'POST');const sent=await request.json();assert.equal(request.headers.get('idempotency-key'),sent.operationId);assert.equal(request.headers.get('x-projektor-csrf'),'same-origin');
     return resultResponse(unknownReply?{error:{code:'FUTURE_TRANSITION_REJECTION',outcome:'rejected',effectApplied:false}}:execute(sent),'human');
   }
   if(path.includes('/operations/'))return resultResponse(unknownReply?{error:{code:'FUTURE_TRANSITION_REJECTION',outcome:'rejected',effectApplied:false}}:operationGet(db,actor,{...args,operationId:path.split('/').at(-1)},now),'human');
   if(path.endsWith('/entries'))return resultResponse(bind(queryIssueEntries(db,actor,args,now)),'human');
   if(path.endsWith('/issues/'+issueId))return resultResponse(bind(queryIssues(db,actor,args,now)),'human');
   throw Error('Unexpected synthetic request path');
 }});

 const protection={lock(){},unlock:async()=>{},restore:async()=>persisted,persist:async r=>{persisted=structuredClone(r);},expiresAt:()=>session.expiresAt};
 const c=new HumanWorkflowController({api,protection,issueId,now:()=>now});t.after(()=>c.dispose());assert.equal((await c.revalidate()).kind,'ready');
 const imported=structuredClone(c.issue.compatibility);assert.equal(imported.dor.evidenceState,'current');
 c.edit({description:'Native body edit'});assert.equal((await c.save()).kind,'committed');assert.equal(c.issue.compatibility.dor.evidenceState,'stale_after_edit');assert.deepEqual({...c.issue.compatibility,dor:imported.dor},imported);
 const afterBody=c.issue.version;c.select('transition');c.edit({statusId:statuses[1].id,toStatus:'in_progress',reason:'Retain review exit'});assert.equal((await c.save()).kind,'committed');assert.equal(c.issue.status,'in_progress');assert.equal(c.issue.version,afterBody+1);assert.equal(c.issue.compatibility.statusId,statuses[1].id);
 c.edit({statusId:statuses[0].id,toStatus:'in_progress'});assert.equal((await c.save()).kind,'committed');assert.equal(c.issue.compatibility.isReviewStep,true);assert.equal(c.issue.version,afterBody+2);
 c.edit({statusId:statuses[2].id,toStatus:'done',reason:'Protected explanation'});const rejected=await c.save();assert.equal(rejected.kind,'rejected');assert.equal(rejected.code,'RESULT_REQUIRED');assert.equal(c.record.drafts.transition.value.reason,'Protected explanation');assert.equal(c.record.drafts.transition.value.statusId,statuses[2].id);assert.equal(persisted.drafts.transition.value.reason,'Protected explanation');
 const receipt=await api.transport.readReceipt({command:c.record.journal.command,session});assert.equal(receipt.kind,'rejected');assert.equal(receipt.code,'RESULT_REQUIRED');
 c.edit({statusId:statuses[1].id,toStatus:'in_progress'});assert.equal(execute(command('Issue.UpdateTitle',{title:'Concurrent synthetic title'},c.issue.version)).data?.outcome,'committed');
 const conflict=await c.save();assert.equal(conflict.kind,'rejected');assert.equal(conflict.code,'VERSION_CONFLICT');assert.equal(c.record.drafts.transition.value.statusId,statuses[1].id);assert.equal(c.record.drafts.transition.value.reason,'Protected explanation');
 assert.equal(c.useCurrentVersion().kind,'rebased');assert.equal((await c.save()).kind,'committed');assert.equal(c.issue.title,'Concurrent synthetic title');assert.equal(c.issue.compatibility.statusId,statuses[1].id);assert.equal(c.issue.compatibility.typeName,'Synthetic type');assert.equal(c.issue.compatibility.completionReportAt,now);assert.equal(c.issue.compatibility.dor.ready,false);assert.equal(c.issue.compatibility.dor.missingRaw,'["Synthetic evidence"]');
 unknownReply=true;c.edit({statusId:statuses[0].id,toStatus:'in_progress',reason:'Keep future rejection input'});const priorAck=c.record.drafts.transition.ack;const unknown=await c.save();assert.equal(unknown.kind,'ambiguous');assert.equal(unknown.code,'PROTOCOL_ERROR');assert.equal(c.record.journal.state,'unknown');assert.equal(c.record.drafts.transition.ack,priorAck);assert.equal(c.record.drafts.transition.value.reason,'Keep future rejection input');assert.equal(persisted.drafts.transition.value.reason,'Keep future rejection input');const unknownReceipt=await c.checkResult();assert.equal(unknownReceipt.kind,'ambiguous');assert.equal(c.record.journal.state,'unknown');assert.equal(c.record.drafts.transition.value.reason,'Keep future rejection input');
});

// Keep this list aligned with the concrete Issue.Transition deny paths, rather
// than treating every service error string as a conclusive rejection.
const transitionRejections=['ACTOR_KIND_MISMATCH','WORKFLOW_STATE_UNAVAILABLE','CLAIM_STALE','ARTIFACT_CAPTURE_UNAVAILABLE','COMPATIBILITY_UNAVAILABLE','COMPAT_STATE_MISMATCH','COMPAT_STATUS_MISMATCH','COMPAT_STATUS_REQUIRED','REOPEN_REQUIRED','REASON_REQUIRED','BLOCKED_EVIDENCE_REQUIRED','EXTERNAL_OUTCOME_UNKNOWN','RESULT_REQUIRED','UNRESOLVED_CHILDREN','ENTRY_EXISTS'];
test('transition HTTP classification is bounded to known codes, command lane and definitive envelopes',async()=>{
  const command={schemaVersion:1,workspaceId:id(1),workspaceEpoch:id(2),operationId:id(7),commandType:'Issue.Transition',entityId:id(6),expectedVersion:2,payload:{payloadVersion:2,entryId:id(8),toStatus:'done'}},session={actorKind:'human'};
  let reply={error:{code:'RESULT_REQUIRED',outcome:'rejected',effectApplied:false}},status=400,headers={};
  const {transport}=createContentAPI({baseUrl:'https://synthetic.invalid',fetchImpl:async()=>Response.json(reply,{status,headers})});
  for(const code of transitionRejections){reply={error:{code,outcome:'rejected',effectApplied:false}};for(const method of ['submit','readReceipt']){const result=await transport[method]({command,session});assert.equal(result.kind,'rejected',code);assert.equal(result.code,code);}}
  for(const error of [{code:'RESULT_REQUIRED',outcome:'unknown',effectApplied:false},{code:'RESULT_REQUIRED',outcome:'rejected'},{code:'RESULT_REQUIRED',outcome:'rejected',effectApplied:true}]){reply={error};const result=await transport.submit({command,session});assert.equal(result.kind,'blocked');assert.equal(result.outcome,'unknown');}
  for(const code of ['FUTURE_TRANSITION_REJECTION','CAPABILITY_MISMATCH']){reply={error:{code,outcome:'rejected',effectApplied:false}};assert.equal((await transport.submit({command,session})).kind,'ambiguous');}
  reply={error:{code:'RESULT_REQUIRED',outcome:'rejected',effectApplied:false}};
  assert.equal((await transport.submit({command:{...command,commandType:'Issue.UpdateTitle'},session})).kind,'ambiguous');
  assert.equal((await transport.readResource({command,session})).kind,'ambiguous');
  status=401;assert.equal((await transport.submit({command,session})).kind,'auth-required');status=403;assert.equal((await transport.submit({command,session})).kind,'forbidden');
  status=500;assert.equal((await transport.submit({command,session})).kind,'ambiguous');status=429;headers={'Retry-After':'1'};const limited=await transport.submit({command,session});assert.equal(limited.kind,'ambiguous');assert.equal(limited.retryAfterMs,1000);
});
