// @module delivery
// @role http-adapter
import {resultFailureBody,protocolFailure,changeValue,readValue,resultValue} from "./outcomes";
import type {RequestServices} from "../contracts";
import {requireOrigin,requireCsrf} from "./security";
import {decodeExecutionCommand,type ExecutionAction} from "../../modules/execution/public";
import { ApiError } from "../../adapters/protocol-errors";
import { jsonInput } from "./input";
import { MutationError } from "../../adapters/d1/persistence/public";
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
export async function issueExecutionApi(request:Request,requests:RequestServices,origin:string):Promise<Response|null> {
  const url=new URL(request.url),route=url.pathname.match(/^\/api\/projects\/([^/]+)\/(?:issues\/([^/]+)\/execution(?:\/(acquire|renew|end|interrupt))?|execution-operations\/([^/]+))$/);
  if(!route)return null;
 const resultOperationId=request.method==='GET'?route[4]:undefined;
 const failureJson=(body:Record<string,unknown>,status=200)=>json(resultFailureBody(body,resultOperationId),status);
  try{
    const projectId=route[1],issueId=route[2],action=route[3] as ExecutionAction|undefined,operationId=route[4];
    if(url.search)throw new ApiError(400,'invalid_input',{query:'no query parameters'});
    const services=await requests.authenticate(request);
    if(operationId)return request.method==='GET'?json(await resultValue(services.execution.result({projectId,operationId}),undefined,resultOperationId)):json({error:'method_not_allowed'},405);
    if(!action)return request.method==='GET'?json({execution:await readValue(services.execution.current({projectId,issueId}))}):json({error:'method_not_allowed'},405);
    if(request.method!=='POST')return json({error:'method_not_allowed'},405);
    if(services.actor.authentication==='session'){requireOrigin(request,origin);requireCsrf(request,{csrf_token:services.actor.csrf_token});}
    return json(await changeValue(services.execution.change(decodeExecutionCommand({projectId,issueId},action,await jsonInput(request,4096)))));
  }catch(error){
    const protocol=protocolFailure(error);if(protocol){const response=failureJson(protocol.body,protocol.status);if(protocol.status===429||protocol.status===503)response.headers.set('Retry-After',protocol.status===429?'900':'1');return response;}
    if(error instanceof ApiError)return failureJson({error:error.code,...(error.fields?{fields:error.fields}:{})},error.status);
    if(error instanceof MutationError)return failureJson({error:error.code,...(error.reason?{reason:error.reason}:{}),...(error.current!==undefined?{current:error.current}:{})},error.status);
    return failureJson({error:'execution_unavailable'},503);
  }
}
