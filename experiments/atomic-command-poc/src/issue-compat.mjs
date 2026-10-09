// Current imported Issue metadata. This is not a historical-ACL or DoR policy engine.
import {Buffer} from 'node:buffer';
import {transaction,canonical} from './shared-core.mjs';
const get=(db,s,...a)=>db.prepare(s).get(...a),all=(db,s,...a)=>db.prepare(s).all(...a);
const taxonomy=x=>typeof x==='string'&&/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(x);
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x);
const string=x=>typeof x==='string'&&x.isWellFormed();
const integer=x=>Number.isSafeInteger(x)&&x>=0;
const shape=(x,fields)=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype&&Object.keys(x).sort().join(',')===[...fields].sort().join(',');
const categories=['backlog','ready','in_progress','blocked','done','canceled'];
const require=(ok,msg)=>{if(!ok)throw Error(msg);};
const one=(db,s,...a)=>{const r=db.prepare(s).run(...a);require(r.changes===1,'Required compatibility write suppressed');};
export const isCompatibilityStatusId=taxonomy;
const COMPAT_CATALOG_BYTES=16*1024,COMPAT_INTRINSIC_BYTES=32*1024-512;
const wireBytes=x=>Buffer.byteLength(JSON.stringify(x));
const statusProjection=s=>({id:s.id,key:s.status_key,name:s.name,toStatus:s.category,isReviewStep:Boolean(s.is_review_step)});
function intrinsicProjection(r,bodyRevisionId){
 let missing=null;try{const value=JSON.parse(r.dor_missing_raw);if(Array.isArray(value)&&value.every(string))missing=value;}catch{}
 return {completionReportAt:r.completion_report_at,typeId:r.type_id,typeName:r.type_name,
  dor:{ready:r.dor_ready===null?null:Boolean(r.dor_ready),missingRaw:r.dor_missing_raw,missing,evaluatedRevisionId:r.dor_revision_id,evidenceState:r.dor_revision_id!==null&&r.dor_revision_id===bodyRevisionId?'current':'stale_after_edit'}};
}
export function issueCompatibilityProjection(db,issueId,bodyRevisionId){
 const r=get(db,'SELECT c.*,s.status_key,s.name,s.category,s.is_review_step FROM issue_compat_state c JOIN issue_compat_status s ON s.id=c.status_id WHERE c.issue_id=?',issueId);
 if(!r)return null;
 return {statusId:r.status_id,statusKey:r.status_key,statusName:r.name,isReviewStep:Boolean(r.is_review_step),...intrinsicProjection(r,bodyRevisionId),statuses:all(db,'SELECT * FROM issue_compat_status ORDER BY position,id').map(statusProjection)};
}
// Lists need only labels, not repeated DoR source text or the whole status catalog.
export function issueCompatibilitySummary(db,issueId){
 const r=get(db,'SELECT c.status_id,c.type_id,c.type_name,s.status_key,s.name,s.is_review_step FROM issue_compat_state c JOIN issue_compat_status s ON s.id=c.status_id WHERE c.issue_id=?',issueId);
 return r?{statusId:r.status_id,statusKey:r.status_key,statusName:r.name,isReviewStep:Boolean(r.is_review_step),typeId:r.type_id,typeName:r.type_name}:null;
}
export function planCompatibilityTransition(db,issueId,toStatus,statusId){
 const current=get(db,'SELECT c.status_id,s.is_review_step,s.category,q.status_category FROM issue_compat_state c JOIN issue_compat_status s ON s.id=c.status_id JOIN issue_queue q ON q.issue_id=c.issue_id WHERE c.issue_id=?',issueId);
 if(!current)return statusId===undefined?{changed:false}:{error:'COMPATIBILITY_UNAVAILABLE'};
 if(current.category!==current.status_category)return {error:'COMPAT_STATE_MISMATCH'};
 let next;
 if(statusId!==undefined){next=get(db,'SELECT * FROM issue_compat_status WHERE id=?',statusId);if(!next||next.category!==toStatus)return {error:'COMPAT_STATUS_MISMATCH'};}
 else if(current.category===toStatus)next=get(db,'SELECT * FROM issue_compat_status WHERE id=?',current.status_id);
 else {const options=all(db,'SELECT * FROM issue_compat_status WHERE category=? ORDER BY position,id',toStatus);if(options.length!==1)return {error:'COMPAT_STATUS_REQUIRED'};next=options[0];}
 return {changed:next.id!==current.status_id,beforeStatusId:current.status_id,statusId:next.id,beforeReviewStep:Boolean(current.is_review_step),isReviewStep:Boolean(next.is_review_step)};
}
export function applyCompatibilityTransition(db,issueId,plan){
 if(plan.statusId!==undefined&&plan.changed)one(db,'UPDATE issue_compat_state SET status_id=? WHERE issue_id=? AND status_id=?',plan.statusId,issueId,plan.beforeStatusId);
}
export function importIssueCompatibility(db,{statuses,issues}){
 require(Array.isArray(statuses)&&statuses.length<=100&&Array.isArray(issues)&&issues.length<=100,'Bounded compatibility import required');
 for(const s of statuses)require(shape(s,['id','key','name','toStatus','isReviewStep','position'])&&taxonomy(s.id)&&string(s.key)&&s.key.length>0&&s.key.length<=200&&string(s.name)&&s.name.length>0&&s.name.length<=4096&&categories.includes(s.toStatus)&&typeof s.isReviewStep==='boolean'&&(!s.isReviewStep||s.toStatus==='in_progress')&&integer(s.position),'Invalid compatibility status');
 require(new Set(statuses.map(s=>s.id)).size===statuses.length,'Duplicate compatibility status');
 for(const i of issues)require(shape(i,['issueId','statusId','typeId','typeName','completionReportAt','dorReady','dorMissingRaw','dorRevisionId'])&&uuid(i.issueId)&&taxonomy(i.statusId)&&(i.typeId===null||taxonomy(i.typeId))&&(i.typeName===null||string(i.typeName)&&i.typeName.length<=4096)&&(i.completionReportAt===null||integer(i.completionReportAt))&&(i.dorReady===null||typeof i.dorReady==='boolean')&&(i.dorMissingRaw===null||string(i.dorMissingRaw)&&Buffer.byteLength(i.dorMissingRaw)<=65536)&&(i.dorRevisionId===null||uuid(i.dorRevisionId)),'Invalid compatibility state');
 require(new Set(issues.map(i=>i.issueId)).size===issues.length,'Duplicate compatibility Issue');
 return transaction(db,()=>{
  for(const s of statuses){const row={id:s.id,status_key:s.key,name:s.name,category:s.toStatus,is_review_step:Number(s.isReviewStep),position:s.position};const old=get(db,'SELECT * FROM issue_compat_status WHERE id=?',s.id);if(old)require(canonical({...old})===canonical(row),'COMPAT_IMPORT_CONFLICT');else one(db,'INSERT INTO issue_compat_status VALUES(?,?,?,?,?,?)',...Object.values(row));}
  const catalog=all(db,'SELECT * FROM issue_compat_status ORDER BY position,id');
  require(catalog.length<=100&&wireBytes(catalog.map(statusProjection))<=COMPAT_CATALOG_BYTES,'COMPAT_IMPORT_CATALOG_BUDGET');
  // Reserve the full allowed catalog and any future selected status summary, not
  // today's body/status only. Future body edits and stale-evidence labels cannot
  // grow the compatibility envelope beyond64KiB. Source raw remains with importer.
  for(const i of issues){
   const intrinsic=intrinsicProjection({completion_report_at:i.completionReportAt,type_id:i.typeId,type_name:i.typeName,dor_ready:i.dorReady===null?null:Number(i.dorReady),dor_missing_raw:i.dorMissingRaw,dor_revision_id:i.dorRevisionId},undefined);
   require(wireBytes(intrinsic)<=COMPAT_INTRINSIC_BYTES,'COMPAT_IMPORT_STATE_BUDGET');
   const baseline=canonical(i),old=get(db,'SELECT import_baseline_json FROM issue_compat_state WHERE issue_id=?',i.issueId);
   if(old){require(old.import_baseline_json===baseline,'COMPAT_IMPORT_CONFLICT');continue;}
   const status=get(db,'SELECT category FROM issue_compat_status WHERE id=?',i.statusId),issue=get(db,'SELECT q.status_category,c.body_revision_id FROM issue_queue q JOIN issue_content c ON c.issue_id=q.issue_id WHERE q.issue_id=?',i.issueId);
   require(status&&issue&&status.category===issue.status_category,'COMPAT_IMPORT_STATE_MISMATCH');
   require(i.dorRevisionId===null||i.dorRevisionId===issue.body_revision_id,'COMPAT_IMPORT_REVISION_MISMATCH');
   one(db,'INSERT INTO issue_compat_state VALUES(?,?,?,?,?,?,?,?,?)',i.issueId,i.statusId,i.typeId,i.typeName,i.completionReportAt,i.dorReady===null?null:Number(i.dorReady),i.dorMissingRaw,i.dorRevisionId,baseline);
  }
  return {importedIssues:issues.length};
 });
}
