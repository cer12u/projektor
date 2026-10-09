import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SessionCoordinator,OperationCoordinator,createFetchTransport} from '../client/recovery.mjs';
const identity={principalId:'actor',workspaceId:'workspace',workspaceEpoch:'epoch',actorKind:'human',scopes:['operations:read_own','issue:read','issue:write','comment:write'],expiresAt:Date.now()+60000};
const command=(type='Issue.UpdateBody')=>({schemaVersion:1,workspaceId:'workspace',workspaceEpoch:'epoch',operationId:'operation',commandType:type,entityId:type==='Issue.EditComment'?'comment':'issue',expectedVersion:7,payload:type==='Issue.EditComment'?{commentId:'comment',expectedCommentVersion:7,bodyMarkdown:'body'}:{description:'body'}});
const committed=(c,changes={})=>({kind:'committed',body:{data:{outcome:'committed',entityId:c.entityId,effectApplied:false,committedVersion:c.expectedVersion,commitSeq:0,...changes},meta:{actorId:'actor',workspaceId:'workspace',operationId:c.operationId}}});
function fixture(c,transport,options={}){const session=new SessionCoordinator({initialSession:identity});return new OperationCoordinator({session,transport,initialDraft:c.payload,resourceProjectId:'project',retryDelaysMs:[0,0,0],...options});}
test('definitive content no-op acknowledges exact snapshot, but legacy title and malformed no-op remain unknown',async()=>{
 for(const type of ['Issue.UpdateBody','Issue.Assign','Issue.SetPriority','Issue.EditComment']){const c=command(type),op=fixture(c,{submit:async()=>committed(c)});assert.equal((await op.submit(c)).kind,'committed');assert.equal(op.snapshot().operation.state,'committed');op.dispose();}
 for(const [type,changes] of [['Issue.UpdateTitle',{}],['Issue.Create',{}],['Issue.AddComment',{}],['Issue.UpdateBody',{committedVersion:8}],['Issue.UpdateBody',{commitSeq:-1}]]){const c=command(type),op=fixture(c,{submit:async()=>committed(c,changes)});assert.equal((await op.submit(c)).code,'RECEIPT_BINDING_MISMATCH');op.dispose();}
});
test('EditComment recovery rereads explicit parent issue without changing operation envelope',async()=>{
 const c=command('Issue.EditComment'),calls=[];
 const op=fixture(c,{submit:async()=>({kind:'ambiguous',code:'NETWORK_ERROR'}),readReceipt:async({command})=>{calls.push(command);return committed(command,{effectApplied:true,committedVersion:8,commitSeq:12});},readResource:async({command})=>{assert.equal(command.entityId,'issue');return {kind:'resource',body:{data:{id:'issue',project_id:'project',version:20}}};}},{resourceEntityId:'issue'});
 await op.submit(c);assert.equal((await op.recover()).kind,'committed');assert.equal(calls.length,1);assert.deepEqual(calls[0],c);assert.equal(op.snapshot().operation.outcome.body.data.entityId,'comment');op.dispose();
});
test('content rejections settle only with definitive zero-effect receipt evidence',async()=>{
 for(const code of ['BODY_TOO_LARGE','CONTENT_EMPTY','ASSIGNEE_INVALID','PARENT_INVALID','ENTITY_EXISTS','COMMENT_EXISTS','PROJECT_NOT_FOUND'])for(const definitive of [true,false]){
  const transport=createFetchTransport({baseUrl:'https://example.test',fetchImpl:async()=>Response.json({error:{code,outcome:definitive?'rejected':'unknown',...(definitive?{effectApplied:false}:{})}},{status:400})});
  assert.equal((await transport.submit({command:command(),session:identity})).kind,definitive?'rejected':'blocked');
 }
});
