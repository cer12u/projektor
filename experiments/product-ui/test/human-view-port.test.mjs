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
