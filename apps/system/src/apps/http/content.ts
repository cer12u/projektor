// @module delivery
// @role http-adapter
import {resultFailureBody,protocolFailure,changeValue,readValue,resultValue} from "./outcomes";
import type {RequestServices} from "../contracts";
import {requireOrigin,requireCsrf} from "./security";
import {contentPage} from "./query";
import {decodeContentChange,type ContentResource} from "../../modules/work/public";
import { ApiError } from "../../adapters/protocol-errors";
import { jsonInput } from "./input";
import { MutationError } from "../../adapters/d1/persistence/public";
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
export async function contentApi(request:Request,requests:RequestServices,origin:string):Promise<Response|null>{
 const original=new URL(request.url),workspace=original.pathname.match(/^\/api\/workspaces\/([a-fA-F0-9-]{36})\/((?:wikis|wiki-operations)(?:\/.*)?)$/);
 if(workspace){original.pathname='/api/projects/workspace:'+workspace[1]+'/'+workspace[2];request=new Request(original,request);}
 const url=new URL(request.url),wiki=url.pathname.match(/^\/api\/projects\/([^/]+)\/(wikis(?:\/([^/]+)(?:\/(history))?)?|wiki-operations\/([^/]+))$/),comment=url.pathname.match(/^\/api\/projects\/([^/]+)\/(issues|wikis)\/([^/]+)\/(comments(?:\/([^/]+)(?:\/(history))?)?|comment-operations\/([^/]+))$/);
 if(!wiki&&!comment)return null;
 const project=(wiki??comment)![1],resource:ContentResource=comment?{kind:'comment',parentKind:comment[2]==='issues'?'issue':'wiki',parentId:comment[3]}:{kind:'wiki'},id=comment?comment[5]:wiki![3],history=comment?comment[6]:wiki![4],operation=comment?comment[7]:wiki![5];
 const resultOperationId=request.method==='GET'?operation:undefined;
 const failureJson=(body:Record<string,unknown>,status=200)=>json(resultFailureBody(body,resultOperationId),status);
 try{
  const services=await requests.authenticate(request);
  if(operation&&request.method==='GET')return json(await resultValue(services.work.contentResult({projectId:project,resource,operationId:operation}),undefined,resultOperationId));
  if(request.method==='GET'){
   if(history){for(const[k]of url.searchParams)if(!['afterRevision','limit'].includes(k)||url.searchParams.getAll(k).length!==1)throw new ApiError(400,'invalid_input',{query:'unknown or repeated query'});const after=url.searchParams.get('afterRevision')??'0',limit=url.searchParams.get('limit')??'20';if(!/^(0|[1-9][0-9]*)$/.test(after)||! /^[1-9][0-9]*$/.test(limit))throw new ApiError(400,'invalid_input',{query:'invalid history cursor'});return json(await readValue(services.work.contentHistory({projectId:project,resource,id,afterRevision:Number(after),limit:Number(limit)})));}
   if(id)return json({document:await readValue(services.work.getContent({projectId:project,resource,id}))});
   const page=contentPage(url.searchParams);return json(await readValue(services.work.listContent({projectId:project,resource,...page})));
  }
  if(operation||history||request.method!==(id?'PATCH':'POST'))return json({error:'method_not_allowed'},405);
  if(services.actor.authentication==='session'){requireOrigin(request,origin);requireCsrf(request,{csrf_token:services.actor.csrf_token});}
  return json(await changeValue(services.work.changeContent(decodeContentChange(project,resource,id,await jsonInput(request,resource.kind==='wiki'?65536:32768)))));
 }catch(e){
    const protocol=protocolFailure(e);if(protocol){const response=failureJson(protocol.body,protocol.status);if(protocol.status===429||protocol.status===503)response.headers.set('Retry-After',protocol.status===429?'900':'1');return response;}if(e instanceof ApiError)return failureJson({error:e.code,...(e.fields?{fields:e.fields}:{})},e.status);if(e instanceof MutationError)return failureJson({error:e.code,...(e.reason?{reason:e.reason}:{}),...(e.current!==undefined?{current:e.current}:{})},e.status);return failureJson({error:'content_unavailable'},503);}
}
