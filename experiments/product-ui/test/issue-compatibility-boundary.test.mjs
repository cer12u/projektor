// Focused NodeSQLite/controller integration, not browser evidence. The same
// imported IDs and saved fields cross the real command/query boundary.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {migrate,executeCommand,queryIssues,queryIssueEntries,operationGet} from '../../atomic-command-poc/src/core.mjs';
import {importIssueCompatibility} from '../../atomic-command-poc/src/issue-compat.mjs';
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
 const args={workspaceId:workspace,workspaceEpoch:epoch,entityId:issueId};const bind=r=>({...r,meta:{...r.meta,workspaceId:workspace,workspaceEpoch:epoch,actorId:principalId}});const classify=r=>r.data?{kind:'committed',body:r}:{kind:'rejected',body:r,code:r.error.code};let persisted;
 const api={session:async()=>session,issue:async()=>bind(queryIssues(db,actor,args,now)),entries:async()=>bind(queryIssueEntries(db,actor,args,now)),transport:{submit:async({command})=>classify(execute(command)),readReceipt:async({command})=>classify(operationGet(db,actor,{...args,operationId:command.operationId},now))}};
 const protection={lock(){},unlock:async()=>{},restore:async()=>persisted,persist:async r=>{persisted=structuredClone(r);},expiresAt:()=>session.expiresAt};
 const c=new HumanWorkflowController({api,protection,issueId,now:()=>now});t.after(()=>c.dispose());assert.equal((await c.revalidate()).kind,'ready');
 const imported=structuredClone(c.issue.compatibility);assert.equal(imported.dor.evidenceState,'current');
 c.edit({description:'Native body edit'});assert.equal((await c.save()).kind,'committed');assert.equal(c.issue.compatibility.dor.evidenceState,'stale_after_edit');assert.deepEqual({...c.issue.compatibility,dor:imported.dor},imported);
 const afterBody=c.issue.version;c.select('transition');c.edit({statusId:statuses[1].id,toStatus:'in_progress',reason:'Retain review exit'});assert.equal((await c.save()).kind,'committed');assert.equal(c.issue.status,'in_progress');assert.equal(c.issue.version,afterBody+1);assert.equal(c.issue.compatibility.statusId,statuses[1].id);
 c.edit({statusId:statuses[0].id,toStatus:'in_progress'});assert.equal((await c.save()).kind,'committed');assert.equal(c.issue.compatibility.isReviewStep,true);assert.equal(c.issue.version,afterBody+2);
 c.edit({statusId:statuses[2].id,toStatus:'done',reason:'Protected explanation'});const rejected=await c.save();assert.equal(rejected.kind,'rejected');assert.equal(rejected.code,'RESULT_REQUIRED');assert.equal(c.record.drafts.transition.value.reason,'Protected explanation');assert.equal(c.record.drafts.transition.value.statusId,statuses[2].id);assert.equal(persisted.drafts.transition.value.reason,'Protected explanation');
 c.edit({statusId:statuses[1].id,toStatus:'in_progress'});assert.equal(execute(command('Issue.UpdateTitle',{title:'Concurrent synthetic title'},c.issue.version)).data?.outcome,'committed');
 const conflict=await c.save();assert.equal(conflict.kind,'rejected');assert.equal(conflict.code,'VERSION_CONFLICT');assert.equal(c.record.drafts.transition.value.statusId,statuses[1].id);assert.equal(c.record.drafts.transition.value.reason,'Protected explanation');
 assert.equal(c.useCurrentVersion().kind,'rebased');assert.equal((await c.save()).kind,'committed');assert.equal(c.issue.title,'Concurrent synthetic title');assert.equal(c.issue.compatibility.statusId,statuses[1].id);assert.equal(c.issue.compatibility.typeName,'Synthetic type');assert.equal(c.issue.compatibility.completionReportAt,now);assert.equal(c.issue.compatibility.dor.ready,false);assert.equal(c.issue.compatibility.dor.missingRaw,'["Synthetic evidence"]');
});
