// Adapter integration port. invokeStore is private, never a browser actor RPC.
// Production wiring MUST forward the original credential and independently verify
// it inside WorkspaceService; then call the server ports in its Store transaction.
import {SessionPortError,isId,validateBinding} from './server.mjs';
import {body} from '../service/http.mjs';
const reply=(value,status=200)=>Response.json(value,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff','vary':'Cookie, CF-Access-Jwt-Assertion'}});
const error=(code,status=503)=>reply({error:{code,outcome:'unknown',retryable:status===503}},status);
function directoryConfig(value){
 if(!Array.isArray(value)||value.length>10||value.some(x=>!x||Object.keys(x).some(k=>!['workspaceId','name'].includes(k))||!isId(x.workspaceId)||typeof x.name!=='string'||!x.name||x.name.length>200)||new Set(value.map(x=>x.workspaceId)).size!==value.length)throw new SessionPortError('WORKSPACE_DIRECTORY_UNAVAILABLE',503);
 return value;
}
export function createSessionHTTP({verify,invokeStore,directory,origin,now=Date.now,requestDeadlineMs=5000}){
 const handle=async request=>{
  try{
   const url=new URL(request.url),path=url.pathname;
   if(!['/v1/bootstrap','/v1/session','/v1/draft-keys'].includes(path))return error('NOT_FOUND',404);
   const method=path==='/v1/draft-keys'?'POST':'GET';
   if(request.method!==method)return error('METHOD_NOT_ALLOWED',405);
   if(url.origin!==origin)return error('ORIGIN_MISMATCH',403);
   if(method==='POST'&&(request.headers.get('origin')!==origin||request.headers.get('x-projektor-csrf')!=='same-origin'))return error('CSRF_REJECTED',403);
   const verified=await verify(request,'human');
   if(verified.actorKind!=='human'||!Number.isSafeInteger(verified.credentialExpiresAt)||verified.credentialExpiresAt<=now())return error('SESSION_EXPIRED',401);
   const entries=directoryConfig(directory);
   if(path==='/v1/bootstrap'){
    if(url.search)return error('VALIDATION',400);
    const workspaces=[];
    for(const candidate of entries){
     let session;
     try{session=await invokeStore({request,workspaceId:candidate.workspaceId,action:'session'});}
     catch(e){if(['UNAUTHENTICATED','FORBIDDEN','SESSION_EXPIRED'].includes(e.code))continue;throw e;}
     if(session.workspaceId!==candidate.workspaceId||!isId(session.principalId)||!isId(session.workspaceEpoch))throw new SessionPortError('STORE_BINDING_MISMATCH',503);
     workspaces.push({workspaceId:session.workspaceId,workspaceEpoch:session.workspaceEpoch,principalId:session.principalId,name:candidate.name});
    }
    const principals=[...new Set(workspaces.map(w=>w.principalId))];
    return reply({principalId:principals.length===1?principals[0]:null,actorKind:'human',workspaces,serverTime:now(),expiresAt:verified.credentialExpiresAt,renewalMode:'unknown',globalSessionExpiresAt:null});
   }
   if(path==='/v1/session'){
    if([...url.searchParams.keys()].some(k=>k!=='workspaceId')||url.searchParams.getAll('workspaceId').length!==1||!isId(url.searchParams.get('workspaceId')))return error('WORKSPACE_SELECTION_REQUIRED',400);
    const workspaceId=url.searchParams.get('workspaceId');
    if(!entries.some(x=>x.workspaceId===workspaceId))return error('WORKSPACE_NOT_CONFIGURED',404);
    return reply(await invokeStore({request,workspaceId,action:'session'}));
   }
   if(url.search)return error('VALIDATION',400);
   const args=await body(request,3000);
   if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['binding','keyId'].includes(k)))return error('VALIDATION',400);
   validateBinding(args.binding);
   if(!entries.some(x=>x.workspaceId===args.binding.workspaceId))return error('WORKSPACE_NOT_CONFIGURED',404);
   return reply(await invokeStore({request,workspaceId:args.binding.workspaceId,action:'draft-key',args}));
  }catch(e){return error(e.code??'SESSION_SERVICE_UNAVAILABLE',e.status??503);}
 };
 return async request=>{let timer;try{return await Promise.race([handle(request),new Promise(resolve=>{timer=setTimeout(()=>resolve(error('SESSION_REQUEST_TIMEOUT')),requestDeadlineMs);})]);}finally{clearTimeout(timer);}};
}
