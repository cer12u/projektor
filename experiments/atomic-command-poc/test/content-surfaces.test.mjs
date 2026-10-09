import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,ids,actor,now,command,restRequest} from './fixture.mjs';
import {restCommand,mcpCommand,restProjects,mcpProjects,restIssues,mcpIssues,restIssueEntries,mcpIssueEntries,restContentRevisions,mcpContentRevisions,restOperationGet,mcpOperationGet} from '../src/adapters.mjs';
function setup(){const f=fixture();f.db.prepare('INSERT INTO project VALUES(?,?,1,0)').run(ids.project,'Fixture project');for(const scope of ['operations:read_own','issue:read','issue:write','comment:write','history:read']){f.db.prepare('INSERT INTO principal_scope VALUES(?,?)').run(ids.actor,scope);f.db.prepare('INSERT INTO credential_scope VALUES(?,?)').run(ids.credential,scope);}return f;}
const query=entityId=>({workspaceId:ids.workspace,workspaceEpoch:ids.epoch,...(entityId?{entityId}:{})});
const description='---\r\ntitle: 日本語\r\n---\r\n# Heading\n未知記法 <% keep %>\n  two spaces  \n😀e\u0301\n';
test('REST/MCP use one receipt and identical current, entries and immutable history values',()=>{
 const f=setup();try{
  const issueId=randomUUID(),commentId=randomUUID();let version=0;
  for(const [name,type,entityId,payload,expectedVersion] of [
   ['issue_create','Issue.Create',issueId,{projectId:ids.project,title:'Exact content',description,assigneeId:ids.actor,priority:'P1',parentId:null,initialStatus:'ready'},0],
   ['issue_update_body','Issue.UpdateBody',issueId,{description:description+'body v2\n'},1],
   ['issue_assign','Issue.Assign',issueId,{assigneeId:null},2],
   ['issue_set_priority','Issue.SetPriority',issueId,{priority:null},3],
   ['issue_add_comment','Issue.AddComment',issueId,{commentId,bodyMarkdown:description},4],
   ['issue_edit_comment','Issue.EditComment',commentId,{commentId,expectedCommentVersion:1,bodyMarkdown:description+'edited'},1],
  ]){
   const c=command({commandType:type,entityId,expectedVersion,payload});
   const rest=restCommand(f.db,actor,restRequest(c),{now});assert.equal(rest.status,200,JSON.stringify(rest));
   const mcp=mcpCommand(f.db,actor,{name,arguments:c},{now});assert.deepEqual(mcp.structuredContent,rest.body);assert.equal(mcp.isError,false);
   const receiptArgs={...query(),operationId:c.operationId};assert.deepEqual(restOperationGet(f.db,actor,receiptArgs,now).body,rest.body);assert.deepEqual(mcpOperationGet(f.db,actor,receiptArgs,now).structuredContent,rest.body);
  }
  for(const [rest,mcp,name,args] of [[restProjects,mcpProjects,'project_list',query()],[restProjects,mcpProjects,'project_get',query(ids.project)],[restIssues,mcpIssues,'issue_get',query(issueId)],[restIssueEntries,mcpIssueEntries,'issue_entries_list',query(issueId)],[restContentRevisions,mcpContentRevisions,'content_revision_list',query(issueId)]]){assert.deepEqual(rest(f.db,actor,args,now).body,mcp(f.db,actor,{name,arguments:args},now).structuredContent);}
  const detail=restIssues(f.db,actor,query(issueId),now).body.data;assert.equal(detail.description,description+'body v2\n');assert.equal(detail.version,5);assert.equal(detail.priority,null);assert.equal(detail.assigneeId,null);
  const entries=restIssueEntries(f.db,actor,query(issueId),now).body.data.items;assert.equal(entries[0].bodyMarkdown,description+'edited');assert.equal(entries[0].version,2);assert.equal(entries[0].authorRef.principalId,ids.actor);
  const history=restContentRevisions(f.db,actor,query(issueId),now).body.data.items;assert.equal(history.length,4);assert(history.some(r=>r.contentMarkdown===description));
  for(const revision of history){const args={...query(issueId),revisionId:revision.id};assert.deepEqual(restContentRevisions(f.db,actor,args,now).body,mcpContentRevisions(f.db,actor,{name:'content_revision_get',arguments:args},now).structuredContent);}
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM operation').get().n,6);assert.equal(f.db.prepare('SELECT count(*) AS n FROM content_revision').get().n,4);
 }finally{f.close();}
});
test('MCP name/envelope mismatch and unknown names have no effects',()=>{
 const f=setup();try{const c=command();for(const name of ['issue_create','issue_update_body','constructor','__proto__','unknown'])assert.equal(mcpCommand(f.db,actor,{name,arguments:c},{now}).structuredContent.error.code,'VALIDATION');assert.equal(f.db.prepare('SELECT count(*) AS n FROM operation').get().n,0);}finally{f.close();}
});
