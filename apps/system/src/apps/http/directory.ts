// @module delivery
// @role http-adapter
import {InputError} from '../../modules/change-outcomes';
import type {RequestServices} from '../contracts';
import {decodeDirectoryChange} from '../../modules/work/public';
import {changeValue,readValue,resultValue} from './outcomes';
import {requireOrigin,requireCsrf} from './security';
import {jsonInput} from './input';
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
export async function directoryApi(request:Request,requests:RequestServices,origin:string):Promise<Response|null>{
 const url=new URL(request.url),route=url.pathname.match(/^\/api\/(projects|workspaces)(?:\/([^/]+)(?:\/(history))?)?$/),result=url.pathname.match(/^\/api\/directory-operations\/([^/]+)$/);
 if(!route&&!result)return null;
 if(url.search&&!route?.[3])throw new InputError('invalid_query');
 const services=await requests.authenticate(request);
 if(result)return request.method==='GET'?json(await resultValue(services.work.directoryResult({operationId:result[1]}),undefined,result[1])):json({error:'method_not_allowed'},405);
 const kind=route![1]==='projects'?'project':'workspace',id=route![2],history=route![3];
 if(request.method==='GET'&&id){
  if(!history&&url.search)throw new InputError('invalid_query');
  for(const [key] of url.searchParams)if(!['afterRevision','limit'].includes(key)||url.searchParams.getAll(key).length!==1)throw new InputError('invalid_query');
  const after=url.searchParams.get('afterRevision')??'0',limit=url.searchParams.get('limit')??'20';
  if(!/^(0|[1-9][0-9]*)$/.test(after)||!/^[1-9][0-9]*$/.test(limit))throw new InputError('invalid_query');
  return json(history?await readValue(services.work.directoryHistory({kind,id,afterRevision:Number(after),limit:Number(limit)})):await readValue(services.work.directoryEntity({kind,id})));
 }
 if(history||!(id?request.method==='PATCH':request.method==='POST'))return json({error:'method_not_allowed'},405);
 if(services.actor.authentication==='session'){requireOrigin(request,origin);requireCsrf(request,{csrf_token:services.actor.csrf_token});}
 return json(await changeValue(services.work.changeDirectory(decodeDirectoryChange(kind,id,await jsonInput(request)))));
}
