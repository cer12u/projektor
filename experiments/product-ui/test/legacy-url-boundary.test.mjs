// Actual product adapter -> HTTP query/envelope -> NodeSQLite resolver. This is
// not provider/WorkspaceService/workerd or deployed SPA fallback evidence.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {migrate,executeCommand,queryProjects} from '../../atomic-command-poc/src/core.mjs';
import {importProjectUrls,queryLegacyUrl} from '../../atomic-command-poc/src/legacy-url.mjs';
import {route,queryArgs,resultResponse} from '../../atomic-command-poc/service/http.mjs';
import {createProductPorts} from '../src/product-ports.ts';
import {checkBootstrap,chooseWorkspace} from '../src/contracts.ts';
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');

test('fresh selected session precedes real resolver reads; native targets, project metadata and denies cross exact service envelopes',async t=>{
  const db=new DatabaseSync(':memory:');migrate(db);t.after(()=>db.close());const now=Date.now(),workspace=id(1),epoch=id(2),actorId=id(3),credentialId=id(4),project=id(5),issueId=id(6),pageId=id(7);
  const scopes=['issue:read','issue:write','wiki:read','wiki:write','operations:read_own'];
  db.prepare('INSERT INTO workspace VALUES(?,?,1,0)').run(workspace,epoch);db.prepare("INSERT INTO membership VALUES(?,'human',0,1)").run(actorId);db.prepare('INSERT INTO credential VALUES(?,?,?,0,1,1)').run(credentialId,actorId,now+60000);db.prepare('INSERT INTO project VALUES(?,?,1,0)').run(project,'Synthetic project');db.prepare('INSERT INTO project_grant VALUES(?,?,1,1)').run(actorId,project);
  for(const scope of scopes){db.prepare('INSERT INTO principal_scope VALUES(?,?)').run(actorId,scope);db.prepare('INSERT INTO credential_scope VALUES(?,?)').run(credentialId,scope);}
  const actor={principalId:actorId,credentialId,actorKind:'human',credentialExpiresAt:now+60000,workspaceId:workspace};
  const command=(entityId,commandType,payload)=>({schemaVersion:1,workspaceId:workspace,workspaceEpoch:epoch,operationId:randomUUID(),entityId,commandType,payload,expectedVersion:0});
  assert.ok(executeCommand(db,actor,command(issueId,'Issue.Create',{projectId:project,title:'Synthetic issue',description:'[unchanged](/wiki/original)',assigneeId:null,priority:null,parentId:null,initialStatus:'ready'}),{now}).data);
  assert.ok(executeCommand(db,actor,command(pageId,'Wiki.Create',{pageId,scope:{kind:'project',projectId:project},parentId:null,title:'Synthetic Wiki',slug:'日本語',contentMarkdown:'[unchanged](/projects/CURRENT/issues/1/old)'}),{now}).data);
  importProjectUrls(db,{projects:[{projectId:project,key:'CURRENT',slug:'synthetic-project'}]});
  const number=db.prepare('SELECT number FROM issue_number WHERE issue_id=?').get(issueId).number;
  const wireSession={principalId:actorId,actorKind:'human',workspaceId:workspace,workspaceEpoch:epoch,sessionId:credentialId,authzVersion:1,expiresAt:now+60000,scopes};let sessionPatch={},replyPatch=null;const reads=[];
  const ports=createProductPorts({baseUrl:'https://synthetic.invalid',fetchImpl:async(url,init)=>{
    const request=new Request(url,init),u=new URL(request.url);reads.push(u.pathname);
    assert.equal(request.method,'GET');assert.equal(init.redirect,'manual');assert.equal(init.cache,'no-store');assert.equal(init.credentials,'same-origin');
    if(u.pathname==='/v1/bootstrap')return Response.json({principalId:actorId,actorKind:'human',expiresAt:now+60000,workspaces:[{workspaceId:workspace,workspaceEpoch:epoch,principalId:actorId,name:'Synthetic workspace'}]});
    if(u.pathname==='/v1/session'){assert.equal(u.searchParams.get('workspaceId'),workspace);return Response.json({...wireSession,...sessionPatch});}
    const r=route(request,{origin:u.origin,workspaces:[workspace]}),args=queryArgs(r);
    if(r.action==='legacyUrl'){const result=queryLegacyUrl(db,actor,args,now);return resultResponse(replyPatch?replyPatch(result):result,'human');}
    assert.equal(r.action,'projects');const result=queryProjects(db,actor,args,now);return resultResponse({...result,meta:{workspaceId:workspace,workspaceEpoch:epoch,actorId}},'human');
  }});
  const bootstrap=checkBootstrap(await ports.bootstrap({signal:new AbortController().signal}));const w=chooseWorkspace(bootstrap,null),selected={workspace:w,principal:w.principal};
  const signal=new AbortController().signal;
  for(const [path,kind,idValue]of [[`/projects/CURRENT/issues/${number}/stale-title`,'issue',issueId],[`/projects/CURRENT/issues/${number}/`,'issue',issueId],['/wiki/'+encodeURIComponent('日本語'),'wiki',pageId],['/projects/view/synthetic-project','project',project]]){
    const start=reads.length,target=await ports.legacyURL(selected,{path,signal});assert.deepEqual(reads.slice(start),['/v1/session',`/v1/workspaces/${workspace}/legacy-url`]);assert.equal(target.kind,kind);assert.equal(target.id,idValue);assert.ok(target.canonicalPath.startsWith('/?view='));
  }
  const session=await ports.session(selected),p=await ports.contentAPI(selected).project({session,projectId:project,signal});assert.equal(p.data.key,'CURRENT');assert.equal(p.data.slug,'synthetic-project');assert.equal(p.meta.workspaceEpoch,epoch);
  for(const patch of [{principalId:id(99)},{workspaceEpoch:id(99)},{workspaceId:id(99)}]){sessionPatch=patch;const start=reads.length;await assert.rejects(ports.legacyURL(selected,{path:'/wiki/'+encodeURIComponent('日本語'),signal}));assert.deepEqual(reads.slice(start),['/v1/session']);}sessionPatch={};
  for(const key of ['workspaceId','workspaceEpoch','actorId']){replyPatch=result=>({...result,meta:{...result.meta,[key]:id(99)}});await assert.rejects(ports.legacyURL(selected,{path:'/projects/view/synthetic-project',signal}),/UNAVAILABLE/);}replyPatch=null;
  const missing=await ports.legacyURL(selected,{path:'/wiki/missing',signal}).catch(e=>e.code);
  db.prepare('UPDATE project_grant SET can_read=0 WHERE principal_id=?').run(actorId);
  const hidden=await ports.legacyURL(selected,{path:'/wiki/'+encodeURIComponent('日本語'),signal}).catch(e=>e.code);assert.equal(hidden,missing);assert.equal(hidden,'NOT_FOUND');
  assert.equal(db.prepare('SELECT r.content_markdown FROM issue_content c JOIN content_revision r ON r.id=c.body_revision_id WHERE c.issue_id=?').get(issueId).content_markdown,'[unchanged](/wiki/original)');assert.equal(db.prepare('SELECT r.content_markdown FROM wiki_page p JOIN content_revision r ON r.id=p.current_revision_id WHERE p.id=?').get(pageId).content_markdown,'[unchanged](/projects/CURRENT/issues/1/old)');
});
