import {readMCPResponse} from './mcp-client-fixture.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMCPTransport,MCP_MODERN,MCP_LEGACY,MCP_LIMITS} from '../service/mcp.mjs';
import {listMCPTools} from '../service/mcp-tools.mjs';
const syntheticRate={workspaceBurst:128,workspacePerSecond:50,identityBurst:100,identityPerSecond:25};
const identity={workspaceId:'workspace',epoch:'epoch',principalId:'principal',credentialId:'credential'};
const meta={'io.modelcontextprotocol/protocolVersion':MCP_MODERN,'io.modelcontextprotocol/clientCapabilities':{}};
const rpc=(method,params={},id=1)=>({jsonrpc:'2.0',id,method,params});
function request(message,{modern=true,headers={},method='POST'}={}){return new Request('https://example.invalid/mcp',{method,headers:{accept:'application/json, text/event-stream',...(modern?{'mcp-protocol-version':MCP_MODERN,'mcp-method':message?.method??'',...(message?.method==='tools/call'?{'mcp-name':message.params.name}:{})}:{}),...headers}});}
function setup(options={}){let calls=0,time=100;const handle=createMCPTransport({rateLimit:syntheticRate,listTools:listMCPTools,callTool:()=>{calls++;return {data:{version:3}};},now:()=>time,...options});return {handle,call:(message,opt={},who=identity)=>handle(request(message,opt),message,who),get calls(){return calls;},tick:ms=>time+=ms};}
const modern=(method,params={},id=1)=>rpc(method,{...params,_meta:meta},id);
async function session(s){const r=s.call(rpc('initialize',{protocolVersion:MCP_LEGACY,capabilities:{},clientInfo:{name:'fixture',version:'1'}}),{modern:false});assert.equal(r.status,200);return r.headers.get('mcp-session-id');}
const legacy=sid=>({modern:false,headers:{'mcp-protocol-version':MCP_LEGACY,'mcp-session-id':sid}});
test('modern discovery/direct calls stateless; no initialization or sessions',async()=>{
 const s=setup(),d=await s.call(modern('server/discover')).json();assert.deepEqual(d.result.supportedVersions,[MCP_MODERN,MCP_LEGACY]);assert.equal(d.result.resultType,'complete');assert.deepEqual(d.result.capabilities,{tools:{}});
 const r=s.call(modern('tools/call',{name:'issue_get',arguments:{workspaceId:'workspace',workspaceEpoch:'epoch',entityId:'entity'}}),{headers:{'mcp-session-id':'ignored'}});assert.equal(r.status,200);assert.equal(r.headers.get('mcp-session-id'),null);const b=await r.json();assert.equal(b.result.resultType,'complete');assert.equal(b.result.content[0].text,JSON.stringify(b.result.structuredContent));assert.equal(s.calls,1);
 assert.equal((await s.call(modern('initialize')).json()).error.code,-32601);for(const method of ['GET','DELETE','PATCH'])assert.equal(s.call(undefined,{method}).status,405);
});
test('legacy version negotiation, initialized, ping and DELETE lifecycle',async()=>{
 const s=setup(),r=s.call(rpc('initialize',{protocolVersion:'2099-01-01',capabilities:{sampling:{}},clientInfo:{name:'x',version:'1'}}),{modern:false}),sid=r.headers.get('mcp-session-id');assert.equal((await r.json()).result.protocolVersion,MCP_LEGACY);
 assert.equal(s.call(rpc('tools/list'),legacy(sid)).status,400);assert.deepEqual((await s.call(rpc('ping'),legacy(sid)).json()).result,{});
 const ready=s.call({jsonrpc:'2.0',method:'notifications/initialized'},legacy(sid));assert.equal(ready.status,202);assert.equal(await ready.text(),'');assert.equal(s.call(rpc('tools/list'),legacy(sid)).status,200);
 assert.equal(s.call(undefined,{...legacy(sid),method:'DELETE'}).status,204);assert.equal(s.call(rpc('ping'),legacy(sid)).status,404);
});
test('sessions bounded, expire, bound to principal/credential/epoch, lost on restart',async()=>{
 const s=setup(),sid=await session(s);for(const key of ['workspaceId','epoch','principalId','credentialId'])assert.equal(s.call(rpc('ping'),legacy(sid),{...identity,[key]:'other'}).status,404);
 for(let i=1;i<MCP_LIMITS.sessionsPerIdentity;i++)await session(s);assert.equal(s.call(rpc('initialize',{protocolVersion:MCP_LEGACY,capabilities:{},clientInfo:{name:'x',version:'1'}}),{modern:false}).status,429);
 assert.equal(setup().call(rpc('ping'),legacy(sid)).status,404);s.tick(MCP_LIMITS.sessionTtlMs);assert.equal(s.call(rpc('ping'),legacy(sid)).status,404);await session(s);
});
test('stable paginated tools, exact coverage, schemas without actor and defensive copies',async()=>{
 const s=setup(),found=[];let cursor;do{const b=await s.call(modern('tools/list',cursor?{cursor}:{})).json();assert.ok(b.result.tools.length<=16);found.push(...b.result.tools);cursor=b.result.nextCursor;}while(cursor);
 assert.deepEqual(found,listMCPTools());assert.equal(new Set(found.map(t=>t.name)).size,found.length);for(const t of found){assert.equal(t.inputSchema.additionalProperties,false);assert.equal(t.inputSchema.properties.actor,undefined);assert.ok(t.inputSchema.properties.workspaceId);}
 for(const cursor of ['','tools-v1:1','tools-v1:999999','tools-v1:NaN','tools-v1:16:extra'])assert.equal((await s.call(modern('tools/list',{cursor})).json()).error.code,-32602);
 const a=listMCPTools();a[0].name='tamper';assert.notEqual(listMCPTools()[0].name,'tamper');
});
test('bad protocol identities and envelope errors never dispatch',async()=>{
 const s=setup();for(const id of [null,1.2,Number.MAX_SAFE_INTEGER+1,'x'.repeat(129),{},[]])assert.equal(s.call({...modern('ping'),id}).status,400);
 for(const v of [null,[],{},[{jsonrpc:'2.0',id:1,method:'ping'}],{...modern('ping'),actor:{}},{...modern('ping'),params:[]}])assert.equal(s.call(v).status,400);
 assert.equal((await s.call(modern('unknown')).json()).error.code,-32601);assert.equal(s.call(modern('unknown')).status,404);
 assert.equal((await s.call(modern('tools/call',{name:'unknown',arguments:{workspaceId:'workspace',workspaceEpoch:'epoch',entityId:'entity'}})).json()).error.code,-32602);
 assert.equal(s.call(modern('tools/call',{name:'issue_get',arguments:{workspaceId:'other',workspaceEpoch:'epoch',entityId:'entity'}})).status,400);
 assert.equal(s.call(modern('tools/call',{name:'issue_get',arguments:{workspaceId:'workspace',workspaceEpoch:'epoch',entityId:'entity'}}),{headers:{'idempotency-key':'not-envelope-id'}}).status,400);assert.equal(s.calls,0);
});
test('metadata, mirrored headers and Base64 names validated',async()=>{
 const s=setup(),base=modern('tools/call',{name:'issue_get',arguments:{workspaceId:'workspace',workspaceEpoch:'epoch',entityId:'entity'}});
 for(const change of [{'mcp-method':'other'},{'mcp-protocol-version':'other'},{'mcp-name':'other'},{'mcp-name':'=?base64?%%%%?='}]){const r=s.call(base,{headers:change});assert.equal(r.status,400);assert.equal((await r.json()).error.code,-32020);}
 assert.equal(s.call(base,{headers:{'mcp-name':'=?base64?aXNzdWVfZ2V0?='}}).status,200);
 for(const wrong of [undefined,{}, {'io.modelcontextprotocol/protocolVersion':MCP_MODERN}])assert.equal((await s.call({...base,params:{...base.params,_meta:wrong}}).json()).error.code,-32602);
 const future={...base,params:{...base.params,_meta:{...meta,'io.modelcontextprotocol/protocolVersion':'2099-01-01'}}};assert.equal((await s.call(future,{headers:{'mcp-protocol-version':'2099-01-01'}}).json()).error.code,-32022);
});
test('notifications have empty 202; legacy-only modern notifications rejected',async()=>{
 const s=setup(),sid=await session(s);for(const m of [{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:'x',reason:'timeout'}}]){const r=s.call(m,legacy(sid));assert.equal(r.status,202);assert.equal(await r.text(),'');}
 assert.equal(s.call({jsonrpc:'2.0',method:'notifications/initialized',params:{_meta:meta}}).status,400);assert.equal(s.calls,0);
});
test('Accept, tool versus protocol failure, output cap and exception redaction',async()=>{
 const s=setup();for(const accept of ['application/json','text/event-stream','*/*','application/json;q=0,text/event-stream'])assert.equal(s.call(modern('ping'),{headers:{accept}}).status,406);
 const args={name:'issue_get',arguments:{workspaceId:'workspace',workspaceEpoch:'epoch',entityId:'entity'}},bad=setup({callTool:()=>({error:{code:'VERSION_CONFLICT',outcome:'rejected'}})});const domain=await bad.call(modern('tools/call',args)).json();assert.equal(domain.result.isError,true);assert.equal(domain.error,undefined);
 const oversized=setup({callTool:()=>({data:{body:'x'.repeat(MCP_LIMITS.outputBytes)}})}),o=oversized.call(modern('tools/call',args));assert.equal(o.status,503);assert.equal((await o.json()).error.data.outcome,'unknown');
 const broken=setup({callTool:()=>{throw Error('secret SQL cookie');}}),r=broken.call(modern('tools/call',args));assert.equal(r.status,503);assert.doesNotMatch(await r.text(),/secret|SQL|cookie/);
});
test('workspace-wide session cap and malformed initialization never grow authority',async()=>{
 const s=setup(),init=rpc('initialize',{protocolVersion:MCP_LEGACY,capabilities:{},clientInfo:{name:'fixture',version:'1'}});
 for(let i=0;i<MCP_LIMITS.sessions;i++)assert.equal(s.call(init,{modern:false},{...identity,principalId:'p'+i}).status,200);
 assert.equal(s.call(init,{modern:false},{...identity,principalId:'overflow'}).status,429);s.tick(MCP_LIMITS.sessionTtlMs);assert.equal(s.call(init,{modern:false},{...identity,principalId:'fresh'}).status,200);
 for(const params of [{},{protocolVersion:MCP_LEGACY,capabilities:[],clientInfo:{name:'x',version:'1'}},{protocolVersion:MCP_LEGACY,capabilities:{},clientInfo:{name:'x'}}])assert.equal(setup().call(rpc('initialize',params),{modern:false}).status,400);
});
test('deleted legacy session GET returns404, active legacy GET advertises no stream',async()=>{
 const s=setup(),sid=await session(s);assert.equal(s.call(undefined,{...legacy(sid),method:'GET'}).status,405);s.call(undefined,{...legacy(sid),method:'DELETE'});assert.equal(s.call(undefined,{...legacy(sid),method:'GET'}).status,404);
});

