// Navigation compatibility only. Never rewrites source Markdown or link bindings.
import {Buffer} from 'node:buffer';
import {authorized,canonical,failure,transaction} from './shared-core.mjs';
import {currentRead,scopeAllowed} from './resource-access.mjs';
const get=(db,s,...a)=>db.prepare(s).get(...a),all=(db,s,...a)=>db.prepare(s).all(...a);
const id=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x);
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
const shape=(x,fields)=>plain(x)&&Object.keys(x).sort().join(',')===[...fields].sort().join(',');
const text=x=>typeof x==='string'&&x.isWellFormed();
const segment=x=>text(x)&&Buffer.byteLength(x)>0&&Buffer.byteLength(x)<=4096&&!/[\u0000-\u0020\u007f/\\?#]/.test(x)&&x!=='.'&&x!=='..';
const projectKey=x=>segment(x)&&/^[A-Z][A-Z0-9]*$/.test(x);
const require=(ok,message)=>{if(!ok)throw Error(message);};

// Offline import into the existing Store. A replay checks the immutable source
// baseline, never the mutable current values; it cannot reset a native rename.
export function importProjectUrls(db,batch){
 require(shape(batch,['projects'])&&Array.isArray(batch.projects)&&batch.projects.length<=100,'Bounded project URL import required');
 for(const p of batch.projects)require(shape(p,['projectId','key','slug'])&&id(p.projectId)&&projectKey(p.key)&&segment(p.slug),'Invalid project URL mapping');
 for(const field of ['projectId','key','slug'])require(new Set(batch.projects.map(p=>p[field])).size===batch.projects.length,'Duplicate project URL mapping');
 return transaction(db,()=>{
  for(const p of batch.projects){
   const baseline=canonical(p),old=get(db,'SELECT import_baseline_json FROM project_url WHERE project_id=?',p.projectId);
   if(old){require(old.import_baseline_json===baseline,'PROJECT_URL_IMPORT_CONFLICT');continue;}
   require(get(db,'SELECT id FROM project WHERE id=?',p.projectId),'PROJECT_URL_IMPORT_TARGET_MISSING');
   const result=db.prepare('INSERT INTO project_url VALUES(?,?,?,?)').run(p.projectId,p.key,p.slug,baseline);
   require(result.changes===1,'Required project URL import suppressed');
  }
  return {importedProjects:batch.projects.length};
 });
}

// Decode segments once, without URL's dot-segment/backslash normalization. Only
// the three source-confirmed relative routes are accepted; there is no origin guess.
function parsePath(path){
 if(!text(path)||Buffer.byteLength(path)>16384||/[\u0000-\u0020\u007f\\?#]/.test(path))return null;
 const decode=raw=>{try{const value=decodeURIComponent(raw);return segment(value)?value:null;}catch{return null;}};
 let match=path.match(/^\/projects\/([A-Z][A-Z0-9]*)\/issues\/([1-9][0-9]{0,8})\/([a-z0-9-]*)$/);
 if(match){const key=match[1],number=Number(match[2]);if(!projectKey(key))return null;return {kind:'issue',key,number};}
 match=path.match(/^\/wiki\/([^/]+)$/);if(match){const slug=decode(match[1]);return slug?{kind:'wiki',slug}:null;}
 match=path.match(/^\/projects\/view\/([^/]+)$/);if(match){const slug=decode(match[1]);return slug?{kind:'project',slug}:null;}
 return null;
}
function projectReadable(db,actor,projectId){return Boolean(get(db,'SELECT id FROM project WHERE id=? AND deleted=0',projectId)&&scopeAllowed(db,actor,{kind:'project',projectId}));}
function readableWiki(db,actor,pageId,workspaceId){
 const row=get(db,'SELECT workspace_id,scope FROM wiki_page WHERE id=?',pageId);if(!row||row.workspace_id!==workspaceId)return false;
 let scope;try{scope=JSON.parse(row.scope);}catch{return false;}
 return Boolean((scope.kind!=='project'||projectReadable(db,actor,scope.projectId))&&currentRead(db,actor,{type:'wiki',id:pageId}));
}
function resolveWiki(db,actor,workspaceId,slug,path){
 // Identity selection precedes permission filtering. A hidden current page must
 // never turn into an accessible historical alias with the same name.
 const direct=all(db,'SELECT id FROM wiki_page WHERE workspace_id=? AND slug=? AND deleted_at IS NULL LIMIT 2',workspaceId,slug);
 if(direct.length)return direct.length===1&&readableWiki(db,actor,direct[0].id,workspaceId)?direct[0].id:null;
 const aliases=all(db,"SELECT scope,target_page_id FROM wiki_alias WHERE (kind='slug' AND comparison_key=?) OR (kind='legacy_url' AND comparison_key=?)",slug.normalize('NFC'),path);
 const targets=[...new Set(aliases.map(a=>a.target_page_id))];
 if(targets.length!==1||!readableWiki(db,actor,targets[0],workspaceId))return null;
 // Alias scope is evidence, not an inferred scope from an accessible page.
 return aliases.some(a=>{try{const scope=JSON.parse(a.scope);return scopeAllowed(db,actor,scope)&&(scope.kind!=='project'||projectReadable(db,actor,scope.projectId));}catch{return false;}})?targets[0]:null;
}
export function queryLegacyUrl(db,actor,args,now){
 if(!shape(args,['workspaceId','workspaceEpoch','path'])||!id(args.workspaceId)||!id(args.workspaceEpoch)||!text(args.path))return failure('VALIDATION');
 return transaction(db,()=>{
  const denied=authorized(db,actor,args.workspaceId,args.workspaceEpoch,now??Date.now());if(denied)return failure(denied);
  const parsed=parsePath(args.path);if(!parsed)return failure('NOT_FOUND');
  let resourceId;
  if(parsed.kind==='wiki')resourceId=resolveWiki(db,actor,args.workspaceId,parsed.slug,args.path);
  else {
   const project=get(db,`SELECT project_id FROM project_url WHERE ${parsed.kind==='issue'?'project_key':'project_slug'}=?`,parsed.kind==='issue'?parsed.key:parsed.slug);
   if(!project||!projectReadable(db,actor,project.project_id))return failure('NOT_FOUND');
   if(parsed.kind==='project')resourceId=project.project_id;
   else {
    // Current number takes precedence; an alias cannot bypass its target's ACL.
    const issue=get(db,'SELECT issue_id FROM issue_number WHERE project_id=? AND number=?',project.project_id,parsed.number)??get(db,'SELECT issue_id FROM issue_alias WHERE project_id=? AND number=?',project.project_id,parsed.number);
    const current=issue&&get(db,'SELECT project_id FROM issue WHERE id=?',issue.issue_id);
    if(current&&projectReadable(db,actor,current.project_id)&&currentRead(db,actor,{type:'issue',id:issue.issue_id}))resourceId=issue.issue_id;
   }
  }
  if(!resourceId)return failure('NOT_FOUND');
  const view={issue:'issue',wiki:'wiki-page',project:'project'}[parsed.kind],field={issue:'issueId',wiki:'pageId',project:'projectId'}[parsed.kind];
  return {data:{kind:parsed.kind,id:resourceId,canonicalPath:`/?view=${view}&workspaceId=${args.workspaceId}&${field}=${resourceId}`},meta:{workspaceId:args.workspaceId,workspaceEpoch:args.workspaceEpoch,actorId:actor.principalId}};
 });
}
