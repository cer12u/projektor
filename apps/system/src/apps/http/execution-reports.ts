// @module delivery
// @role http-adapter
import {resultFailureBody,protocolFailure,changeValue,readValue,resultValue} from "./outcomes";
import type {RequestServices} from "../contracts";
import {requireOrigin,requireCsrf} from "./security";
import {decodeReportCommand,type ReportAction} from "../../modules/execution/public";
import { ApiError } from "../../adapters/protocol-errors";
import { jsonInput } from "./input";
import { MutationError } from "../../adapters/d1/persistence/public";
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
export async function executionReportsApi(request:Request,requests:RequestServices,origin:string):Promise<Response|null> {
  const url=new URL(request.url),route=url.pathname.match(/^\/api\/projects\/([^/]+)\/(?:issues\/([^/]+)\/execution-reports(?:\/(progress|failed|completed|reconcile|restart|history))?|execution-report-operations\/([^/]+))$/);
  if(!route)return null;
 const resultOperationId=request.method==='GET'?route[4]:undefined;
 const failureJson=(body:Record<string,unknown>,status=200)=>json(resultFailureBody(body,resultOperationId),status);
  try{
    const project=route[1],issue=route[2],action=route[3],op=route[4];
    if(action==='history'){
      if([...url.searchParams.keys()].some(k=>k!=='after')||url.searchParams.getAll('after').length>1||
        (url.searchParams.has('after')&&!/^(0|[1-9][0-9]*)$/.test(url.searchParams.get('after')!)))throw new ApiError(400,'invalid_input',{query:'only after >=0'});
    }else if(url.search)throw new ApiError(400,'invalid_input',{query:'no query parameters'});
    const services=await requests.authenticate(request);
    if(op)return request.method==='GET'?json(await resultValue(services.execution.reportResult({projectId:project,operationId:op}),undefined,resultOperationId)):json({error:'method_not_allowed'},405);
    if(!action)return request.method==='GET'?json(await readValue(services.execution.reports({projectId:project,issueId:issue}))):json({error:'method_not_allowed'},405);
    if(action==='history')return request.method==='GET'?json(await readValue(services.execution.reportHistory({projectId:project,issueId:issue,after:Number(url.searchParams.get('after')??'0')}))):json({error:'method_not_allowed'},405);
    if(request.method!=='POST')return json({error:'method_not_allowed'},405);
    if(services.actor.authentication==='session'){requireOrigin(request,origin);requireCsrf(request,{csrf_token:services.actor.csrf_token});}
    return json(await changeValue(services.execution.report(decodeReportCommand({projectId:project,issueId:issue},action as ReportAction,await jsonInput(request,16384)))));
  }catch(error){
    const protocol=protocolFailure(error);if(protocol){const response=failureJson(protocol.body,protocol.status);if(protocol.status===429||protocol.status===503)response.headers.set('Retry-After',protocol.status===429?'900':'1');return response;}
    if(error instanceof ApiError)return failureJson({error:error.code,...(error.fields?{fields:error.fields}:{})},error.status);
    if(error instanceof MutationError)return failureJson({error:error.code,...(error.reason?{reason:error.reason}:{}),...(error.current!==undefined?{current:error.current}:{})},error.status);
    return failureJson({error:'execution_reports_unavailable'},503);
  }
}