test('matching bounded client reader accepts valid responses and rejects oversized/non-UTF8 input',async()=>{const s=setup();assert.equal((await readMCPResponse(s.call(modern('ping')))).result.resultType,'complete');await assert.rejects(()=>readMCPResponse(new Response('x'.repeat(MCP_LIMITS.outputBytes+1),{headers:{'content-type':'application/json'}})),/Local MCP client: response limit/);await assert.rejects(()=>readMCPResponse(new Response(Uint8Array.of(255),{headers:{'content-type':'application/json'}})));});
test('unsupported protocol version rejects legacy GET before no-stream405',async()=>{const s=setup(),sid=await session(s),r=s.call(undefined,{...legacy(sid),method:'GET',headers:{'mcp-session-id':sid,'mcp-protocol-version':'2099-01-01'}});assert.equal(r.status,400);assert.equal((await r.json()).error.code,-32022);});
test('stateless and legacy tool calls share a bounded token bucket, refill and never retry',async()=>{
 const s=setup(),m=modern('tools/call',{name:'issue_get',arguments:{workspaceId:'workspace',workspaceEpoch:'epoch',entityId:'entity'}});
 for(let i=0;i<syntheticRate.identityBurst;i++)assert.equal(s.call({...m,id:i}).status,200);
 const r=s.call(m);assert.equal(r.status,429);assert.equal(r.headers.get('retry-after'),'1');assert.equal((await r.json()).error.data.code,'RATE_LIMITED');assert.equal(s.calls,syntheticRate.identityBurst);
 const sid=await session(s);s.call({jsonrpc:'2.0',method:'notifications/initialized'},legacy(sid));assert.equal(s.call(rpc('tools/call',{name:m.params.name,arguments:m.params.arguments}),legacy(sid)).status,429);
 s.tick(1000/syntheticRate.identityPerSecond);assert.equal(s.call(m).status,200);assert.equal(s.calls,syntheticRate.identityBurst+1);
});
test('large duplicate response falls back explicitly to complete structuredContent in both eras',async()=>{
 const value={data:{items:[{body:'\u0001'.repeat(262144)},{body:'\u0001'.repeat(61000)}],nextCursor:'unchanged'}};
 const s=setup({callTool:()=>value}),m=modern('tools/call',{name:'wiki_list',arguments:{workspaceId:'workspace',workspaceEpoch:'epoch'}}),sid=await session(s);s.call({jsonrpc:'2.0',method:'notifications/initialized'},legacy(sid));
 for(const r of [s.call(m),s.call(rpc('tools/call',{name:m.params.name,arguments:m.params.arguments}),legacy(sid))]){assert.equal(r.status,200);const b=await readMCPResponse(r);assert.deepEqual(b.result.structuredContent,value);assert.match(b.result.content[0].text,/duplicate.*omitted/);assert.match(b.result.content[0].text,/structuredContent/);}
 assert.match((await s.call(modern('server/discover')).json()).result.instructions,/Large results require structuredContent/);
});
test('without an explicit invocation policy discovery works but tools fail closed',async()=>{const s=setup({rateLimit:undefined});assert.equal(s.call(modern('server/discover')).status,200);const r=s.call(modern('tools/call',{name:'issue_get',arguments:{workspaceId:'workspace',workspaceEpoch:'epoch',entityId:'entity'}}));assert.equal(r.status,503);assert.equal((await r.json()).error.data.code,'MCP_RATE_LIMIT_CONFIG_REQUIRED');assert.equal(s.calls,0);});
