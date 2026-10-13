// @module agent-sdk
// @role private-routes
/** Exact primary-client read/write route policy; no HTTP or credential access. */
import {validContentId} from "../modules/work/content-contracts";
import {businessOperationRoute,operationRouteAllowed} from "./operations";
export function clientRouteAllowed(path:string,method='GET',query=''){
 if(path==='/api/agent/operations'||path.startsWith('/api/agent/operations/'))return operationRouteAllowed(path,method,query);
 // Every business write must enter the durable operation adapter; no direct mutation fallback.
 if(method!=='GET')return !query&&(businessOperationRoute(path,method)!==undefined||(path==='/api/auth/browser-session/tickets'&&method==='POST'));
 // Execution routes are exact method/path/query contracts, never prefix grants.
 const execution=path.match(/^\/api\/projects\/[A-Za-z0-9_-]{1,128}\/(?:issues\/((?:I_[a-f0-9]{64}|[a-fA-F0-9-]{36}))\/(execution|execution-reports)(?:\/([^/]+))?|(execution-operations|execution-report-operations)\/([A-Za-z0-9_-]{1,128}))$/);
 if(execution){
  const [, issueId,domain,action,receipt]=execution;
  if(issueId&&!validContentId({kind:'issue'},issueId))return false;
  if(receipt)return method==='GET'&&!query;
  if(!action)return method==='GET'&&!query;
  if(domain==='execution')return false;
  if(action==='history'){const params=new URLSearchParams(query),after=params.get('after');return method==='GET'&&(!query||(params.size===1&&after!==null&&/^(0|[1-9][0-9]*)$/.test(after)&&Number.isSafeInteger(Number(after))));}
  return false;
 }
 const s=path.split('/'),operation=/^[A-Za-z0-9_-]{1,128}$/;
 if(/^\/api\/directory-operations\/[A-Za-z0-9_-]{1,128}$/.test(path))return !query;
 if(/^\/api\/(projects|workspaces)\/[A-Za-z0-9_-]{1,128}(?:\/history)?$/.test(path)){
  if(!path.endsWith('/history'))return !query;
  const params=new URLSearchParams(query);
  for(const [key,value] of params)if(!['afterRevision','limit'].includes(key)||params.getAll(key).length!==1||!/^(0|[1-9][0-9]*)$/.test(value)||!Number.isSafeInteger(Number(value)))return false;
  const limit=Number(params.get('limit')??20);return limit>=1&&limit<=50;
 }
 if(path==='/api/directory'||path==='/api/resolve'||path==='/api/auth/me'||path==='/api/auth/browser-session/tickets')return true;
 if(s[1]!=='api'||!['projects','workspaces'].includes(s[2])||!/^[A-Za-z0-9_-]{1,128}$/.test(s[3]??''))return false;
 if(s.length===7&&s[4]==='source'&&['issues','wiki_pages','issue_comments','projects'].includes(s[5])&&operation.test(s[6]))return true;
 if(s[2]==='workspaces'&&s[4]!=='wikis'&&s[4]!=='wiki-operations')return false;
 if(s.length===5&&['access','assignees','issues','wikis'].includes(s[4]))return true;
 if(s.length===6&&['issue-operations','wiki-operations'].includes(s[4]))return operation.test(s[5]);
 if(!['issues','wikis'].includes(s[4])||!validContentId({kind:s[4]==='issues'?'issue':'wiki'},s[5]??''))return false;
 if(s.length===6)return true;if(s.length===7&&['history','comments'].includes(s[6]))return true;
 if(s.length===8&&s[6]==='comment-operations')return operation.test(s[7]);
 return s[6]==='comments'&&validContentId({kind:'comment'},s[7]??'')&&(s.length===8||(s.length===9&&s[8]==='history'));
}

/** Correlate nonsecret failure evidence only after clientRouteAllowed has approved this request. */
export function requestOperationId(path:string,method:string,body:unknown):string|undefined {
 const saved=path.match(/^\/api\/agent\/operations\/([A-Za-z0-9_-]{1,128})(?:\/execute)?$/);
 if(saved)return saved[1];
 if(method==='GET')return path.match(/\/(?:issue|wiki|comment|execution|execution-report|directory)-operations\/([A-Za-z0-9_-]{1,128})$/)?.[1];
 if(path==='/api/agent/operations'&&method==='POST'&&body&&typeof body==='object'&&'input' in body){
  const input=body.input;
  if(input&&typeof input==='object'&&'operationId' in input&&typeof input.operationId==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(input.operationId))return input.operationId;
 }
 return undefined;
}
