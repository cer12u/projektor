import {createMCPRateLimiter} from './mcp-rate.mjs';
// Pinned dual-era Streamable HTTP, JSON-response-only profile. No credentials,
// automatic retries, server requests, subscriptions, tasks or remote schema fetch.
export const MCP_MODERN='2026-07-28', MCP_LEGACY='2025-11-25';
export const MCP_VERSIONS=Object.freeze([MCP_MODERN,MCP_LEGACY]);
export const MCP_LIMITS=Object.freeze({inputBytes:2097152,outputBytes:4194304,idBytes:128,sessionTtlMs:1800000,sessions:64,sessionsPerIdentity:4,toolsPageSize:16});
export const MCP_INSTRUCTIONS='Large results require structuredContent support: when a complete serialized TextContent copy would exceed the wire budget, text contains a notice and all data remains unchanged in structuredContent. Text-only clients should request paginated queries with limit=1 and follow nextCursor; compatibility for an oversized non-paged result is not guaranteed.';
const info=Object.freeze({name:'projektor',version:'r10-1'}),capabilities=Object.freeze({tools:{}});
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const text=(x,n)=>typeof x==='string'&&x.length>0&&x.length<=n&&x.isWellFormed();
const id=x=>Number.isSafeInteger(x)||text(x,MCP_LIMITS.idBytes)&&new TextEncoder().encode(x).length<=MCP_LIMITS.idBytes;
const only=(o,keys)=>record(o)&&Object.keys(o).every(k=>keys.includes(k));
const headers={'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'};
export function mcpError(code,message,status=400,requestId, data){return Response.json({jsonrpc:'2.0',...(id(requestId)?{id:requestId}:{}),error:{code,message,...(data?{data}:{})}},{status,headers});}
export function mcpFailure(code,status=503,requestId){return mcpError(1001,'Request unavailable',status,requestId,{code,outcome:'unknown',retryable:status===503||status===429,...(status===429?{retryAfter:1}:{})});}
function result(requestId,value,modern,extra={}){
 const out={jsonrpc:'2.0',id:requestId,result:modern?{...value,resultType:'complete',_meta:{'io.modelcontextprotocol/serverInfo':info}}:value};
 let bytes=JSON.stringify(out);
 if(new TextEncoder().encode(bytes).length>MCP_LIMITS.outputBytes&&own(out.result,'structuredContent')){
  out.result.content=[{type:'text',text:'The duplicate serialized JSON TextContent copy is omitted because it exceeds the wire budget. The complete unchanged result, including every source byte and pagination cursor, is in structuredContent. This result requires a structuredContent-capable client; text-only clients should use limit=1 on paginated queries.'}];
  bytes=JSON.stringify(out);
 }
 if(new TextEncoder().encode(bytes).length>MCP_LIMITS.outputBytes)return mcpFailure('RESPONSE_TOO_LARGE',503,requestId);
 return new Response(bytes,{status:200,headers:{...headers,'content-type':'application/json',...extra}});
}
const accepted=()=>new Response(null,{status:202,headers});
function hasAccept(request,type){return (request.headers.get('accept')??'').split(',').some(part=>{const [name,...params]=part.trim().toLowerCase().split(';');return name===type&&!params.some(p=>/^\s*q\s*=\s*0(?:\.0*)?\s*$/.test(p));});}
function decodedHeader(value){
 if(value===null||value.length>1024)return null;
 if(value.startsWith('=?base64?')&&value.endsWith('?=')){
  try{const b=value.slice(9,-2);if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b))return null;const binary=atob(b);return new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(binary,c=>c.charCodeAt(0)));}catch{return null;}
 }
 return /^[\x20-\x7e\t]*$/.test(value)&&value.trim()===value?value:null;
}
// Transport state is disposable, bounded, and never an authorization cache. A DO
// restart/eviction invalidates legacy sessions (404); receipt state survives.
export function createMCPTransport({listTools,callTool,rateLimit,now=Date.now,randomId=()=>crypto.randomUUID()}){
 const sessions=new Map(),admitTool=createMCPRateLimiter(rateLimit,now);
 return function handle(request,rpc,identity){
  const time=now(),binding=JSON.stringify([identity.workspaceId,identity.epoch,identity.principalId,identity.credentialId]);
  for(const [key,s] of sessions)if(s.expiresAt<=time)sessions.delete(key);
  const h=request.headers,version=h.get('mcp-protocol-version'),sessionId=h.get('mcp-session-id');
  const modern=version===MCP_MODERN||record(rpc?.params?._meta)&&own(rpc.params._meta,'io.modelcontextprotocol/protocolVersion');
  if(request.method==='GET'){
   if(version!==null&&!MCP_VERSIONS.includes(version))return mcpError(-32022,'Unsupported protocol version',400,undefined,{supported:MCP_VERSIONS,requested:version});
   if(!modern&&sessionId){const s=sessions.get(sessionId);if(!s||s.binding!==binding)return mcpError(-32600,'Session not found',404);}
   return new Response(null,{status:405,headers:{...headers,allow:modern?'POST':'POST, DELETE'}});
  }
  if(request.method==='DELETE'){
   if(modern)return new Response(null,{status:405,headers:{...headers,allow:'POST'}});
   if(version!==null&&version!==MCP_LEGACY)return mcpError(-32022,'Unsupported protocol version',400,undefined,{supported:MCP_VERSIONS,requested:version});
   if(!sessionId)return mcpError(-32600,'Session required',400);
   const s=sessions.get(sessionId);if(!s||s.binding!==binding)return mcpError(-32600,'Session not found',404);
   sessions.delete(sessionId);return new Response(null,{status:204,headers});
  }
  if(request.method!=='POST')return new Response(null,{status:405,headers:{...headers,allow:'POST, DELETE'}});
  if(!hasAccept(request,'application/json')||!hasAccept(request,'text/event-stream'))return mcpError(-32600,'Accept must include application/json and text/event-stream',406,rpc?.id);
  if(!only(rpc,['jsonrpc','id','method','params'])||rpc.jsonrpc!=='2.0'||!text(rpc.method,128)||own(rpc,'id')&&!id(rpc.id)||own(rpc,'params')&&!record(rpc.params))return mcpError(-32600,'Invalid request',400,rpc?.id);
  const isRequest=own(rpc,'id'),p=rpc.params??{};
  const fail=(code,message,status=400,data)=>mcpError(code,message,status,isRequest?rpc.id:undefined,data);
  let session;
  if(modern){
   const meta=p._meta;
   if(!record(meta)||!text(meta['io.modelcontextprotocol/protocolVersion'],32)||!record(meta['io.modelcontextprotocol/clientCapabilities'])||meta['io.modelcontextprotocol/clientInfo']!==undefined&&(!record(meta['io.modelcontextprotocol/clientInfo'])||!text(meta['io.modelcontextprotocol/clientInfo'].name,200)||!text(meta['io.modelcontextprotocol/clientInfo'].version,200)))return fail(-32602,'Invalid request metadata');
   if(version!==meta['io.modelcontextprotocol/protocolVersion']||h.get('mcp-method')!==rpc.method||rpc.method==='tools/call'&&(decodedHeader(h.get('mcp-name'))===null||decodedHeader(h.get('mcp-name'))!==p.name))return fail(-32020,'Header mismatch');
   if(version!==MCP_MODERN)return fail(-32022,'Unsupported protocol version',400,{supported:MCP_VERSIONS,requested:version});
   if(!isRequest)return fail(-32600,'Notifications unsupported by this HTTP profile');
  }else{
   if(version!==null&&version!==MCP_LEGACY)return fail(-32022,'Unsupported protocol version',400,{supported:MCP_VERSIONS,requested:version});
   if(rpc.method==='initialize'){
    if(!isRequest||sessionId||!only(p,['protocolVersion','capabilities','clientInfo','_meta'])||!text(p.protocolVersion,32)||!record(p.capabilities)||!record(p.clientInfo)||!text(p.clientInfo.name,200)||!text(p.clientInfo.version,200))return fail(-32602,'Invalid initialization');
    if(sessions.size>=MCP_LIMITS.sessions||[...sessions.values()].filter(s=>s.binding===binding).length>=MCP_LIMITS.sessionsPerIdentity)return mcpFailure('RATE_LIMITED',429,rpc.id);
    const key=randomId();if(!/^[\x21-\x7e]{1,128}$/.test(key)||sessions.has(key))return mcpFailure('UNAVAILABLE',503,rpc.id);
    sessions.set(key,{binding,ready:false,expiresAt:time+MCP_LIMITS.sessionTtlMs});
    return result(rpc.id,{protocolVersion:MCP_LEGACY,capabilities,serverInfo:info,instructions:MCP_INSTRUCTIONS},false,{'mcp-session-id':key});
   }
   if(!sessionId)return fail(-32600,'Session required');
   session=sessions.get(sessionId);if(!session||session.binding!==binding)return fail(-32600,'Session not found',404);
   if(rpc.method==='notifications/initialized'){
    if(isRequest||!only(p,['_meta']))return fail(-32600,'Invalid initialized notification');
    session.ready=true;return accepted();
   }
   if(!isRequest){
    // Cancellation acknowledges receipt, never claims a transaction rolled back.
    if(rpc.method==='notifications/cancelled'&&only(p,['requestId','reason','_meta'])&&id(p.requestId)&&(p.reason===undefined||text(p.reason,4096)))return accepted();
    return fail(-32600,'Unsupported notification');
   }
   if(!session.ready&&rpc.method!=='ping')return fail(-32600,'Initialization incomplete');
  }
  const ok=value=>result(rpc.id,value,modern);
  if(rpc.method==='ping')return only(p,['_meta'])?ok({}):fail(-32602,'Invalid params');
  if(modern&&rpc.method==='server/discover')return only(p,['_meta'])?ok({supportedVersions:MCP_VERSIONS,capabilities,instructions:MCP_INSTRUCTIONS}):fail(-32602,'Invalid params');
  if(rpc.method==='tools/list'){
   if(!only(p,['cursor','_meta'])||p.cursor!==undefined&&(!text(p.cursor,100)||!/^tools-v1:[0-9]+$/.test(p.cursor)))return fail(-32602,'Invalid cursor');
   const tools=listTools(),start=p.cursor===undefined?0:Number(p.cursor.slice(9));
   if(!Number.isSafeInteger(start)||start<0||start>=tools.length&&start!==0||start%MCP_LIMITS.toolsPageSize!==0)return fail(-32602,'Invalid cursor');
   return ok({tools:tools.slice(start,start+MCP_LIMITS.toolsPageSize),...(start+MCP_LIMITS.toolsPageSize<tools.length?{nextCursor:`tools-v1:${start+MCP_LIMITS.toolsPageSize}`}:{})});
  }
  if(rpc.method==='tools/call'){
   if(!only(p,['name','arguments','_meta'])||!text(p.name,128)||!record(p.arguments))return fail(-32602,'Invalid tool params');
   const definition=listTools().find(t=>t.name===p.name);if(!definition)return fail(-32602,'Unknown tool');
   const args=p.arguments;
   if(Object.keys(args).some(k=>!own(definition.inputSchema.properties,k))||definition.inputSchema.required.some(k=>!own(args,k)))return fail(-32602,'Invalid tool arguments');
   if(args.workspaceId!==identity.workspaceId)return fail(-32602,'Workspace mismatch');
   if(h.has('idempotency-key')&&h.get('idempotency-key')!==args.operationId)return fail(-32602,'Operation ID mismatch');
   const admission=admitTool(identity,time);if(!admission.allowed){const denied=mcpError(1001,'Request unavailable',admission.status,rpc.id,{code:admission.code,outcome:'unknown',retryable:admission.status===429,...(admission.retryAfter?{retryAfter:admission.retryAfter}:{})});if(admission.retryAfter)denied.headers.set('retry-after',String(admission.retryAfter));return denied;}
   let value;try{value=callTool(p.name,args,identity);}catch{return mcpFailure('TRANSPORT_UNKNOWN',503,rpc.id);}
   // Domain failures are tool errors, not protocol success claims. Text fallback
   // is a compatibility SHOULD in both pinned specs; this profile retains it.
   return ok({isError:Boolean(value.error),content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value});
  }
  return fail(-32601,'Method not found',modern?404:200);
 };
}
