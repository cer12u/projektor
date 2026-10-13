// @module delivery
// @role http-adapter
import {parseManagementCommand,parsePrincipalRegistration} from "../../modules/identity/public";
import {readValue,resultFailureBody,protocolFailure,changeValue,resultValue} from "./outcomes";
import type {RequestServices} from "../contracts";
import {requireOrigin,requireCsrf} from "./security";
import { ApiError } from "../../adapters/protocol-errors";
import { readJsonInput } from "./object-input";
import { MutationError } from "../../adapters/d1/persistence/public";

function json(body: unknown,status=200): Response {
  return Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
}
/** Management API. Explicit registration only; no administrator assignment or credential issuance. */
export async function managementApi(request: Request,requests:RequestServices,origin: string): Promise<Response|null> {
  const url=new URL(request.url),path=url.pathname,id='([A-Za-z0-9_-]{1,128})',scopeId='([A-Za-z0-9_-]{1,128}|workspace(?::|%3[Aa])[a-fA-F0-9-]{36})';
  const principal=path.match(new RegExp(`^/api/management/principals/${id}$`));
  const revoke=path.match(new RegExp(`^/api/management/credentials/${id}/revoke$`));
  const membership=path.match(new RegExp(`^/api/projects/${scopeId}/memberships/${id}$`));
  const scope=path.match(new RegExp(`^/api/projects/${scopeId}/credential-scopes/${id}$`));
  const result=path.match(new RegExp(`^/api/management/operations/${id}$`));
  const display=path.match(new RegExp(`^/api/projects/${scopeId}/principals/${id}/display$`));
  const context=path==='/api/management/context',collection=path==='/api/management/records',record=path.match(new RegExp(`^/api/management/records/${id}$`)),history=path==='/api/management/history',registration=path==='/api/management/principals';
  if(!principal&&!revoke&&!membership&&!scope&&!result&&!display&&!context&&!collection&&!record&&!history&&!registration)return null;
 const resultOperationId=request.method==='GET'?result?.[1]:undefined;
 const failureJson=(body:Record<string,unknown>,status=200)=>json(resultFailureBody(body,resultOperationId),status);
  try{
    const services=await requests.authenticate(request);
    if((context||collection||record||history)&&request.method==='GET'){
      const allowed=context?[]:history?['kind','targetId','projectId','after']:collection?['kind','projectId','after']:['kind','projectId'];
      if([...url.searchParams.keys()].some(key=>!allowed.includes(key)||url.searchParams.getAll(key).length!==1))throw new ApiError(400,'invalid_input',{query:'unknown or repeated parameter'});
      if(context)return json(await readValue(services.identity.managementContext()));
      const kind=url.searchParams.get('kind'),projectId=url.searchParams.get('projectId');
      if(collection)return json(await readValue(services.identity.managementList({kind,projectId,after:url.searchParams.get('after')})));
      if(record)return json({snapshot:await readValue(services.identity.managementRecord({kind,projectId,targetId:record[1]}))});
      return json(await readValue(services.identity.managementHistory({kind,projectId,targetId:url.searchParams.get('targetId')??'',after:url.searchParams.get('after')})));
    }
    if(registration&&request.method==='POST'){
      if(services.actor.authentication==='session'){requireOrigin(request,origin);requireCsrf(request,services.actor);}
      return json(await changeValue(services.identity.managementRegister(parsePrincipalRegistration(await readJsonInput(request)))));
    }
    if(result&&request.method==='GET')return json({snapshot:(await resultValue(services.identity.managementResult(result[1]),undefined,resultOperationId)).snapshot});
    if(display&&request.method==='GET')return json(await readValue(services.identity.displayPrincipal(decodeURIComponent(display[1]),display[2])));
    if(!(principal&&request.method==='PATCH')&&!(revoke&&request.method==='POST')
      &&!((membership||scope)&&request.method==='PUT'))return json({error:'method_not_allowed'},405);
    if(services.actor.authentication==='session'){requireOrigin(request,origin);requireCsrf(request,services.actor);}
    const body=await readJsonInput(request);
    const allowed=principal?['operationId','revision','displayName','active']:revoke?['operationId','revision']:['operationId','revision','permissions','createRelation'];
    if(Object.keys(body).some(key=>!allowed.includes(key)))throw new ApiError(400,'invalid_input',{body:'unknown fields'});
    const {operationId,...change}=body;
    const route=principal?{kind:'management.principal.update',targetId:principal[1],projectId:'GLOBAL'}
      :revoke?{kind:'management.credential.revoke',targetId:revoke[1],projectId:'GLOBAL'}
      :membership?{kind:'management.membership.set',targetId:membership[2],projectId:decodeURIComponent(membership[1])}
      :{kind:'management.credential.scope',targetId:scope![2],projectId:decodeURIComponent(scope![1])};
    const command={...route,operationId,input:change};
    return json(await changeValue(services.identity.managementExecute(parseManagementCommand(command))));
  }catch(error){
    const protocol=protocolFailure(error);if(protocol){const response=failureJson(protocol.body,protocol.status);if(protocol.status===429||protocol.status===503)response.headers.set('Retry-After',protocol.status===429?'900':'1');return response;}
    if(error instanceof ApiError)return failureJson({error:error.code,...(error.fields?{fields:error.fields}:{})},error.status);
    if(error instanceof MutationError)return failureJson({error:error.code,...(error.reason?{reason:error.reason}:{}),
      ...(error.current!==undefined?{current:error.current}:{})},error.status);
    return failureJson({error:'management_unavailable'},503);
  }
}
