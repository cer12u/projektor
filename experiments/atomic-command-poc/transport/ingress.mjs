import { authenticate, AuthError } from './auth.mjs';
import { validate } from '../src/shared-core.mjs';
export { AuthenticatedWorkspace } from './workspace.mjs';
const uuid='[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const commandRoute=new RegExp(`^/(machine/)?v1/workspaces/(${uuid})/commands$`);
const issueRoute=new RegExp(`^/(machine/)?v1/workspaces/(${uuid})/issues/(${uuid})$`);
const receiptRoute=new RegExp(`^/(machine/)?v1/workspaces/(${uuid})/operations/(${uuid})$`);
function response(body,status=200) {return Response.json(body,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});}
function error(code,status) {return response({error:{code,outcome:'unknown',retryable:status===503}},status);}
function status(result) {
 const c=result.error?.code;
 if(!c)return 200;
 if(['UNAUTHENTICATED','EXPIRED'].includes(c))return 401;
 if(c==='PRECONDITION_REQUIRED')return 428;
 if(c==='FORBIDDEN')return 403;
 if(c==='NOT_FOUND')return 404;
 if(['VERSION_CONFLICT','KEY_REUSE','EPOCH_MISMATCH'].includes(c))return 409;
 if(['UNAVAILABLE','STORE_FENCED'].includes(c))return 503;
 return 400;
}
export async function body(request, deadlineMs=3000) {
 if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')throw new AuthError('CONTENT_TYPE',415);
 const reader=request.body?.getReader();if(!reader)throw new AuthError('VALIDATION',400);
 const chunks=[];let size=0,timer,timedOut=false;
 const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{timedOut=true;reject(new AuthError('BODY_TIMEOUT',408));void reader.cancel().catch(()=>{});},deadlineMs);});
 try {while(true){const {done,value}=await Promise.race([reader.read(),deadline]);if(timedOut)throw new AuthError('BODY_TIMEOUT',408);if(done)break;size+=value.length;if(size>16384){void reader.cancel().catch(()=>{});throw new AuthError('BODY_TOO_LARGE',413);}chunks.push(value);}}
 finally{clearTimeout(timer);reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new AuthError('VALIDATION',400);}
}
export default {async fetch(request,env) {
 try {
  const url=new URL(request.url),command=url.pathname.match(commandRoute),receipt=url.pathname.match(receiptRoute),issue=url.pathname.match(issueRoute);
  if(!command&&!receipt&&!issue)return error('NOT_FOUND',404);
  if((command&&request.method!=='POST')||((receipt||issue)&&request.method!=='GET'))return error('METHOD_NOT_ALLOWED',405);
  const route=command||receipt||issue,kind=route[1]?'machine':'human';
  const verified=await authenticate(request,env,kind);
  if(verified.workspaceId!==route[2])return error('WORKSPACE_MISMATCH',403);
  if(command&&kind==='human'&&(url.origin!==env.TEST_ORIGIN||request.headers.get('origin')!==env.TEST_ORIGIN||request.headers.get('x-projektor-csrf')!=='same-origin'))return error('CSRF_REJECTED',403);
  let result;
  const stub=env.WORKSPACE.getByName(route[2]);
  if(command){
   const c=await body(request);
   const invalid=validate(c);if(invalid)return error(invalid,invalid==='PRECONDITION_REQUIRED'?428:400);
   if(c.workspaceId!==route[2]||request.headers.get('idempotency-key')!==c.operationId)return error('ENVELOPE_MISMATCH',400);
   result=await stub.command(verified,c);
  } else {
   if([...url.searchParams.keys()].some(k=>k!=='workspaceEpoch')||url.searchParams.getAll('workspaceEpoch').length!==1)return error('VALIDATION',400);
   const args={workspaceId:route[2],workspaceEpoch:url.searchParams.get('workspaceEpoch')};
   result=issue?await stub.issue(verified,{...args,entityId:route[3]}):await stub.receipt(verified,{...args,operationId:route[3]});
  }
  if(result.error?.code==='EXPIRED')return error(kind==='machine'?'CREDENTIAL_EXPIRED':'SESSION_EXPIRED',401);
  return response(result,status(result));
 } catch(e) {
  if(e instanceof AuthError)return error(e.code,e.status);
  return error('TRANSPORT_UNKNOWN',503);
 }
}};
