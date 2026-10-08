import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MyIssuesController,createMyIssuesTransport,createVerifiedSessionAdapter} from '../experiments/atomic-command-poc/browser/my-issues.mjs';
const id=n=>`90000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const now=1800000000000;
const session={principalId:id(1),workspaceId:id(2),workspaceEpoch:id(3),sessionId:id(4),actorKind:'human',authzVersion:1,expiresAt:now+60000};
const item=(n,priority=1)=>({id:id(100+n),project_id:id(5),title:`item ${n}`,version:1,assignee_id:session.principalId,assignee_kind:'human',status_category:'ready',priority,created_at:100});
const page=(items,nextCursor,total,extra={})=>({data:{items,nextCursor,total},meta:{workspaceId:session.workspaceId,actorId:session.principalId,workspaceEpoch:session.workspaceEpoch,changeSeq:1,visibilityVersion:1,refreshRequired:false,queryFingerprint:'a'.repeat(64),...extra}});
const create=(t,read,{readSession=async()=>session,filters={limit:1}}={})=>{const c=new MyIssuesController({sessionAdapter:{read:readSession},transport:{read},filters,now:()=>now});t.after(()=>c.dispose());return c;};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};

test('visibility drift drops page-one rows even if server forgot refreshRequired',async t=>{let n=0;const c=create(t,async()=>n++?page([item(2)],null,2,{visibilityVersion:2}):page([item(1)],'c1',2));assert.equal((await c.refresh()).kind,'partial');assert.equal((await c.loadMore()).kind,'stale');assert.deepEqual(c.snapshot().items,[]);assert.equal(c.snapshot().total,null);});

test('page-two network failure remains visibly incomplete and bounded manual retry works',async t=>{let n=0;const c=create(t,async()=>{n++;if(n===2)throw Object.assign(Error(),{code:'NETWORK_ERROR'});return n===1?page([item(1)],'c1',2):page([item(2)],null,2);});await c.refresh();assert.equal((await c.loadMore()).kind,'partial');assert.equal(c.snapshot().complete,false);assert.equal(c.snapshot().items.length,1);assert.equal(c.snapshot().code,'NETWORK_ERROR');assert.equal(n,2);assert.equal((await c.retry()).kind,'ready');assert.equal(c.snapshot().complete,true);assert.equal(n,3);});

for(const [label,second] of [
 ['missing tail cursor',page([],null,2)],
 ['repeated cursor',page([item(2)],'c1',3)],
 ['duplicate issue',page([item(1)],null,2)],
 ['descending priority',page([item(2,0)],null,2)],
 ['changed actor',page([item(2)],null,2,{actorId:id(99)})],
 ['invalid fingerprint',page([item(2)],null,2,{queryFingerprint:'garbage'})]
])test(`malformed continuation never becomes complete: ${label}`,async t=>{let n=0;const c=create(t,async()=>n++?second:page([item(1)],'c1',2));await c.refresh();await c.loadMore();assert.equal(c.snapshot().complete,false);assert.equal(c.snapshot().items.length,0);assert.ok(['error','locked','stale'].includes(c.snapshot().phase));});

test('changed filter fences late old response',async t=>{const old=deferred();let n=0;const c=create(t,async()=>n++?page([],null,0):old.promise);const first=c.refresh();await new Promise(r=>setImmediate(r));assert.equal((await c.setFilters({status:'all'})).kind,'empty');old.resolve(page([item(1)],null,1));assert.equal((await first).kind,'discarded');assert.equal(c.snapshot().phase,'empty');assert.deepEqual(c.snapshot().items,[]);});

test('observed session identity change fences old authenticated response',async t=>{const old=deferred();let identity=session,n=0;const c=create(t,async()=>n++?page([],null,0,{actorId:id(9)}):old.promise,{readSession:async()=>identity});const first=c.refresh();await new Promise(r=>setImmediate(r));identity={...session,principalId:id(9),sessionId:id(10)};assert.equal((await c.sessionChanged()).kind,'empty');old.resolve(page([item(1)],null,1));assert.equal((await first).kind,'discarded');assert.deepEqual(c.snapshot().items,[]);});

test('visibility hide clears synchronously and late response stays discarded',async t=>{const old=deferred();const c=create(t,async()=>old.promise);const pending=c.refresh();await new Promise(r=>setImmediate(r));c.setVisible(false);assert.equal(c.snapshot().locked,true);old.resolve(page([item(1)],null,1));assert.equal((await pending).kind,'discarded');assert.deepEqual(c.snapshot().items,[]);});

test('transport stalled fetch settles within deadline',async()=>{const transport=createMyIssuesTransport({baseUrl:'https://review.invalid',deadlineMs:20,fetchImpl:()=>new Promise(()=>{})});await assert.rejects(()=>transport.read({session,filters:{status:'unresolved',limit:1,projectId:null}}),e=>e.code==='TIMEOUT');});

test('transport HTML 200 is protocol error, never authorized empty',async()=>{const transport=createMyIssuesTransport({baseUrl:'https://review.invalid',fetchImpl:async()=>new Response('<html>Sign in</html>',{status:200,headers:{'content-type':'text/html'}})});await assert.rejects(()=>transport.read({session,filters:{status:'unresolved',limit:1,projectId:null}}),e=>e.code==='PROTOCOL_ERROR');});

test('stalled response body settles within deadline',async()=>{const transport=createMyIssuesTransport({baseUrl:'https://review.invalid',deadlineMs:20,fetchImpl:async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));}}),{headers:{'content-type':'application/json'}})});await assert.rejects(()=>transport.read({session,filters:{status:'unresolved',limit:1,projectId:null}}),e=>e.code==='TIMEOUT');});

test('unverified empty session cannot launch queue request',async t=>{let called=0;const c=create(t,async()=>{called++;return page([],null,0);},{readSession:async()=>({})});assert.equal((await c.refresh()).kind,'error');assert.equal(called,0);assert.equal(c.snapshot().complete,false);});
