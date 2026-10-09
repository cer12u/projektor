import { AuthError } from './auth.mjs';
const uuid='[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const routePattern=new RegExp(`^/(machine/)?v1/workspaces/(${uuid})/(.+)$`);
const resourcePattern=new RegExp(`^(issues|wiki|projects|operations)/(${uuid})(?:/(entries|revisions|claim|resolutions|checkpoint)(?:/(${uuid}))?)?$`);
export function route(request,config) {
 const url=new URL(request.url),match=url.pathname.match(routePattern);
 const legacy=url.pathname.match(new RegExp(`^/mcp/(${uuid})$`));
 if(legacy){
  if(!config.workspaces.includes(legacy[1]))throw new AuthError('NOT_FOUND',404);
  if(url.origin!==config.origin||request.headers.has('origin')&&request.headers.get('origin')!==config.origin)throw new AuthError('ORIGIN_REJECTED',403);
  if(request.method!=='POST')throw new AuthError('METHOD_NOT_ALLOWED',405);
  if([...url.searchParams.keys()].some(k=>k!=='domains'||url.searchParams.getAll(k).length!==1)||url.search.length>1024)throw new AuthError('VALIDATION',400);
  return {url,action:'legacyMCP',kind:'machine',workspaceId:legacy[1]};
 }
 if(!match)throw new AuthError('NOT_FOUND',404);
 if(!config.workspaces.includes(match[2]))throw new AuthError('NOT_FOUND',404);
 if(url.origin!==config.origin)throw new AuthError('ORIGIN_REJECTED',403);
 const tail=match[3],resource=tail.match(resourcePattern),alias=tail.match(new RegExp(`^projects/(${uuid})/issues/([1-9][0-9]{0,14})$`));
 let action,entityId,operationId,revisionId;
 if(!match[1]&&['session','draft-keys'].includes(tail))action=tail==='session'?'session':'draftKey';
 else if(alias)action='alias';
 else if(tail==='commands')action='command';
 else if(tail==='mcp'&&match[1])action='mcp';
 else if(tail==='wiki')action='wiki';
 else if(tail==='wiki/resolve')action='wikiResolve';
 else if(tail==='links')action='links';
 else if(tail==='backlinks')action='backlinks';
 else if(tail==='legacy-url')action='legacyUrl';
 else if(tail==='my-issues')action='myIssues';
 else if(tail==='capabilities')action='capabilities';
 else if(tail==='projects')action='projects';
 else if(resource){
  const [,type,id,subresource,revision]=resource;
  if(!['issues','wiki'].includes(type)&&subresource||type==='wiki'&&subresource&&subresource!=='revisions'||['entries','claim','resolutions','checkpoint'].includes(subresource)&&revision)throw new AuthError('NOT_FOUND',404);
  action=type==='wiki'?(subresource==='revisions'?'wikiRevisions':'wiki'):type==='operations'?'receipt':type==='projects'?'projects':subresource==='entries'?'entries':subresource==='revisions'?'revisions':subresource==='claim'?'claim':subresource==='resolutions'?'resolutions':subresource==='checkpoint'?'checkpoint':'issue';
  if(action==='receipt')operationId=id;else entityId=id;
  revisionId=revision;
 }else throw new AuthError('NOT_FOUND',404);
 if(action!=='mcp'&&request.method!==(['command','draftKey'].includes(action)?'POST':'GET'))throw new AuthError('METHOD_NOT_ALLOWED',405);
 if(action==='mcp'&&request.headers.has('origin')&&request.headers.get('origin')!==config.origin)throw new AuthError('ORIGIN_REJECTED',403);
 const kind=match[1]?'machine':'human';
 if(['command','session','draftKey','mcp'].includes(action)&&url.search)throw new AuthError('VALIDATION',400);
 if(['command','draftKey'].includes(action)&&kind==='human'&&(request.headers.get('origin')!==config.origin||request.headers.get('x-projektor-csrf')!=='same-origin'||(request.headers.has('sec-fetch-site')&&request.headers.get('sec-fetch-site')!=='same-origin')))throw new AuthError('CSRF_REJECTED',403);
 return {url,action,kind,workspaceId:match[2],entityId,operationId,revisionId,...(alias?{projectId:alias[1],number:Number(alias[2])}:{})};
}
export function response(body,status=200){return Response.json(body,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}});}
export function error(code,status=503){return response({error:{code,outcome:'unknown',retryable:status===503}},status);}
export function failureResponse(e){return error(e instanceof AuthError||e?.code==='SERVICE_CONFIG_INVALID'?e.code:'TRANSPORT_UNKNOWN',e instanceof AuthError||e?.code==='SERVICE_CONFIG_INVALID'?e.status:503);}
export function resultResponse(result,kind){
 if(new TextEncoder().encode(JSON.stringify(result)).byteLength>2*1024*1024)return error('RESPONSE_TOO_LARGE');
 let code=result.error?.code;
 if(code==='EXPIRED')return error(kind==='machine'?'CREDENTIAL_EXPIRED':'SESSION_EXPIRED',401);
 const status=!code?200:code==='UNAUTHENTICATED'?401:code==='PRECONDITION_REQUIRED'?428:['FORBIDDEN','COMMENT_FORBIDDEN','WORKSPACE_MISMATCH'].includes(code)?403:['NOT_FOUND','PROJECT_NOT_FOUND'].includes(code)?404:['POLICY_STATE_INCOMPLETE','VERSION_LIMIT_REACHED','POLICY_VERSION_CONFLICT','POLICY_MIGRATION_REQUIRED','VERSION_CONFLICT','KEY_REUSE','EPOCH_MISMATCH','ENTITY_EXISTS','COMMENT_EXISTS','CLAIM_HELD','CLAIM_STALE','ATTEMPT_REUSED','ENTRY_EXISTS','RENEW_TOO_EARLY'].includes(code)?409:['UNAVAILABLE','STORE_FENCED','STORE_UNINITIALIZED','STORE_SCHEMA_UNSUPPORTED'].includes(code)?503:400;
 return response(result,status);
}
export async function body(request,deadlineMs,parse=JSON.parse,maxBytes=2*1024*1024){
 if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')throw new AuthError('CONTENT_TYPE',415);
 const reader=request.body?.getReader();if(!reader)throw new AuthError('VALIDATION',400);
 const chunks=[];let size=0,timer;
 const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{reject(new AuthError('BODY_TIMEOUT',408));void reader.cancel().catch(()=>{});},deadlineMs);});
 try{while(true){const {done,value}=await Promise.race([reader.read(),deadline]);if(done)break;size+=value.length;if(size>maxBytes){void reader.cancel().catch(()=>{});throw new AuthError('BODY_TOO_LARGE',413);}chunks.push(value);}}finally{clearTimeout(timer);reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 let parsed;try{parsed=parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new AuthError('VALIDATION',400);}
 // Preserve the original title-only envelope budget; content commands need room
 // for up to 256 KiB of source Markdown plus worst-case JSON escaping.
 if(size>16384&&parsed?.commandType==='Issue.UpdateTitle')throw new AuthError('BODY_TOO_LARGE',413);
 return parsed;
}
export function queryArgs(r){
 const p=r.url.searchParams,wikiAllowed={wiki:['workspaceEpoch','scopeKind','projectId','search','includeDeleted','limit','cursor'],wikiRevisions:['workspaceEpoch','limit','cursor'],wikiResolve:['workspaceEpoch','scopeKind','projectId','kind','rawKey'],links:['workspaceEpoch','resourceType','resourceId','revisionId','linkViewId','resourceVersion','limit','cursor'],backlinks:['workspaceEpoch','resourceType','resourceId','limit','cursor']},allowed=wikiAllowed[r.action]??(r.action==='legacyUrl'?['workspaceEpoch','path']:r.action==='myIssues'?['workspaceEpoch','status','projectId','limit','cursor']:['entries','revisions','resolutions'].includes(r.action)?['workspaceEpoch','cursor','limit']:['workspaceEpoch']);
 if([...p.keys()].some(k=>!allowed.includes(k)||p.getAll(k).length!==1)||!p.has('workspaceEpoch'))throw new AuthError('VALIDATION',400);
 const args={workspaceId:r.workspaceId,...Object.fromEntries(p)};
 if(args.limit!==undefined){if(!/^[1-9][0-9]{0,2}$/.test(args.limit))throw new AuthError('VALIDATION',400);args.limit=Number(args.limit);}
 if(wikiAllowed[r.action]){if(args.scopeKind!==undefined){args.scope=args.scopeKind==='workspace_shared'?{kind:'workspace_shared'}:args.scopeKind==='project'?{kind:'project',projectId:args.projectId}:null;if(!args.scope)throw new AuthError('VALIDATION',400);delete args.scopeKind;delete args.projectId;}else if(args.projectId!==undefined)throw new AuthError('VALIDATION',400);if(args.includeDeleted!==undefined){if(!['true','false'].includes(args.includeDeleted))throw new AuthError('VALIDATION',400);args.includeDeleted=args.includeDeleted==='true';}if(args.resourceType!==undefined||args.resourceId!==undefined){args.resource={type:args.resourceType,id:args.resourceId};delete args.resourceType;delete args.resourceId;}if(args.resourceVersion!==undefined){if(!/^[1-9][0-9]*$/.test(args.resourceVersion))throw new AuthError('VALIDATION',400);args.resourceVersion=Number(args.resourceVersion);}}
 if(r.action==='alias'){args.projectId=r.projectId;args.number=r.number;}
 if(r.entityId)args.entityId=r.entityId;if(r.revisionId)args.revisionId=r.revisionId;if(r.operationId)args.operationId=r.operationId;return args;
}
