// @module delivery
// @role mcp-adapter
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import type {ActorServices,RequestServices} from "../contracts";
import {protocolFailure} from "../http/outcomes";
import { ApiError } from "../../adapters/protocol-errors";
import {mcpConfig,federationConfig,type FederationEnv} from "./configuration";
import { createDomainMcpServer } from "./tools";

const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
/** Reserved paths cannot fall through to the SPA, including while disabled. Discovery is edge-owned. */
export function isMcpPath(path:string):boolean {
  return path==='/mcp'||path.startsWith('/mcp/')||path.startsWith('/.well-known/');
}
function errorResponse(status:number,error:string,metadataUrl?:string):Response {
  const response=Response.json({error},{status,headers});
  if(status===401)response.headers.set('WWW-Authenticate',metadataUrl?`Bearer resource_metadata="${metadataUrl}"`:'Bearer realm="Projektor"');
  if(status===405)response.headers.set('Allow','POST');
  if(status===503)response.headers.set('Retry-After','1');
  return response;
}
/** No synthetic Request, Bearer, self-HTTP or globally shared authentication state. */
export async function mcpApi(request:Request,requests:RequestServices,env:FederationEnv):Promise<Response> {
  let metadataUrl:string|undefined;
  try {
    const config=mcpConfig(env);
    if(!config)return errorResponse(404,'not_found');
    const url=new URL(request.url),origin=request.headers.get('Origin'),host=request.headers.get('Host');
    if(url.origin!==config.origin||url.protocol!=='https:'||url.username||url.password||(host!==null&&host!==url.host)||
      (origin!==null&&origin!==config.origin))throw new ApiError(403,'origin_rejected');
    if(url.search)throw new ApiError(400,'invalid_query');
    // Endpoint selects the identity contract; token shape never selects a fallback.
    const federated=url.pathname==='/mcp/federated';
    if(url.pathname!=='/mcp'&&!federated)return errorResponse(404,'not_found');
    const federation=federated&&config.federationConfigured?federationConfig(env):null;
    if(federated&&!federation)return errorResponse(404,'not_found');
    metadataUrl=federation?.resourceMetadataUrl;
    if(request.headers.has('Cookie'))throw new ApiError(400,'ambiguous_authentication');
    let services:ActorServices;
    if(!federated){
      services=await requests.authenticate(request);
      if(services.actor.authentication!=='api'||services.actor.kind!=='agent')throw new ApiError(403,'agent_credential_required');
    }else{
      if(/^Bearer [A-Za-z0-9_-]{43}$/.test(request.headers.get('Authorization')??''))throw new ApiError(400,'ambiguous_authentication');
      services=await requests.authenticateFederated(request.headers.get('Cf-Access-Jwt-Assertion')??'',federation!);
    }
    if(request.method!=='POST')return errorResponse(405,'method_not_allowed');
    if(request.signal.aborted)throw new ApiError(400,'request_aborted');
    const server=createDomainMcpServer(services,metadataUrl);
    const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true,maxRequestBodySize:96*1024,keepAliveMs:0});
    try {
      await server.connect(transport);
      // The SDK owns parsing, protocol versions, content negotiation and JSON-RPC responses.
      // Once dispatched, request cancellation is never treated as proof a mutation did not commit.
      const response=await transport.handleRequest(request);
      for(const [name,value] of Object.entries(headers))response.headers.set(name,value);
      return response;
    } finally {await server.close();}
  } catch(error) {
    const protocol=protocolFailure(error);if(protocol)return errorResponse(protocol.status,typeof protocol.body.error==='string'?protocol.body.error:'identity_unavailable',metadataUrl);
    if(error instanceof ApiError)return errorResponse(error.status,error.code,metadataUrl);
    // No SDK/raw exception text, assertion, request, or bound D1 values escape in logs/errors.
    return errorResponse(503,'temporarily_unavailable');
  }
}
