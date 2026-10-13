// @module delivery
// @role http-adapter
import {resultFailureBody,protocolFailure,changeValue,readValue,resultValue} from "./outcomes";
import {decodeIssueChange} from "../../modules/work/public";
import type {RequestServices} from "../contracts";
import {requireOrigin,requireCsrf} from "./security";
import {listQuery} from "./query";
import { ApiError } from "../../adapters/protocol-errors";
import { jsonInput } from "./input";
import { MutationError } from "../../adapters/d1/persistence/public";
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
export async function issueApi(request:Request,requests:RequestServices,origin:string):Promise<Response|null> {
  const url=new URL(request.url),route=url.pathname.match(/^\/api\/projects\/([^/]+)\/(issues(?:\/([^/]+)(?:\/(history))?)?|issue-operations\/([^/]+)|assignees)$/);
  if(!route)return null;
 const resultOperationId=request.method==='GET'?route[5]:undefined;
 const failureJson=(body:Record<string,unknown>,status=200)=>json(resultFailureBody(body,resultOperationId),status);
  try{
    const projectId=route[1],issueId=route[3],history=route[4],operationId=route[5];
    const services=await requests.authenticate(request);
    if(url.pathname.endsWith('/assignees'))return request.method==='GET'?json(await readValue(services.work.listAssignees({projectId}))):json({error:'method_not_allowed'},405);
    if(!issueId&&!operationId&&request.method==='GET')return json(await readValue(services.work.listIssues({projectId,query:listQuery(url.searchParams)})));
    if(operationId&&request.method==='GET')return json(await resultValue(services.work.issueResult({projectId,operationId}),undefined,resultOperationId));
    if(issueId&&request.method==='GET'){
      if(history){
        const fields:Record<string,string>={};
        for(const [key]of url.searchParams)if(!['afterRevision','limit'].includes(key)||url.searchParams.getAll(key).length!==1)fields.query='unknown or repeated query';
        const after=url.searchParams.get('afterRevision')??'0',limit=url.searchParams.get('limit')??'20';
        if(!/^(0|[1-9][0-9]*)$/.test(after))fields.afterRevision='nonnegative integer';
        if(!/^[1-9][0-9]*$/.test(limit))fields.limit='integer 1–50';
        if(Object.keys(fields).length)throw new ApiError(400,'invalid_input',fields);
        return json(await readValue(services.work.getIssueHistory({projectId,issueId,afterRevision:Number(after),limit:Number(limit)})));
      }
      return json({issue:await readValue(services.work.getIssue({projectId,issueId}))});
    }
    if(operationId||history||!(issueId?request.method==='PATCH':request.method==='POST'))return json({error:'method_not_allowed'},405);
    if(services.actor.authentication==='session'){requireOrigin(request,origin);requireCsrf(request,{csrf_token:services.actor.csrf_token});}
    return json(await changeValue(services.work.changeIssue(decodeIssueChange(projectId,issueId,await jsonInput(request)))));
  }catch(error){
    const protocol=protocolFailure(error);if(protocol){const response=failureJson(protocol.body,protocol.status);if(protocol.status===429||protocol.status===503)response.headers.set('Retry-After',protocol.status===429?'900':'1');return response;}
    if(error instanceof ApiError)return failureJson({error:error.code,...(error.fields?{fields:error.fields}:{})},error.status);
    if(error instanceof MutationError)return failureJson({error:error.code,...(error.reason?{reason:error.reason}:{}),...(error.current!==undefined?{current:error.current}:{}),...(error.mutationOutcome?{mutationOutcome:error.mutationOutcome}:{})},error.status);
    return failureJson({error:'issues_unavailable'},503);
  }
}
