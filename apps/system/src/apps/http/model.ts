// @module delivery
// @role http-adapter
import {readValue} from "./outcomes";
import {decodeLegacyReference} from "../../modules/work/public";
import type {RequestServices} from "../contracts";
import { ApiError } from "../../adapters/protocol-errors";
const json=(body:unknown)=>Response.json(body,{headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
export async function modelApi(request:Request,requests:RequestServices):Promise<Response|null>{
 const url=new URL(request.url),source=url.pathname.match(/^\/api\/(projects|workspaces)\/([A-Za-z0-9_-]{1,128})\/source\/(issues|wiki_pages|issue_comments|projects)\/([A-Za-z0-9_-]{1,128})$/);
 if(!source&&!['/api/directory','/api/resolve'].includes(url.pathname))return null;
 if(request.method!=='GET')throw new ApiError(405,'method_not_allowed');
 const services=await requests.authenticate(request);
 if(source){
  for(const[k]of url.searchParams)if(k!=='page'||url.searchParams.getAll(k).length!==1)throw new ApiError(400,'invalid_query');
  return json(await readValue(services.work.importedSource({scopeId:(source[1]==='workspaces'?'workspace:':'')+source[2],kind:source[3] as 'issues'|'wiki_pages'|'issue_comments'|'projects',id:source[4],page:Number(url.searchParams.get('page')??1)})));
 }
 if(url.pathname==='/api/directory'){
  if(url.searchParams.size)throw new ApiError(400,'invalid_query');
  return json(await readValue(services.work.directory()));
 }
 if(url.searchParams.size!==1||url.searchParams.getAll('path').length!==1)throw new ApiError(400,'invalid_query');
 return json(await readValue(services.work.resolveLegacy(decodeLegacyReference(url.searchParams.get('path')!))));
}
