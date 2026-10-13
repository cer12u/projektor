// @module delivery
// @role http-adapter
import {protocolFailure,resultFailureBody} from "./outcomes";
import type {RequestServices} from "../contracts";
import {requireOrigin,requireCsrf} from "./security";
/** REST is a transport adapter only: the shared service owns parsing, policy,
 * durable input, receipt-first execution and SQL-time permission/revocation guards. */
import {ApiError} from "../../adapters/protocol-errors";
import {jsonInput} from "./input";
import {MutationError} from "../../adapters/d1/persistence/public";
import {operationRequestHash} from "../../modules/operation-protocol";
import type {OperationPreparation} from "../../modules/prepared-operations";
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
function listInput(query:URLSearchParams):{after?:number;limit?:number}{
 const value:{after?:number;limit?:number}={};
 for(const [name,text]of query){
  if((name!=='after'&&name!=='limit')||query.getAll(name).length!==1||!/^(0|[1-9][0-9]*)$/.test(text))throw new ApiError(400,'invalid_input',{query:'one bounded after/limit value required'});
  const n=Number(text);if(!Number.isSafeInteger(n)||(name==='limit'&&(n<1||n>50)))throw new ApiError(400,'invalid_input',{query:'after >= 0; limit 1–50'});value[name]=n;
 }
 return value;
}
export async function operationIntentsApi(request:Request,requests:RequestServices,origin:string):Promise<Response|null>{
 const url=new URL(request.url),match=url.pathname.match(/^\/api\/agent\/operations(?:\/([A-Za-z0-9_-]{1,128})(?:\/(execute))?)?$/);
 if(!match)return null;
 try{
  const [,operationId,execute]=match,method=request.method;
  if(!(operationId?(execute?method==='POST':method==='GET'):(method==='GET'||method==='POST')))return json({error:'method_not_allowed'},405);
  if((operationId||method==='POST')&&url.search)throw new ApiError(400,'invalid_input',{query:'no query parameters'});
  const services=await requests.authenticate(request);
  if(method==='GET')return json(operationId?await services.operations.get(operationId):await services.operations.list(listInput(url.searchParams)));
  if(services.actor.authentication==='session'){requireOrigin(request,origin);requireCsrf(request,{csrf_token:services.actor.csrf_token});}
  if(execute){const input=await jsonInput(request,1024);if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)throw new ApiError(400,'invalid_input',{body:'empty object required; prepared input is immutable'});return json((await services.operations.execute(operationId)).receipt);}
  const input=await jsonInput(request,73728) as OperationPreparation,requestHash=await operationRequestHash(input);
  return json({operation:await services.operations.prepare(services.operations.decodePreparation(input)),requestHash});
 }catch(error){
    const protocol=protocolFailure(error);if(protocol){const response=json(resultFailureBody(protocol.body,match[1]),protocol.status);if(protocol.status===429||protocol.status===503)response.headers.set('Retry-After',protocol.status===429?'900':'1');return response;}
  if(error instanceof ApiError)return json(resultFailureBody({error:error.code,...(error.fields?{fields:error.fields}:{})},match[1]),error.status);
  if(error instanceof MutationError)return json(resultFailureBody({error:error.code,...(error.reason?{reason:error.reason}:{}),...(error.current!==undefined?{current:error.current}:{}),...(error.mutationOutcome?{mutationOutcome:error.mutationOutcome}:{})},match[1]),error.status);
  return json(resultFailureBody({error:'operation_intents_unavailable'},match[1]),503);
 }
}
