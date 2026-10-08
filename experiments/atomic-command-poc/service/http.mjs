import { AuthError } from './auth.mjs';
const uuid='[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const routePattern=new RegExp(`^/(machine/)?v1/workspaces/(${uuid})/(commands|my-issues|issues/(${uuid})|operations/(${uuid}))$`);
export function route(request,config) {
 const url=new URL(request.url),match=url.pathname.match(routePattern);
 if(!match)throw new AuthError('NOT_FOUND',404);
 if(!config.workspaces.includes(match[2]))throw new AuthError('NOT_FOUND',404);
 if(url.origin!==config.origin)throw new AuthError('ORIGIN_REJECTED',403);
 const action=match[3]==='commands'?'command':match[3]==='my-issues'?'myIssues':match[4]?'issue':'receipt';
 if(request.method!==(action==='command'?'POST':'GET'))throw new AuthError('METHOD_NOT_ALLOWED',405);
 const kind=match[1]?'machine':'human';
 if(action==='command'&&url.search)throw new AuthError('VALIDATION',400);
 if(action==='command'&&kind==='human'&&(request.headers.get('origin')!==config.origin||request.headers.get('x-projektor-csrf')!=='same-origin'||(request.headers.has('sec-fetch-site')&&request.headers.get('sec-fetch-site')!=='same-origin')))throw new AuthError('CSRF_REJECTED',403);
 return {url,action,kind,workspaceId:match[2],entityId:match[4],operationId:match[5]};
}
export function response(body,status=200){return Response.json(body,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}});}
export function error(code,status=503){return response({error:{code,outcome:'unknown',retryable:status===503}},status);}
export function failureResponse(e){return error(e instanceof AuthError||e?.code==='SERVICE_CONFIG_INVALID'?e.code:'TRANSPORT_UNKNOWN',e instanceof AuthError||e?.code==='SERVICE_CONFIG_INVALID'?e.status:503);}
export function resultResponse(result,kind){
 let code=result.error?.code;
 if(code==='EXPIRED')return error(kind==='machine'?'CREDENTIAL_EXPIRED':'SESSION_EXPIRED',401);
 const status=!code?200:code==='UNAUTHENTICATED'?401:code==='PRECONDITION_REQUIRED'?428:['FORBIDDEN','WORKSPACE_MISMATCH'].includes(code)?403:code==='NOT_FOUND'?404:['VERSION_CONFLICT','KEY_REUSE','EPOCH_MISMATCH'].includes(code)?409:['UNAVAILABLE','STORE_FENCED','STORE_UNINITIALIZED','STORE_SCHEMA_UNSUPPORTED'].includes(code)?503:400;
 return response(result,status);
}
export async function body(request,deadlineMs){
 if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')throw new AuthError('CONTENT_TYPE',415);
 const reader=request.body?.getReader();if(!reader)throw new AuthError('VALIDATION',400);
 const chunks=[];let size=0,timer;
 const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{reject(new AuthError('BODY_TIMEOUT',408));void reader.cancel().catch(()=>{});},deadlineMs);});
 try{while(true){const {done,value}=await Promise.race([reader.read(),deadline]);if(done)break;size+=value.length;if(size>16384){void reader.cancel().catch(()=>{});throw new AuthError('BODY_TOO_LARGE',413);}chunks.push(value);}}finally{clearTimeout(timer);reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new AuthError('VALIDATION',400);}
}
export function queryArgs(r){
 const p=r.url.searchParams,allowed=r.action==='myIssues'?['workspaceEpoch','status','projectId','limit','cursor']:['workspaceEpoch'];
 if([...p.keys()].some(k=>!allowed.includes(k)||p.getAll(k).length!==1)||!p.has('workspaceEpoch'))throw new AuthError('VALIDATION',400);
 const args={workspaceId:r.workspaceId,...Object.fromEntries(p)};
 if(args.limit!==undefined){if(!/^[1-9][0-9]{0,2}$/.test(args.limit))throw new AuthError('VALIDATION',400);args.limit=Number(args.limit);}
 if(r.entityId)args.entityId=r.entityId;if(r.operationId)args.operationId=r.operationId;return args;
}
