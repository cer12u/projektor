// @module delivery
// @role protocol-config
import { validAccessIssuer } from "../../adapters/external-identity/access-assertion";
import { ApiError } from "../../adapters/protocol-errors";
export interface FederationEnv {
 AUTH_ORIGIN:string; MCP_ENABLED?:string; MCP_ACCESS_ISSUER?:string;
 MCP_ACCESS_AUDIENCE?:string; MCP_RESOURCE_METADATA_URL?:string;
}
export interface FederatedConfig {origin:string;issuer:string;audience:string;resourceMetadataUrl:string}
export function federationConfig(env:FederationEnv):FederatedConfig|null {
 if(env.MCP_ENABLED===undefined||env.MCP_ENABLED==='false')return null;
 if(env.MCP_ENABLED!=='true')throw new ApiError(503,'federation_misconfigured');
 let origin:URL,metadata:URL;
 try {origin=new URL(env.AUTH_ORIGIN);metadata=new URL(env.MCP_RESOURCE_METADATA_URL??'');}
 catch {throw new ApiError(503,'federation_misconfigured');}
 if(origin.protocol!=='https:'||origin.origin!==env.AUTH_ORIGIN||origin.username||origin.password
   ||!validAccessIssuer(env.MCP_ACCESS_ISSUER)||!env.MCP_ACCESS_AUDIENCE||!/^[a-f0-9]{64}$/.test(env.MCP_ACCESS_AUDIENCE)
   ||metadata.origin!==origin.origin||!metadata.pathname.startsWith('/.well-known/')||metadata.href.length>2048
   ||metadata.search||metadata.hash||metadata.username||metadata.password)
  throw new ApiError(503,'federation_misconfigured');
 return {origin:origin.origin,issuer:env.MCP_ACCESS_ISSUER,audience:env.MCP_ACCESS_AUDIENCE,resourceMetadataUrl:metadata.href};
}

export interface McpConfig {origin:string;federationConfigured:boolean}
/** Application credentials work independently of optional external admission/identity providers. */
export function mcpConfig(env:FederationEnv):McpConfig|null {
 if(env.MCP_ENABLED===undefined||env.MCP_ENABLED==='false')return null;
 if(env.MCP_ENABLED!=='true')throw new ApiError(503,'mcp_misconfigured');
 let origin:URL;
 try{origin=new URL(env.AUTH_ORIGIN);}catch{throw new ApiError(503,'mcp_misconfigured');}
 if(origin.protocol!=='https:'||origin.origin!==env.AUTH_ORIGIN||origin.username||origin.password)throw new ApiError(503,'mcp_misconfigured');
 const configured=[env.MCP_ACCESS_ISSUER,env.MCP_ACCESS_AUDIENCE,env.MCP_RESOURCE_METADATA_URL].some(value=>value!==undefined);
 return{origin:origin.origin,federationConfigured:configured};
}
