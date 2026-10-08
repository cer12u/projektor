// UI contract fixtures only. Core owner's separate SQLite/workerd tests prove
// server effects; this test confirms the view's flat field contract.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HumanWorkflowController} from '../vendor/session-ports/human-workflow.mjs';
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
function controller(t){
  const c=new HumanWorkflowController({api:{session:async()=>{},transport:{}},issueId:id(1),protection:{restore(){},persist(){},unlock(){},lock(){}}});
  c.issue={id:id(1),title:'saved title',status:'ready',version:7};
  c.session={principalId:id(2),workspaceId:id(3),workspaceEpoch:id(4),actorKind:'human',expiresAt:Date.now()+60000};
  c.locked=false;c.record={revision:0,drafts:{},active:'',journal:null};c.dispatch=async()=>structuredClone(c.record.journal.command);t.after(()=>c.dispose());return c;
}
test('flat title/progress/transition fields feed the one protected core journal',async t=>{
  const c=controller(t);
  c.select('title');c.edit({title:'New title'});const title=await c.save();assert.equal(title.commandType,'Issue.UpdateTitle');assert.deepEqual(title.payload,{title:'New title'});
  c.record.journal.state='committed';c.select('progress');c.edit({bodyMarkdown:'日本語\r\nprogress'});const progress=await c.save();assert.equal(progress.commandType,'Issue.AppendProgress');assert.equal(progress.payload.bodyMarkdown,'日本語\r\nprogress');assert.equal(progress.payload.claim,undefined);
  c.record.journal.state='committed';c.select('transition');c.edit({toStatus:'blocked',reason:'blocked reason',waitingFor:'dependency',nextStep:'follow up',resultSummary:''});
  const transition=await c.save();assert.equal(transition.commandType,'Issue.Transition');assert.deepEqual(transition.payload.reason,{text:'blocked reason'});assert.equal(transition.payload.waitingFor,'dependency');
  assert.equal(transition.expectedVersion,7);assert.equal(transition.payload.payloadVersion,2);assert.equal(transition.payload.claim,undefined);
});
test('pending journal cannot become a second operation from another UI mode',async t=>{
  const c=controller(t);c.select('progress');c.edit({bodyMarkdown:'first'});const first=await c.save();c.select('transition');c.edit({toStatus:'done',resultSummary:'result'});
  assert.equal((await c.save()).kind,'pending');assert.equal(c.record.journal.command.operationId,first.operationId);
});
test('machine session cannot use the human form to bypass a claim',async t=>{
  const c=controller(t);c.session.actorKind='machine';c.select('progress');c.edit({bodyMarkdown:'not allowed'});assert.equal((await c.save()).kind,'stopped');assert.equal(c.record.journal,null);
});

test('imported same-category review selection carries its identity and preserves rejected input',async t=>{
  const c=controller(t),review='a'.repeat(32),active=id(21);
  c.issue.status='in_progress';c.issue.compatibility={statusId:review,statuses:[{id:review,toStatus:'in_progress'},{id:active,toStatus:'in_progress'}]};
  c.select('transition');assert.equal(c.record.drafts.transition.value.statusId,review);
  c.edit({statusId:active,toStatus:'in_progress',reason:'Retain explicit exit from review'});
  const command=await c.save();assert.equal(command.payload.statusId,active);assert.equal(command.payload.toStatus,'in_progress');assert.equal(command.expectedVersion,7);
  c.record.journal.state='rejected';c.edit({toStatus:'done'});
  assert.equal((await c.save()).code,'VALIDATION');assert.equal(c.record.drafts.transition.value.reason,'Retain explicit exit from review');assert.equal(c.record.journal.command.operationId,command.operationId);
});
test('dirty pre-import transition requires an explicit compatibility choice without erasing text',t=>{
  const c=controller(t);c.select('transition');c.edit({toStatus:'in_progress',reason:'Protected earlier input'});
  const review='b'.repeat(32);c.issue.compatibility={statusId:review,statuses:[{id:review,toStatus:'in_progress'}]};c.issue.status='in_progress';
  c.adoptCurrent();assert.equal(c.record.drafts.transition.value.reason,'Protected earlier input');assert.equal(c.record.drafts.transition.value.statusId,null);assert.equal(c.validateDraft(c.record.drafts.transition),'VALIDATION');
  c.edit({statusId:review,toStatus:'in_progress'});assert.equal(c.validateDraft(c.record.drafts.transition),null);
});

