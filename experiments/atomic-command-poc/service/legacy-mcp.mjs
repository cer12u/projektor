// Bounded d398 MCP compatibility. The old endpoint was stateless and had no
// caller CAS/operation IDs. Each invocation gets fresh internal operation IDs:
// response-loss retries can duplicate creates/comments, just as on the old API.
// Never infer command identity from JSON-RPC id or weaken the native contract.
import {randomUUID} from 'node:crypto';
import {Buffer} from 'node:buffer';
import {authorized,executeCommand,failure,queryIssues,queryProjects,queryIssueEntries,transaction} from '../src/shared-core.mjs';
import {wikiQuery} from '../src/wiki-surface.mjs';
import {queryLegacyUrl} from '../src/legacy-url.mjs';
import {createMCPRateLimiter} from './mcp-rate.mjs';

const own=(x,k)=>Object.hasOwn(x,k),plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x);
const get=(db,s,...a)=>db.prepare(s).get(...a);
const str={type:'string'},bool={type:'boolean'},nullable={type:['string','null']};
const priority={type:'string',enum:['urgent','high','medium','low','none']};
const status={type:'string',enum:['backlog','todo','in_progress','in_review','done','cancelled']};
const limit={type:'integer',minimum:1,maximum:100};
const shapes={view:{type:'string',enum:['summary','full']},verbose:bool};
const defs=[
 ['issues','get_issue',{id:str,ref:str,cursor:str,...shapes},[],'Get an issue by UUID or project ref. Bodies are windowed at 16000 characters.'],
 ['issues','list_issues',{projectId:str,status,priority,assignee:str,parentId:str,noParent:bool,includeBody:bool,bodyChars:{type:'integer',minimum:0,maximum:1000},limit,cursor:str,...shapes},[],'List current readable issues. Pass next back as cursor; filtered pages can be short or empty. Advanced legacy filters and ranking are unavailable.'],
 ['issues','create_issue',{projectId:str,title:str,body:str,priority,assigneeId:str,parentId:str,status:{type:'string',enum:['backlog','todo']}},['projectId','title'],'Create an issue. Omitted status uses the verified preserved workspace default when it is backlog or todo; unavailable, ambiguous or unsupported defaults fail without changes. Labels, types, custom fields and work completion are unavailable.'],
 ['issues','update_issue',{id:str,title:str,body:str,priority,assigneeId:nullable,parentId:nullable},['id'],'Atomically update title, body, priority, assignee or parent using the latest committed version. Status, claim and completion changes require the native workflow tools.'],
 ['comments','list_comments',{issueId:str},['issueId'],'List current readable comments. Unavailable historical author name/email fields are omitted.'],
 ['comments','add_comment',{issueId:str,body:{type:'string',minLength:1,maxLength:10000}},['issueId','body'],'Add a comment. A retry after a lost response may create another comment.'],
 ['comments','update_comment',{issueId:str,commentId:str,body:{type:'string',minLength:1,maxLength:10000}},['issueId','commentId','body'],'Update your own comment using its current version.'],
 ['wiki','get_wiki_page',{slug:str,maxChars:{type:'integer',minimum:1,maximum:20000},cursor:str,section:str},['slug'],'Get a Wiki page by UUID or slug, with content windows and heading sections. Revision IDs are the current Store revision IDs.'],
 ['wiki','list_wiki_pages',{parentId:str,projectId:str,includeWorkspacePages:bool},[],'List current readable pages, including templates. Frontmatter filters are unavailable in this bounded compatibility surface.'],
 ['wiki','create_wiki_page',{title:{type:'string',minLength:1,maxLength:300},slug:str,content:str,parentId:str,projectId:str},['title'],'Create a plain Markdown Wiki page. Frontmatter metadata and templates require a supported native workflow and are rejected here.'],
 ['wiki','update_wiki_page',{id:str,slug:str,title:{type:'string',minLength:1,maxLength:300},content:str,newSlug:str,baseRevisionId:nullable,summary:{type:'string',maxLength:2000}},[],'Edit or rename a plain Markdown Wiki page. Optional baseRevisionId must match the current Store revision (including title revisions); omission uses last-write-wins. Parent moves and frontmatter edits are unavailable.']
];
const domains=['workspaces','groups','projects','project-activity','issues','issue-links','comments','wiki','files','task-types','task-statuses','custom-fields','sprints','feedback','agents','file-claims','issue-leases','agent-messages','workflow','playbooks','flow-metrics','code-heatmap'];
export const LEGACY_MCP_INSTRUCTIONS='Bounded legacy Issue, comment and Wiki compatibility on the current Store. Rediscover tools for supported arguments. Unsupported fields and workflow operations fail without changes. Each call is a fresh operation; JSON-RPC id is not an idempotency key. Lost-response create/comment retries may duplicate. Native clients retain strict caller CAS and durable operation IDs.';
export function listLegacyMCPTools(requested){
 const wanted=requested===undefined?[]:[...new Set(requested.split(',').map(x=>x.trim()).filter(Boolean))];
 if(wanted.some(x=>!domains.includes(x)))throw new Error('UNKNOWN_DOMAIN');
 return defs.filter(([domain])=>!wanted.length||wanted.includes(domain)).map(([,name,properties,required,description])=>({name,description,inputSchema:{type:'object',properties:structuredClone(properties),required,additionalProperties:false},annotations:{readOnlyHint:/^(get|list)_/.test(name),destructiveHint:false,idempotentHint:/^(get|list|update)_/.test(name)}}));
}
function checkArgs(name,args){
 const def=defs.find(x=>x[1]===name);if(!def)return 'LEGACY_TOOL_UNSUPPORTED';
 if(!plain(args))return 'VALIDATION';
 const [, ,props,required]=def;
 if(Object.keys(args).some(k=>!own(props,k)))return 'LEGACY_ARGUMENT_UNSUPPORTED';
 if(required.some(k=>!own(args,k)))return 'VALIDATION';
 for(const [key,value] of Object.entries(args)){
  const s=props[key],types=Array.isArray(s.type)?s.type:[s.type];
  if(!types.some(t=>t==='null'?value===null:t==='integer'?Number.isSafeInteger(value):typeof value===t))return 'VALIDATION';
  if(typeof value==='string'&&(!value.isWellFormed()||s.minLength!==undefined&&value.length<s.minLength||s.maxLength!==undefined&&value.length>s.maxLength))return 'VALIDATION';
  if(s.enum&&!s.enum.includes(value)||s.minimum!==undefined&&value<s.minimum||s.maximum!==undefined&&value>s.maximum)return 'VALIDATION';
 }
 return null;
}
class Rejected extends Error{constructor(code){super(code);this.result=failure(code,'rejected');}}
const reject=code=>{throw new Rejected(code);};
const data=result=>{if(result.error){const e=new Rejected(result.error.code);e.result=result;throw e;}return result.data;};
const priorities={urgent:'P0',high:'P1',medium:'P2',low:'P3',none:null};
const oldPriority={P0:'urgent',P1:'high',P2:'medium',P3:'low'};
const oldStatus={backlog:'backlog',ready:'todo',in_progress:'in_progress',done:'done',canceled:'cancelled'};
const seconds=x=>x===null||x===undefined?null:Math.floor(x/1000);
const wikiPath=slug=>`/wiki/${encodeURIComponent(slug)}`;
function windowText(text,max,cursor){
 const start=cursor===undefined?0:Number(cursor);if(!Number.isSafeInteger(start)||start<0||start>text.length)reject('VALIDATION');
 let end=Math.min(text.length,start+max);if(end>start&&end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;
 if(end<=start&&start<text.length)end=start+(/[\uD800-\uDBFF]/.test(text[start])?2:1);
 return {text:text.slice(start,end),totalChars:text.length,...(end<text.length?{next:String(end)}:{})};
}
function headings(content){
 const out=[];let pos=0,fence=null,front=false,first=true;
 for(const line of content.split('\n')){const start=pos;pos+=line.length+1;if(first){first=false;if(line.trim()==='---'){front=true;continue;}}if(front){if(line.trim()==='---')front=false;continue;}const f=/^\s*(```|~~~)/.exec(line);if(f){if(!fence)fence=f[1];else if(fence===f[1])fence=null;continue;}if(fence)continue;const m=/^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);if(m)out.push({level:m[1].length,text:m[2],start});}return out;
}
function wikiRead(page,args){
 const full=page.contentMarkdown??'',hs=headings(full),out={id:page.id,title:page.title,slug:page.slug,project_id:page.scope.kind==='project'?page.scope.projectId:null,parent_id:page.parentId,revisionId:page.currentRevisionId,url:wikiPath(page.slug),created_at:seconds(page.createdAt),updated_at:seconds(page.updatedAt),outline:hs.map(h=>'#'.repeat(h.level)+' '+h.text)};
 let source=full;
 if(args.section!==undefined){const wanted=args.section.replace(/^#+\s*/,'').trim().toLowerCase(),i=hs.findIndex(h=>h.text.toLowerCase()===wanted||h.text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu,'').trim().replace(/\s+/g,'-')===wanted);out.section=args.section;if(i<0)return {...out,sectionFound:false};source=full.slice(hs[i].start,hs.slice(i+1).find(h=>h.level<=hs[i].level)?.start??full.length).replace(/\n+$/,'');}
 const w=windowText(source,args.maxChars??8000,args.cursor);return {...out,content:w.text,totalChars:w.totalChars,...(w.next||args.cursor!==undefined||args.section!==undefined?{contentTruncated:true}:{}),...(w.next?{next:w.next}:{})};
}
const reservedSlugs=['view','index','templates','tree','search','broken-links','stale-pages','backfill-links','watches','notifications','trash','purge-trash','changes','export'];
const idShaped=x=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
function slugFor(title,randomId){let slug=title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');if(!slug||slug.length>200)slug='page-'+randomId().slice(0,8);if(reservedSlugs.includes(slug)||idShaped(slug))slug+='-page';return slug;}
function validSlug(slug){return typeof slug==='string'&&/^[a-z0-9-]{1,200}$/.test(slug)&&!reservedSlugs.includes(slug)&&!idShaped(slug);}
function plainMarkdown(content){if(typeof content==='string'&&/^\s*---\s*\r?\n/.test(content))reject('LEGACY_FRONTMATTER_UNSUPPORTED');}

// Only configuration metadata is projected from the pinned preservation format;
// no raw records, content or archive data is returned. The immutable current
// taxonomy and the preserved catalog must close over the same IDs and snapshot.
// This is a migration default, not a new caller-supplied setting or authority.
function legacyDefaultStatus(db,workspaceId){
 const current=db.prepare('SELECT id,status_key,category,is_review_step FROM issue_compat_status ORDER BY id LIMIT 101').all();
 const rows=db.prepare(`SELECT source_entity_id,target_resource_id,
  json_extract(source_revision,'$[1]') AS snapshot,
  json_array_length(source_revision) AS revision_fields,
  json_extract(raw_record,'$.id') AS id,
  json_extract(raw_record,'$.key') AS status_key,
  json_extract(raw_record,'$.category') AS category,
  json_extract(raw_record,'$.is_default') AS is_default,
  json_type(raw_record,'$.is_default') AS default_type,
  json_extract(raw_record,'$.is_review_step') AS is_review_step
  FROM source_mapping
  WHERE source_system='legacy-projektor' AND source_entity_type='legacy_archive'
   AND target_resource_type='legacy_archive' AND json_valid(source_revision)
   AND json_extract(source_revision,'$[0]')='task_statuses' AND json_valid(raw_record)
   AND json_extract(raw_record,'$.workspace_id')=?
  ORDER BY source_entity_id LIMIT 101`).all(workspaceId);
 if(!current.length||current.length>100||rows.length!==current.length||new Set(rows.map(r=>r.id)).size!==rows.length||new Set(rows.map(r=>r.snapshot)).size!==1||rows.some(r=>r.revision_fields!==2||typeof r.snapshot!=='string'||! /^[0-9a-f]{64}$/.test(r.snapshot)||r.id!==r.source_entity_id||r.id!==r.target_resource_id||r.default_type!=='integer'||![0,1].includes(r.is_default)||![0,1].includes(r.is_review_step)||!current.some(c=>c.id===r.id)))reject('LEGACY_DEFAULT_STATUS_UNAVAILABLE');
 const defaults=rows.filter(r=>r.is_default===1);if(defaults.length>1)reject('LEGACY_DEFAULT_STATUS_UNAVAILABLE');
 // d398 resolveStatus falls back to the unbacked backlog key when the complete
 // catalog has no default. An absent/unverified catalog is not that evidence.
 if(!defaults.length)return 'backlog';
 const selected=defaults[0],matched=current.find(c=>c.id===selected.id);
 if(!['backlog','todo'].includes(selected.status_key)||selected.category!=='todo'||selected.is_review_step!==0)reject('LEGACY_DEFAULT_STATUS_UNSUPPORTED');
 if(matched.status_key!==selected.status_key||matched.category!==(selected.status_key==='todo'?'ready':'backlog')||matched.is_review_step!==0)reject('LEGACY_DEFAULT_STATUS_UNAVAILABLE');
 return selected.status_key;
}

// The wrapper is private to this synchronous transaction. Core commands still
// perform all authorization, validation, receipts, activity, FTS and outbox work.
// A returned core error is thrown so a multi-field update cannot partially commit.
export function callLegacyMCPTool(db,actor,name,args,{now,randomId=randomUUID,fault=()=>{}}={}){
 const invalid=checkArgs(name,args);if(invalid)return failure(invalid,'rejected');
 let rejected;
 try{return transaction(db,()=>{
  const tx={prepare:sql=>db.prepare(sql),transactionSync:fn=>fn()};
  try{
   const time=now??Date.now(),workspace=get(tx,'SELECT id,epoch FROM workspace WHERE id=?',actor?.workspaceId);
   if(!workspace)reject('WORKSPACE_MISMATCH');
   const common={workspaceId:workspace.id,workspaceEpoch:workspace.epoch},denied=authorized(tx,actor,workspace.id,workspace.epoch,time);if(denied)reject(denied);
   const projects=()=>data(queryProjects(tx,actor,common,time)).items;
   const projectId=value=>{const p=projects().find(p=>p.id===value||p.key===value);if(!p)reject('NOT_FOUND');return p.id;};
   const issue=value=>{if(typeof value!=='string'||!value)reject('VALIDATION');let id=value;if(!uuid(id)){const ref=/^([A-Z][A-Z0-9]*)-([1-9][0-9]{0,8})$/.exec(value);if(!ref)reject('NOT_FOUND');id=data(queryLegacyUrl(tx,actor,{...common,path:`/projects/${ref[1]}/issues/${ref[2]}/`},time)).id;}return data(queryIssues(tx,actor,{...common,entityId:id},time));};
   const wiki=value=>{if(typeof value!=='string'||!value)reject('VALIDATION');const id=uuid(value)?value:data(queryLegacyUrl(tx,actor,{...common,path:wikiPath(value)},time)).id;return data(wikiQuery(tx,actor,'wiki_get',{...common,entityId:id},time));};
   const command=(type,id,payload,version)=>data(executeCommand(tx,actor,{schemaVersion:1,...common,operationId:randomId(),commandType:type,entityId:id,expectedVersion:version,payload},{now:time,fault}));
   const collect=(query,extra={})=>{let cursor;const rows=[];do{const page=data(query({...common,...extra,limit:100,...(cursor?{cursor}:{})}));rows.push(...page.items);cursor=page.nextCursor;if(rows.length>1000||cursor&&rows.length===1000)reject('LEGACY_RESULT_LIMIT');}while(cursor);return rows;};
   const shapeIssue=(row,list=false)=>{const p=projects().find(p=>p.id===row.project_id),compat=row.compatibility,content=get(tx,'SELECT created_at FROM issue_content WHERE issue_id=?',row.id);let out={id:row.id,title:row.title,number:row.number,project_id:row.project_id,project_key:p?.key,ref:p?.key&&row.number?`${p.key}-${row.number}`:undefined,status:compat?.statusKey??oldStatus[row.status]??row.status,priority:row.priority===null?'none':oldPriority[row.priority]??row.priority,assignee_id:row.assigneeId,parent_id:row.parentId,created_at:seconds(content?.created_at),type_id:compat?.typeId,status_id:compat?.statusId};if(!list||args.includeBody||args.bodyChars){const w=windowText(row.description??'',list&&!args.includeBody?args.bodyChars:!list?16000:262144,!list?args.cursor:undefined);out.body=w.text;if(w.next){out.bodyTruncated=true;if(!list)out.next=w.next;}if(!list&&(w.next||args.cursor!==undefined))out.bodyTotalChars=w.totalChars;}if(args.view==='summary')out={...(out.ref?{ref:out.ref}:{id:out.id}),title:out.title,status:out.status,priority:out.priority,...(out.assignee_id?{assignee:out.assignee_id}:{}),...(out.parent_id?{parent:out.parent_id}:{}),...(own(out,'body')?{body:out.body,...(out.bodyTruncated?{bodyTruncated:true}:{})}:{}),...(out.next?{next:out.next,bodyTotalChars:out.bodyTotalChars}:{})};return Object.fromEntries(Object.entries(out).filter(([,v])=>v!==undefined&&(args.verbose||v!==null&&v!==false&&v!=='')));};
   let result;
   if(name==='get_issue')result=shapeIssue(issue(args.id??args.ref));
   else if(name==='list_issues'){
    const project=args.projectId===undefined?undefined:projectId(args.projectId),parent=args.parentId===undefined?undefined:issue(args.parentId).id;
    const page=data(queryIssues(tx,actor,{...common,limit:args.limit??50,...(args.cursor?{cursor:args.cursor}:{})},time));
    const rows=page.items.filter(r=>(project===undefined||r.project_id===project)&&(parent===undefined||r.parentId===parent)&&(!args.noParent||r.parentId===null)&&(args.assignee===undefined||r.assigneeId===(args.assignee==='me'?actor.principalId:args.assignee))&&(args.priority===undefined||r.priority===priorities[args.priority])&&(args.status===undefined||(r.compatibility?.statusKey??oldStatus[r.status])===args.status));
    result={items:rows.map(r=>shapeIssue(r,true)),...(page.nextCursor?{next:page.nextCursor}:{})};
   }else if(name==='create_issue'){
    const initialStatus=args.status??legacyDefaultStatus(tx,workspace.id);
    const id=randomId(),project=projectId(args.projectId),parent=args.parentId?issue(args.parentId).id:null;
    command('Issue.Create',id,{projectId:project,title:args.title,description:args.body??'',assigneeId:args.assigneeId??null,priority:priorities[args.priority??'none'],parentId:parent,initialStatus:initialStatus==='todo'?'ready':'backlog'},0);
    result={id,number:issue(id).number};
   }else if(name==='update_issue'){
    if(Object.keys(args).length===1)reject('VALIDATION');let row=issue(args.id);
    const steps=[];for(const [key,type,field] of [['title','Issue.UpdateTitle','title'],['body','Issue.UpdateBody','description'],['assigneeId','Issue.Assign','assigneeId'],['priority','Issue.SetPriority','priority']])if(own(args,key))steps.push([type,{[field]:key==='priority'?priorities[args[key]]:args[key]}]);
    if(own(args,'parentId')){const parent=args.parentId===null?null:issue(args.parentId);steps.push(['Issue.Reparent',{payloadVersion:1,parentId:parent?.id??null,...(parent?{expectedParentVersion:parent.version}:{})}]);}
    for(const [type,payload] of steps){command(type,row.id,payload,row.version);row=issue(row.id);}result={ok:true};
   }else if(name==='list_comments'){
    const row=issue(args.issueId),rows=collect(a=>queryIssueEntries(tx,actor,a,time),{entityId:row.id});result={items:rows.filter(e=>e.kind==='comment').map(e=>({id:e.id,body:e.bodyMarkdown,created_at:seconds(e.createdAt),updated_at:seconds(e.editedAt??e.createdAt),...(e.authorRef.principalId?{author_id:e.authorRef.principalId}:{}),...(e.authorRef.sourceDisplayNameRaw?{author_name:e.authorRef.sourceDisplayNameRaw}:{})}))};
   }else if(name==='add_comment'){
    const row=issue(args.issueId),id=randomId();command('Issue.AddComment',row.id,{commentId:id,bodyMarkdown:args.body},row.version);result={id};
   }else if(name==='update_comment'){
    const row=issue(args.issueId),entry=get(tx,'SELECT * FROM issue_entry WHERE id=? AND issue_id=? AND kind=? AND deleted_at IS NULL',args.commentId,row.id,'comment');if(!entry)reject('NOT_FOUND');if(JSON.parse(entry.author_ref).principalId!==actor.principalId)reject('COMMENT_FORBIDDEN');command('Issue.EditComment',entry.id,{commentId:entry.id,expectedCommentVersion:entry.version,bodyMarkdown:args.body},entry.version);result={ok:true};
   }else if(name==='get_wiki_page')result=wikiRead(wiki(args.slug),args);
   else if(name==='list_wiki_pages'){
    const project=args.projectId===undefined?undefined:projectId(args.projectId),rows=collect(a=>wikiQuery(tx,actor,'wiki_list',a,time));result=rows.filter(p=>(args.parentId===undefined||p.parentId===args.parentId)&&(project===undefined||p.scope.kind==='project'&&p.scope.projectId===project||args.includeWorkspacePages&&p.scope.kind==='workspace_shared')).map(p=>({id:p.id,title:p.title,slug:p.slug,parent_id:p.parentId,project_id:p.scope.kind==='project'?p.scope.projectId:null,url:wikiPath(p.slug),updated_at:seconds(p.updatedAt)}));
   }else if(name==='create_wiki_page'){
    plainMarkdown(args.content);const id=randomId(),slug=args.slug??slugFor(args.title,randomId);if(!validSlug(slug))reject('VALIDATION');if(get(tx,'SELECT 1 FROM wiki_page WHERE workspace_id=? AND slug=? AND deleted_at IS NULL',workspace.id,slug))reject('SLUG_CONFLICT');const project=args.projectId?projectId(args.projectId):null;
    command('Wiki.Create',id,{pageId:id,scope:project?{kind:'project',projectId:project}:{kind:'workspace_shared'},parentId:args.parentId??null,title:args.title,slug,contentMarkdown:args.content??''},0);result={id,slug,projectId:project,url:wikiPath(slug),type:null,tags:[],status:null,verifiedAt:null,verifiedBy:null,owners:[],verifyInterval:null,isTemplate:false};
   }else if(name==='update_wiki_page'){
    if(!['title','content','newSlug'].some(k=>own(args,k)))reject('VALIDATION');plainMarkdown(args.content);let page=wiki(args.id??args.slug);
    if(own(args,'baseRevisionId')&&args.baseRevisionId!==page.currentRevisionId)reject('VERSION_CONFLICT');
    if(own(args,'newSlug')){if(!validSlug(args.newSlug))reject('VALIDATION');if(get(tx,'SELECT 1 FROM wiki_page WHERE workspace_id=? AND slug=? AND id<>? AND deleted_at IS NULL',workspace.id,args.newSlug,page.id))reject('SLUG_CONFLICT');command('Wiki.Rename',page.id,{title:args.title??page.title,slug:args.newSlug},page.version);page=wiki(page.id);}
    const payload={...(own(args,'title')&&!own(args,'newSlug')?{title:args.title}:{}),...(own(args,'content')?{contentMarkdown:args.content}:{}),...(own(args,'summary')?{summary:args.summary}:{})};if(Object.keys(payload).length)command('Wiki.Edit',page.id,payload,page.version);result={ok:true,url:wikiPath(args.newSlug??page.slug)};
   }else reject('LEGACY_TOOL_UNSUPPORTED');
   if(Buffer.byteLength(JSON.stringify(result))>2*1024*1024)reject('LEGACY_RESULT_LIMIT');
   return {data:result};
  }catch(e){if(e instanceof Rejected)rejected=e.result;throw e;}
 });}catch(e){if(rejected&&e.outcome==='not_committed')return rejected;throw e;}
}

const headers={'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'};
const response=(value,status=200)=>Response.json(value,{status,headers});
export function createLegacyMCPTransport({listTools=listLegacyMCPTools,callTool,rateLimit,now=Date.now,admitTool}){
 const admit=admitTool??createMCPRateLimiter(rateLimit,now);
 return (request,rpc,identity)=>{
  const id=plain(rpc)&&own(rpc,'id')?rpc.id:null,error=(code,message,status=200,data)=>response({jsonrpc:'2.0',id,error:{code,message,...(data?{data}:{})}},status),ok=result=>response({jsonrpc:'2.0',id,result});
  if(request.method!=='POST')return new Response(null,{status:405,headers:{...headers,allow:'POST'}});
  if(!plain(rpc)||rpc.jsonrpc!=='2.0'||typeof rpc.method!=='string')return error(-32600,'Invalid Request',400);
  if(rpc.method==='initialize')return ok({protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'projektor',version:'legacy-store-compat-1'},instructions:LEGACY_MCP_INSTRUCTIONS});
  if(rpc.method==='notifications/initialized'||rpc.method==='notifications/cancelled')return new Response(null,{status:202,headers});
  if(rpc.method==='ping')return ok({});
  if(rpc.method==='tools/list'){try{return ok({tools:listTools(new URL(request.url).searchParams.get('domains')??undefined),ttlMs:60000,cacheScope:'private'});}catch{return error(-32602,'Unknown domain slug',400);}}
  if(rpc.method!=='tools/call')return error(-32601,'Method not found');
  if(!plain(rpc.params)||typeof rpc.params.name!=='string'||rpc.params.arguments!==undefined&&!plain(rpc.params.arguments))return error(-32602,'Invalid params');
  const admission=admit(identity,now());if(!admission.allowed){const out=error(1001,'Request unavailable',admission.status,{code:admission.code,outcome:'unknown'});if(admission.retryAfter)out.headers.set('retry-after',String(admission.retryAfter));return out;}
  try{const result=callTool(rpc.params.name,rpc.params.arguments??{},identity);return ok({...(result.error?{isError:true}:{}),content:[{type:'text',text:JSON.stringify(result.error?result:result.data)}]});}
  catch{return error(1001,'Request unavailable',503,{code:'TRANSPORT_UNKNOWN',outcome:'unknown'});}
 };
}
