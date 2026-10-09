import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,actor,ids,now,command} from '../test/fixture.mjs';
import {executeCommand,queryIssues} from '../src/shared-core.mjs';
import {callLegacyMCPTool,listLegacyMCPTools,createLegacyMCPTransport} from '../service/legacy-mcp.mjs';

function seeded(){const f=fixture();f.db.prepare('INSERT INTO project VALUES(?,?,1,0)').run(ids.project,'Fixture project');f.db.prepare('INSERT INTO project_url VALUES(?,?,?,NULL)').run(ids.project,'TEST','test');for(const scope of ['operations:read_own','issue:read','issue:write','comment:write','history:read','wiki:read','wiki:write']){f.db.prepare('INSERT INTO principal_scope VALUES(?,?)').run(ids.actor,scope);f.db.prepare('INSERT INTO credential_scope VALUES(?,?)').run(ids.credential,scope);}return f;}
const call=(f,name,args,options={})=>callLegacyMCPTool(f.db,actor,name,args,{now,...options});
const create=f=>call(f,'create_issue',{projectId:'TEST',title:'first',body:'exact\r\n🧪',status:'backlog'}).data;
function snapshot(db){return JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT * FROM "${name}"`).all()]));}
const using=(fn)=>{const f=seeded();try{fn(f);}finally{f.close();}};

test('old create/read/ref/update/comment contracts use current Store and fresh receipts',()=>using(f=>{
 const item=create(f);assert.ok(item?.id);assert.equal(item.number,1);
 assert.equal(call(f,'get_issue',{ref:'TEST-1'}).data.body,'exact\r\n🧪');
 assert.deepEqual(call(f,'update_issue',{id:'TEST-1',title:'changed',body:'body 2',priority:'none',assigneeId:ids.actor}).data,{ok:true});
 const issue=call(f,'get_issue',{id:item.id,verbose:true}).data;assert.equal(issue.title,'changed');assert.equal(issue.body,'body 2');assert.equal(issue.priority,'none');
 const comment=call(f,'add_comment',{issueId:'TEST-1',body:'first comment'}).data;assert.ok(comment.id);
 assert.deepEqual(call(f,'update_comment',{issueId:item.id,commentId:comment.id,body:'edited'}).data,{ok:true});
 const listed=call(f,'list_comments',{issueId:item.id}).data.items;assert.equal(listed.length,1);assert.equal(listed[0].body,'edited');assert.equal(listed[0].author_id,ids.actor);assert.equal(own(listed[0],'author_email'),false);
 assert.ok(f.db.prepare('SELECT COUNT(*) n FROM operation').get().n>=6);
}));
const own=(x,k)=>Object.hasOwn(x,k);
function preservedCatalog(f,defaultKey,{mismatch=false,duplicate=false,mixedSnapshot=false,foreignWorkspace=false}={}){
 for(const [index,key] of ['backlog','todo','in_progress'].entries()){
  const id=randomUUID(),category=key==='in_progress'?'in_progress':'todo',raw={id,workspace_id:foreignWorkspace?randomUUID():ids.workspace,key,category,is_default:Number(key===defaultKey||duplicate&&key==='todo'),is_review_step:0};
  f.db.prepare('INSERT INTO issue_compat_status VALUES(?,?,?,?,0,?)').run(id,mismatch&&key===defaultKey?'stale':key,key,key==='todo'?'ready':key,index);
  f.db.prepare('INSERT INTO source_mapping VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),'legacy-projektor','legacy_archive',id,JSON.stringify(['task_statuses',(mixedSnapshot&&index===1?'b':'a').repeat(64)]),'legacy_archive',id,JSON.stringify(raw));
 }
}
test('omitted create status derives the source-confirmed imported default without schema changes',()=>{
 for(const defaultKey of ['backlog','todo',null])using(f=>{preservedCatalog(f,defaultKey);const item=call(f,'create_issue',{projectId:'TEST',title:'defaulted'});assert.ok(item.data?.id,JSON.stringify(item));assert.equal(call(f,'get_issue',{id:item.data.id}).data.status,defaultKey??'backlog');});
});
test('ambiguous, stale, mixed-snapshot, foreign or unsupported preserved defaults reject atomically',()=>{
 for(const [key,options,code] of [['backlog',{duplicate:true},'LEGACY_DEFAULT_STATUS_UNAVAILABLE'],['backlog',{mismatch:true},'LEGACY_DEFAULT_STATUS_UNAVAILABLE'],['backlog',{mixedSnapshot:true},'LEGACY_DEFAULT_STATUS_UNAVAILABLE'],['backlog',{foreignWorkspace:true},'LEGACY_DEFAULT_STATUS_UNAVAILABLE'],['in_progress',{},'LEGACY_DEFAULT_STATUS_UNSUPPORTED']])using(f=>{preservedCatalog(f,key,options);const before=snapshot(f.db);assert.equal(call(f,'create_issue',{projectId:'TEST',title:'must not appear'}).error.code,code);assert.equal(snapshot(f.db),before);});
});
test('multi-field domain rejection rolls back earlier command receipts, content, index and events',()=>using(f=>{
 const item=create(f),before=snapshot(f.db);const result=call(f,'update_issue',{id:item.id,title:'must roll back',assigneeId:randomUUID()});assert.equal(result.error.code,'ASSIGNEE_INVALID');assert.equal(snapshot(f.db),before);
}));
test('storage failure after earlier field and final receipt rolls the complete operation back',()=>using(f=>{
 const item=create(f),before=snapshot(f.db);let commands=0;
 assert.throws(()=>call(f,'update_issue',{id:item.id,title:'next',body:'next body'},{fault:point=>{if(point==='after_receipt'&&++commands===2)throw Error('synthetic fault');}}));assert.equal(snapshot(f.db),before);
}));
test('facade takes one transaction and current versions; public native CAS remains mandatory',()=>using(f=>{
 const item=create(f),sql=[],db={prepare:s=>f.db.prepare(s),exec:s=>{sql.push(s);return f.db.exec(s);}};
 const result=callLegacyMCPTool(db,actor,'update_issue',{id:item.id,title:'two',body:'three'},{now});assert.equal(result.data.ok,true);assert.deepEqual(sql,['BEGIN IMMEDIATE','COMMIT']);
 const c=command({entityId:item.id,payload:{title:'native'},expectedVersion:undefined});assert.equal(executeCommand(f.db,actor,c,{now}).error.code,'PRECONDITION_REQUIRED');
}));
test('unsupported fields/default status/workflow and unknown tools have zero side effects',()=>using(f=>{
 const item=create(f),before=snapshot(f.db);
 for(const [name,args,code] of [['update_issue',{id:item.id,title:'no',status:'done'},'LEGACY_ARGUMENT_UNSUPPORTED'],['create_issue',{projectId:'TEST',title:'no'},'LEGACY_DEFAULT_STATUS_UNAVAILABLE'],['delete_comment',{issueId:item.id,commentId:randomUUID()},'LEGACY_TOOL_UNSUPPORTED'],['create_wiki_page',{title:'no',content:'---\ntype: runbook\n---\ntext'},'LEGACY_FRONTMATTER_UNSUPPORTED']])assert.equal(call(f,name,args).error.code,code);
 assert.equal(snapshot(f.db),before);
}));
test('comment issue binding and original-author check cannot be bypassed by moderator scope',()=>using(f=>{
 const a=create(f),b=create(f),comment=call(f,'add_comment',{issueId:a.id,body:'mine'}).data;
 assert.equal(call(f,'update_comment',{issueId:b.id,commentId:comment.id,body:'cross issue'}).error.code,'NOT_FOUND');
 f.db.prepare('UPDATE issue_entry SET author_ref=? WHERE id=?').run(JSON.stringify({principalId:randomUUID(),resolution:'linked'}),comment.id);
 for(const [table,key] of [['principal_scope',ids.actor],['credential_scope',ids.credential]])f.db.prepare(`INSERT INTO ${table} VALUES(?,?)`).run(key,'comment:moderate');
 assert.equal(call(f,'update_comment',{issueId:a.id,commentId:comment.id,body:'not author'}).error.code,'COMMENT_FORBIDDEN');
}));
test('current read/write authority gates legacy facade; revoked credentials deny',()=>using(f=>{
 const item=create(f);f.db.prepare('UPDATE project_grant SET can_write=0').run();const before=snapshot(f.db);assert.equal(call(f,'update_issue',{id:item.id,title:'denied'}).error.code,'FORBIDDEN');assert.equal(snapshot(f.db),before);
 f.db.prepare('UPDATE project_grant SET can_read=0').run();assert.equal(call(f,'get_issue',{ref:'TEST-1'}).error.code,'NOT_FOUND');
 f.db.prepare('UPDATE credential SET revoked=1').run();assert.equal(call(f,'list_issues',{}).error.code,'FORBIDDEN');
}));
test('Wiki create/read/window/edit/rename keep old shape and optional current revision condition',()=>using(f=>{
 const page=call(f,'create_wiki_page',{title:'Wiki title',slug:'wiki-title',projectId:'TEST',content:'# Intro\n🧪hello\n## Details\nmore'}).data;assert.ok(page?.id);assert.equal(page.projectId,ids.project);assert.equal(page.isTemplate,false);
 const read=call(f,'get_wiki_page',{slug:'wiki-title',maxChars:9}).data;assert.equal(read.contentTruncated,true);assert.ok(read.next);assert.ok(read.revisionId);
 const section=call(f,'get_wiki_page',{slug:page.id,section:'Details'}).data;assert.equal(section.content,'## Details\nmore');assert.equal(section.contentTruncated,true);
 const before=snapshot(f.db);assert.equal(call(f,'update_wiki_page',{id:page.id,content:'bad',baseRevisionId:randomUUID()}).error.code,'VERSION_CONFLICT');assert.equal(snapshot(f.db),before);
 assert.deepEqual(call(f,'update_wiki_page',{slug:'wiki-title',title:'Renamed',newSlug:'renamed',content:'new exact\r\n',baseRevisionId:read.revisionId}).data,{ok:true,url:'/wiki/renamed'});
 assert.equal(call(f,'get_wiki_page',{slug:'wiki-title'}).data.content,'new exact\r\n');assert.equal(call(f,'list_wiki_pages',{projectId:'TEST'}).data.length,1);
}));
test('Wiki reserved names derive source-compatible suffix; explicit reserved slug fails',()=>using(f=>{
 assert.equal(call(f,'create_wiki_page',{title:'Templates',projectId:'TEST'}).data.slug,'templates-page');assert.equal(call(f,'create_wiki_page',{title:'No',slug:'tree',projectId:'TEST'}).error.code,'VALIDATION');
}));
test('list filters keep legacy priorities, status and read-only projections',()=>using(f=>{
 const item=create(f);call(f,'update_issue',{id:item.id,priority:'urgent'});const list=call(f,'list_issues',{projectId:'TEST',status:'backlog',priority:'urgent',bodyChars:5}).data;assert.equal(list.items.length,1);assert.equal(list.items[0].ref,'TEST-1');assert.equal(list.items[0].priority,'urgent');assert.equal(list.items[0].body,'exact');assert.equal(list.items[0].bodyTruncated,true);
}));

test('old stateless transport accepts direct calls, domain discovery and reused JSON-RPC IDs',async()=>{
 const f=seeded();try{const item=create(f),handler=createLegacyMCPTransport({rateLimit:{workspaceBurst:100,workspacePerSecond:100,identityBurst:100,identityPerSecond:100},now:()=>now,callTool:(name,args)=>call(f,name,args)});
 const request=new Request('https://example.test/mcp/'+ids.workspace,{method:'POST'}),rpc={jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'add_comment',arguments:{issueId:item.id,body:'same caller request id'}}};
 const first=await handler(request,rpc,actor).json(),second=await handler(request,rpc,actor).json();assert.notEqual(JSON.parse(first.result.content[0].text).id,JSON.parse(second.result.content[0].text).id);assert.equal(call(f,'list_comments',{issueId:item.id}).data.items.length,2);
 const discovery=await handler(new Request(request.url+'?domains=comments',{method:'POST'}),{jsonrpc:'2.0',id:1,method:'tools/list'},actor).json();assert.deepEqual(discovery.result.tools.map(x=>x.name),['list_comments','add_comment','update_comment']);assert.equal(discovery.result.cacheScope,'private');
 assert.equal(handler(new Request(request.url+'?domains=unknown',{method:'POST'}),{jsonrpc:'2.0',id:1,method:'tools/list'},actor).status,400);
 const init=await handler(request,{jsonrpc:'2.0',id:2,method:'initialize'},actor).json();assert.equal(init.result.protocolVersion,'2025-11-25');assert.match(init.result.instructions,/not an idempotency key/);
 }finally{f.close();}
});