function noChangeReceipt(c,command){return {kind:'committed',body:{meta:{workspaceId:c.session.workspaceId,actorId:c.session.principalId,operationId:command.operationId},data:{entityId:c.issueId,outcome:'committed',effectApplied:false,committedVersion:command.expectedVersion,commitSeq:1}}};}
for(const compatibility of [false,true])test(compatibility?'false no-op cannot acknowledge a different same-category imported status':'false no-op cannot acknowledge a different canonical status',async t=>{
  const c=controller(t),active='a'.repeat(32),review='b'.repeat(32);
  if(compatibility){c.issue.status='in_progress';c.issue.compatibility={statusId:active,statuses:[{id:active,toStatus:'in_progress'},{id:review,toStatus:'in_progress'}]};}
  c.select('transition');c.edit({toStatus:'in_progress',...(compatibility?{statusId:review}:{}),reason:'Keep the requested transition'});
  const command=await c.save(),baseline=structuredClone(c.record.journal.transitionBaseline),sent=structuredClone(c.record.drafts.transition.value);
  assert.equal(baseline.version,7);assert.equal(baseline.status,compatibility?'in_progress':'ready');assert.equal(baseline.statusId,compatibility?active:null);
  c.record=structuredClone(c.record); // Protected journal serialization/restoration.
  // A later current projection matching the request cannot bless an old receipt.
  c.issue.status='in_progress';if(compatibility)c.issue.compatibility.statusId=review;
  const result=c.apply(noChangeReceipt(c,command));assert.equal(result.kind,'ambiguous');assert.equal(result.code,'RECEIPT_BINDING_MISMATCH');assert.equal(c.record.journal.state,'unknown');assert.equal(c.record.drafts.transition.ack,0);
  c.adoptCurrent();assert.deepEqual(c.record.drafts.transition.value,sent);
  c.edit({reason:'Late protected text'});assert.equal(c.apply(noChangeReceipt(c,command)).kind,'ambiguous');c.adoptCurrent();assert.equal(c.record.drafts.transition.value.reason,'Late protected text');assert.deepEqual(c.record.journal.transitionBaseline,baseline);
});
test('genuine no-op receipts bind to the persisted baseline; legacy journals remain ambiguous',async t=>{
  for(const compatibility of [false,true]){
    const c=controller(t),review='a'.repeat(32);
    if(compatibility){c.issue.status='in_progress';c.issue.compatibility={statusId:review,statuses:[{id:review,toStatus:'in_progress'}]};}
    c.select('transition');c.edit({reason:'Sent no-op input'});const command=await c.save(),baseline=structuredClone(c.record.journal.transitionBaseline);
    c.record=structuredClone(c.record);delete c.record.journal.transitionBaseline;
    assert.equal(c.apply(noChangeReceipt(c,command)).kind,'ambiguous');assert.equal(c.record.drafts.transition.ack,0);
    c.record.journal.transitionBaseline=baseline;
    const wrongVersion=noChangeReceipt(c,command);wrongVersion.body.data.committedVersion++;assert.equal(c.apply(wrongVersion).kind,'ambiguous');
    c.edit({reason:'Newer unsent input'});c.issue.version++;c.issue.status='blocked';
    assert.equal(c.apply(noChangeReceipt(c,command)).kind,'committed');assert.equal(c.record.journal.effectApplied,false);c.adoptCurrent();assert.equal(c.record.drafts.transition.value.reason,'Newer unsent input');assert.ok(c.record.drafts.transition.revision>c.record.drafts.transition.ack);
  }
});
