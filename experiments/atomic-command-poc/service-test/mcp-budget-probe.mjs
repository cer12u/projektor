import {createMCPTransport,MCP_MODERN,MCP_LIMITS} from '../service/mcp.mjs';
import {listMCPTools} from '../service/mcp-tools.mjs';
import {readMCPResponse} from './mcp-client-fixture.mjs';
const value={data:{contentMarkdown:'\u0001'.repeat(262144)}};
const handle=createMCPTransport({rateLimit:{workspaceBurst:128,workspacePerSecond:50,identityBurst:100,identityPerSecond:25},listTools:listMCPTools,callTool:()=>value});
const message={jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'wiki_get',arguments:{workspaceId:'w',workspaceEpoch:'e',entityId:'r'},_meta:{'io.modelcontextprotocol/protocolVersion':MCP_MODERN,'io.modelcontextprotocol/clientCapabilities':{}}}};
const request=new Request('https://fixture.invalid/mcp',{method:'POST',headers:{accept:'application/json, text/event-stream','mcp-protocol-version':MCP_MODERN,'mcp-method':'tools/call','mcp-name':'wiki_get'}}),identity={workspaceId:'w',epoch:'e',principalId:'p',credentialId:'c'};
const run=()=>handle(request,message,identity);const wireBytes=new TextEncoder().encode(await run().text()).length;
if(wireBytes>MCP_LIMITS.outputBytes)throw Error('Wire budget');
for(let i=0;i<3;i++)await readMCPResponse(run());global.gc?.();const before=process.memoryUsage(),times=[];
for(let i=0;i<20;i++){const start=performance.now();const r=await readMCPResponse(run());if(r.result.structuredContent.data.contentMarkdown!==value.data.contentMarkdown)throw Error('Source changed');times.push(performance.now()-start);}
const after=process.memoryUsage();times.sort((a,b)=>a-b);
console.log(JSON.stringify({runtime:process.version,kind:'synthetic Node serializer plus bounded fixture reader, not Workers production capacity',iterations:20,inputMarkdownBytes:262144,wireBytes,wireLimit:MCP_LIMITS.outputBytes,medianMs:times[10],p95Ms:times[18],maxMs:times[19],before,after,processMaxRssKiB:process.resourceUsage().maxRSS},null,2));
