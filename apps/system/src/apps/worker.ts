// @module composition
// @role server-composition
import {recipientSetupApi} from "./http/recipient-setup";
import {LOGIN_POLICY} from "../modules/identity/public";
import {protocolFailure,resultFailureBody} from "./http/outcomes";
import {resultLookupOperationId,preparedExecuteOperationId} from "./http/result-route";
import {createRequestServices} from "./composition";
import { authApi } from "./http/auth";
import { browserExchangeApi } from "./http/browser-exchange";
import { contentApi } from "./http/content";
import { ApiError } from "../adapters/protocol-errors";
import { executionReportsApi } from "./http/execution-reports";
import { issueApi } from "./http/issue";
import { issueExecutionApi } from "./http/issue-execution";
import { managementApi } from "./http/management";
import { isMcpPath,mcpApi } from "./mcp/handler";
import { modelApi } from "./http/model";
import { operationIntentsApi } from "./http/operation-intents";
import { ownerInitialSetupApi } from "./http/owner-initial-setup";
import { passwordSetupApi } from "./http/password-setup";
import { projectAccessApi } from "./http/project-access";
import { readDatabaseHealth,readRequestGate } from "../adapters/d1/runtime";
export { RateLimiter,WorkspaceHub } from "../adapters/cloudflare/retained-namespaces";
function json(value: unknown, status=200): Response {
  return Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    const resultOperationId=request.method==='GET'?resultLookupOperationId(path):request.method==='POST'?preparedExecuteOperationId(path):undefined;
    const failureJson=(body:Record<string,unknown>,status:number)=>json(resultFailureBody(body,resultOperationId),status);
    if (isMcpPath(path)) return mcpApi(request,createRequestServices(env.DB.withSession('first-primary'),Math.floor(Date.now()/1000)),env);
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);
    const now=Math.floor(Date.now()/1000), db=env.DB.withSession('first-primary'),requests=createRequestServices(db,now);
    try {
      if(path==='/api/health'&&request.method==='GET'){ await readDatabaseHealth(db); return json({phase:'P1a',database:'ok'}); }
      const authentication=await authApi(request,requests,env.AUTH_ORIGIN);if(authentication)return authentication;
      const ownerInitial=await ownerInitialSetupApi(request,requests,env.AUTH_ORIGIN);if(ownerInitial)return ownerInitial;
      const setup=await passwordSetupApi(request,requests,env.AUTH_ORIGIN);if(setup)return setup;
      const exchange=await browserExchangeApi(request,requests,env.AUTH_ORIGIN);if(exchange)return exchange;
      if(!path.startsWith('/api/auth/')&&!path.startsWith('/api/password-setup')&&!path.startsWith('/api/browser-exchange')){if(await readRequestGate(db)==='importing')throw new ApiError(503,'import_in_progress');}
      const operations=await operationIntentsApi(request,requests,env.AUTH_ORIGIN);if(operations)return operations;
      const model=await modelApi(request,requests);if(model)return model;
      const recipient=await recipientSetupApi(request,requests,env.AUTH_ORIGIN);if(recipient)return recipient;
      const content=await contentApi(request,requests,env.AUTH_ORIGIN);if(content)return content;
      const execution=await issueExecutionApi(request,requests,env.AUTH_ORIGIN);if(execution)return execution;
      const reports=await executionReportsApi(request,requests,env.AUTH_ORIGIN);if(reports)return reports;
      const issue=await issueApi(request,requests,env.AUTH_ORIGIN);if(issue)return issue;
      const management=await managementApi(request,requests,env.AUTH_ORIGIN);if(management)return management;
      const access=await projectAccessApi(request,requests);if(access)return access;
      return json({error:'not_found'},404);
    } catch(error) {
    const protocol=protocolFailure(error);if(protocol){const response=failureJson(protocol.body,protocol.status);if(protocol.status===429||protocol.status===503)response.headers.set('Retry-After',protocol.status===429?String(LOGIN_POLICY.windowSeconds):'1');return response;}
      if(error instanceof ApiError){const response=failureJson({error:error.code,...(error.fields?{fields:error.fields}:{})},error.status);if(error.status===429||error.status===503)response.headers.set('Retry-After',error.status===429?String(LOGIN_POLICY.windowSeconds):'1');return response;}
      // Never log request headers, bodies, credential values or raw D1 parameters.
      console.error(JSON.stringify({phase:'P1a',event:'request_failed'}));return failureJson({error:'temporarily_unavailable'},503);
    }
  }
} satisfies ExportedHandler<Env>;
