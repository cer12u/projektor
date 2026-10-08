import {validateContentLinkChange,carryLinkView} from './content-links.mjs';
import {contentPage} from './content-page.mjs';
import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { authorized, failure, fingerprint, HASH_VERSION, transaction } from './shared-core.mjs';
import { currentRead,currentWrite,resourceScope,resourcePolicy,scopeAllowed,hasScope,historicRead,receiptScope } from './resource-access.mjs';
import {accessProjection} from './resource-access.mjs';
const get=(db,s,...a)=>db.prepare(s).get(...a);
function run(db,s,...a){const result=db.prepare(s).run(...a);if(/^(INSERT|UPDATE)\b/.test(s)&&result.changes!==1)throw Error('Required content write invariant');return result;}
const id=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x);
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
const text=x=>typeof x==='string'&&x.isWellFormed();
const nullableId=x=>x===null||id(x);
const priority=x=>x===null||typeof x==='string'&&/^P[0-4]$/.test(x);
export const CONTENT_COMMANDS=['Issue.Create','Issue.UpdateBody','Issue.Assign','Issue.SetPriority','Issue.AddComment','Issue.EditComment'];
export function validateContent(c){
 if(!CONTENT_COMMANDS.includes(c.commandType))return 'VALIDATION';
 if(!Number.isSafeInteger(c.expectedVersion)||c.expectedVersion<(c.commandType==='Issue.Create'?0:1)||(c.commandType==='Issue.Create'&&c.expectedVersion!==0))return 'VALIDATION';
 const p=c.payload;if(!plain(p))return 'VALIDATION';
 const fields={ 'Issue.Create':['projectId','title','description','assigneeId','priority','parentId','initialStatus'],'Issue.UpdateBody':['description'],'Issue.Assign':['assigneeId'],'Issue.SetPriority':['priority'],'Issue.AddComment':['commentId','bodyMarkdown'],'Issue.EditComment':['commentId','expectedCommentVersion','bodyMarkdown']}[c.commandType];
 const optional=c.commandType==='Issue.UpdateBody'?['linkOccurrenceMap']:[];
 if(fields.some(k=>!Object.hasOwn(p,k))||Object.keys(p).some(k=>!fields.includes(k)&&!optional.includes(k)))return 'VALIDATION';
 if(c.commandType==='Issue.Create'&&(!id(p.projectId)||!text(p.title)||Buffer.byteLength(p.title)>4096||!nullableId(p.parentId)||!['backlog','ready'].includes(p.initialStatus)))return 'VALIDATION';
 if(Object.hasOwn(p,'assigneeId')&&!nullableId(p.assigneeId))return 'VALIDATION';
 if(Object.hasOwn(p,'priority')&&!priority(p.priority))return 'VALIDATION';
 if(Object.hasOwn(p,'commentId')&&!id(p.commentId))return 'VALIDATION';
 if(c.commandType==='Issue.EditComment'&&(p.commentId!==c.entityId||p.expectedCommentVersion!==c.expectedVersion))return 'VALIDATION';
 for(const k of ['description','bodyMarkdown'])if(Object.hasOwn(p,k)){if(!text(p[k]))return 'VALIDATION';if(Buffer.byteLength(p[k])>256*1024)return 'BODY_TOO_LARGE';}
 if(p.linkOccurrenceMap!==undefined&&(!Array.isArray(p.linkOccurrenceMap)||p.linkOccurrenceMap.length>4096||p.linkOccurrenceMap.some(m=>!plain(m)||Object.keys(m).sort().join(',')!=='bindingId,bindingVersion,newOrdinal,priorOccurrenceId'||!id(m.priorOccurrenceId)||!id(m.bindingId)||!Number.isSafeInteger(m.newOrdinal)||m.newOrdinal<0||!Number.isSafeInteger(m.bindingVersion)||m.bindingVersion<1)))return 'VALIDATION';
 return null;
}
export function nativeAuthor(actor){return {principalId:actor.principalId,resolution:'linked'};}
export function captureAccess(db,resource){
 const resolved=resourceScope(db,resource);if(!resolved)throw Error('Missing resource');
 let policy=resourcePolicy(db,resource);
 if(!policy){
  const q=resource.type==='issue'&&get(db,'SELECT restricted_read FROM issue_queue WHERE issue_id=?',resource.id);
  const readers=q?.restricted_read?db.prepare('SELECT principal_id FROM issue_read_grant WHERE issue_id=? AND can_read=1').all(resource.id).map(x=>x.principal_id):[];
  policy={policy_version:1,mode:q?.restricted_read?'restricted':'inherit',reader_principal_ids:JSON.stringify(readers),writer_principal_ids:'[]'};
 }
 const snapshotId=randomUUID();
 run(db,'INSERT INTO access_snapshot VALUES(?,?,?,?,?,?,?)',snapshotId,resource.type,resource.id,policy.policy_version,policy.mode,policy.reader_principal_ids,policy.writer_principal_ids);
 return {originalScope:{state:'known',scope:resolved.scope,resourcePolicyAtRevisionId:snapshotId},accessSnapshotId:snapshotId};
}
export function appendContentRevision(db,{resource,subresourceId=null,contentKind,contentMarkdown,title=null,resourceVersion,originalAuthorRef,actor,now,access}){
 const revisionId=randomUUID();
 run(db,'INSERT INTO content_revision VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',revisionId,resource.type,resource.id,subresourceId,contentKind,contentMarkdown,title,resourceVersion,JSON.stringify(originalAuthorRef),new Date(now).toISOString(),now,'exact',null,now,actor.principalId,'native',null,JSON.stringify(access.originalScope),access.accessSnapshotId);
 return revisionId;
}
function assigneeEligible(db,assigneeId,resource,scope){
 if(assigneeId===null)return true;
 const member=get(db,'SELECT * FROM membership WHERE principal_id=?',assigneeId);if(!member||member.revoked||!get(db,'SELECT 1 FROM principal_scope WHERE principal_id=? AND scope=?',assigneeId,'issue:read'))return false;
 const grant=get(db,'SELECT can_read FROM project_grant WHERE principal_id=? AND project_id=?',assigneeId,scope.projectId);if(!grant?.can_read)return false;
 const policy=resourcePolicy(db,resource);if(policy?.mode==='restricted'&&!JSON.parse(policy.reader_principal_ids).includes(assigneeId))return false;
 const q=get(db,'SELECT restricted_read FROM issue_queue WHERE issue_id=?',resource.id);
 return !q?.restricted_read||Boolean(get(db,'SELECT can_read FROM issue_read_grant WHERE issue_id=? AND principal_id=?',resource.id,assigneeId)?.can_read);
}
export function executeContentCommand(db,actor,c,{now,fault=()=>{},contentLinks=null}={}){
 const hash=fingerprint(actor,c);
 return transaction(db,()=>{
  fault('before_authorization');now??=Date.now();const denied=authorized(db,actor,c.workspaceId,c.workspaceEpoch,now);if(denied)return failure(denied);
  const old=get(db,'SELECT * FROM operation WHERE workspace_id=? AND principal_id=? AND operation_id=?',c.workspaceId,actor.principalId,c.operationId);
  if(old){if(!receiptScope(db,actor,old))return failure('FORBIDDEN');if(old.hash_version!==HASH_VERSION||old.payload_hash!==hash)return failure('KEY_REUSE');return JSON.parse(old.result_json);}
  const p=c.payload,creating=c.commandType==='Issue.Create',editing=c.commandType==='Issue.EditComment';
  const entry=editing?get(db,'SELECT * FROM issue_entry WHERE id=? AND kind=?',c.entityId,'comment'):null;
  const resource={type:'issue',id:editing?entry?.issue_id:c.entityId};
  const issue=resource.id?get(db,'SELECT * FROM issue WHERE id=?',resource.id):null;
  const projectId=creating?p.projectId:issue?.project_id;
  const scope={kind:'project',projectId};
  let access=null;
  const save=(result,{creationRejection=false,redacted=false}={})=>{
   run(db,'INSERT INTO operation VALUES(?,?,?,?,?,?,?,?)',c.workspaceId,actor.principalId,c.operationId,HASH_VERSION,hash,c.entityId,redacted?null:projectId??null,JSON.stringify(result));
   if(redacted)run(db,'INSERT INTO operation_targets VALUES(?,?,?,?)',c.workspaceId,actor.principalId,c.operationId,JSON.stringify([{redacted:true}]));
   if(!redacted){
    const a=access??(issue?captureAccess(db,resource):null);
    run(db,'INSERT INTO operation_scope VALUES(?,?,?,?,?,?,?,?)',c.workspaceId,actor.principalId,c.operationId,'issue',resource.id??c.entityId,JSON.stringify(a?.originalScope??{state:'known',scope}),a?.accessSnapshotId??null,creationRejection?1:0);
   }
   return result;
  };
  const reject=(code,options={})=>save(failure(code,'rejected'),{creationRejection:creating,...options});
  if(!scopeAllowed(db,actor,scope)||(!creating&&!currentRead(db,actor,resource)))return reject('NOT_FOUND',{redacted:true});
  if(!hasScope(db,actor,'issue:read')||!hasScope(db,actor,'issue:write')||!scopeAllowed(db,actor,scope,'write')||(!creating&&!currentWrite(db,actor,resource)))return reject('FORBIDDEN');
  if(c.commandType.includes('Comment')&&!hasScope(db,actor,'comment:write'))return reject('FORBIDDEN');
  if(creating){
   if(!get(db,'SELECT id FROM project WHERE id=? AND deleted=0',p.projectId))return reject('PROJECT_NOT_FOUND');
   if(issue)return reject('ENTITY_EXISTS');
   if(!p.title.trim())return reject('TITLE_EMPTY');
   if(p.parentId!==null){
    const parent=get(db,'SELECT * FROM issue WHERE id=?',p.parentId);
    if(!parent||parent.project_id!==p.projectId||!currentWrite(db,actor,{type:'issue',id:p.parentId}))return reject('PARENT_INVALID');
    let next=p.parentId,depth=1;const seen=new Set([c.entityId]);
    while(next){if(seen.has(next)||depth++>=32)return reject('PARENT_INVALID');seen.add(next);next=get(db,'SELECT parent_id FROM issue_content WHERE issue_id=?',next)?.parent_id;}
   }
  }else if(!issue||issue.deleted||editing&&(!entry||entry.deleted_at))return reject('NOT_FOUND',{redacted:true});
  if((editing?entry.version:creating?0:issue.version)!==c.expectedVersion)return reject('VERSION_CONFLICT');
  if(editing&&JSON.parse(entry.author_ref).principalId!==actor.principalId&&!hasScope(db,actor,'comment:moderate'))return reject('COMMENT_FORBIDDEN');
  if(c.commandType==='Issue.AddComment'&&get(db,'SELECT id FROM issue_entry WHERE id=?',p.commentId))return reject('COMMENT_EXISTS');
  if((creating||c.commandType==='Issue.Assign')&&!assigneeEligible(db,p.assigneeId,resource,scope))return reject('ASSIGNEE_INVALID');
  if(Object.hasOwn(p,'bodyMarkdown')&&!p.bodyMarkdown.trim())return reject('CONTENT_EMPTY');
  if(p.linkOccurrenceMap?.length&&!contentLinks)return reject('LINK_INTEGRATION_UNAVAILABLE');
  const currentContent=issue&&get(db,'SELECT * FROM issue_content WHERE issue_id=?',issue.id);
  const previousRevision=editing?get(db,'SELECT * FROM content_revision WHERE id=?',entry.current_revision_id):currentContent?.body_revision_id?get(db,'SELECT * FROM content_revision WHERE id=?',currentContent.body_revision_id):null;
  const queue=issue&&get(db,'SELECT * FROM issue_queue WHERE issue_id=?',issue.id);
  const noop=c.commandType==='Issue.UpdateBody'&&previousRevision?.content_markdown===p.description&&!p.linkOccurrenceMap?.length||editing&&previousRevision?.content_markdown===p.bodyMarkdown||c.commandType==='Issue.Assign'&&queue&&queue.assignee_id===p.assigneeId||c.commandType==='Issue.SetPriority'&&queue&&queue.priority===(p.priority===null?null:Number(p.priority.slice(1)));
  const meta={workspaceId:c.workspaceId,actorId:actor.principalId,operationId:c.operationId};
  if(noop)return save({data:{outcome:'committed',effectApplied:false,entityId:c.entityId,committedVersion:editing?entry.version:issue.version,commitSeq:get(db,'SELECT change_seq FROM workspace WHERE id=?',c.workspaceId).change_seq,serverTime:now,revisionId:previousRevision?.id??null},meta});
  if(c.commandType==='Issue.UpdateBody'&&contentLinks){const invalid=validateContentLinkChange({db,resource,previousRevision,resourceVersion:issue.version+1,markdown:p.description,linkOccurrenceMap:p.linkOccurrenceMap??[]});if(invalid)return reject(invalid);}
  fault('before_issue');
  const version=creating?1:editing?entry.version+1:issue.version+1;
  if(creating){
   run(db,'INSERT INTO issue VALUES(?,?,?,1,0)',c.entityId,p.projectId,p.title);
   const counter=get(db,'SELECT next_number FROM project_issue_counter WHERE project_id=?',p.projectId);
   const number=counter?.next_number??1;
   if(counter)run(db,'UPDATE project_issue_counter SET next_number=next_number+1 WHERE project_id=?',p.projectId);else run(db,'INSERT INTO project_issue_counter VALUES(?,?)',p.projectId,2);
   run(db,'INSERT INTO issue_number VALUES(?,?,?)',c.entityId,p.projectId,number);
   run(db,'INSERT INTO resource_access VALUES(?,?,1,?,?,?)','issue',c.entityId,'inherit','[]','[]');run(db,'INSERT INTO resource_access_identity VALUES(?,?,?)','issue',c.entityId,randomUUID());
   run(db,'INSERT INTO issue_queue VALUES(?,?,?,?,?,0)',c.entityId,p.assigneeId,p.initialStatus,p.priority===null?null:Number(p.priority.slice(1)),now);
   run(db,'INSERT INTO issue_content VALUES(?,?,?,?,?)',c.entityId,null,JSON.stringify(nativeAuthor(actor)),p.parentId,now);
  }else if(!editing){if(run(db,'UPDATE issue SET version=version+1 WHERE id=? AND version=?',issue.id,c.expectedVersion).changes!==1)throw Error('CAS failed');}
  fault('after_issue');
  access=captureAccess(db,resource);
  let revisionId=null;
  if(creating||c.commandType==='Issue.UpdateBody'){
   revisionId=appendContentRevision(db,{resource,contentKind:'issue_body',contentMarkdown:p.description,title:creating?p.title:issue.title,resourceVersion:version,originalAuthorRef:nativeAuthor(actor),actor,now,access});
   if(!creating&&!currentContent)run(db,'INSERT INTO issue_content VALUES(?,?,?,?,?)',issue.id,null,JSON.stringify({resolution:'unknown'}),null,null);
   run(db,'UPDATE issue_content SET body_revision_id=? WHERE issue_id=?',revisionId,resource.id);
   contentLinks?.({db,resource,previousRevision,newRevisionId:revisionId,resourceVersion:version,markdown:p.description,linkOccurrenceMap:p.linkOccurrenceMap??[],access,actor});
  }
  if(c.commandType==='Issue.AddComment'||editing){
   const author=editing?JSON.parse(entry.author_ref):nativeAuthor(actor);
   revisionId=appendContentRevision(db,{resource,subresourceId:p.commentId,contentKind:'comment',contentMarkdown:p.bodyMarkdown,resourceVersion:editing?issue.version:version,originalAuthorRef:author,actor,now,access});
   if(editing){if(run(db,'UPDATE issue_entry SET version=version+1,current_revision_id=?,edited_at=? WHERE id=? AND version=?',revisionId,now,p.commentId,c.expectedVersion).changes!==1)throw Error('Comment CAS failed');}
   else run(db,'INSERT INTO issue_entry VALUES(?,?,?,?,?,?,?,?,?)',p.commentId,issue.id,'comment',1,revisionId,JSON.stringify(author),now,null,null);
  }
  if(c.commandType==='Issue.Assign'||c.commandType==='Issue.SetPriority'){
   if(!queue)throw Error('Missing queue provenance');
   if(c.commandType==='Issue.Assign')run(db,'UPDATE issue_queue SET assignee_id=? WHERE issue_id=?',p.assigneeId,issue.id);
   else run(db,'UPDATE issue_queue SET priority=? WHERE issue_id=?',p.priority===null?null:Number(p.priority.slice(1)),issue.id);
  }
  if(!creating&&!editing&&c.commandType!=='Issue.UpdateBody'&&contentLinks)carryLinkView(db,{resource,fromVersion:issue.version,resourceVersion:version,access});
  fault('after_revision');
  run(db,'UPDATE workspace SET change_seq=change_seq+1 WHERE id=?',c.workspaceId);
  const seq=get(db,'SELECT change_seq FROM workspace WHERE id=?',c.workspaceId).change_seq;fault('after_sequence');
  const title=creating?p.title:issue.title;
  run(db,'INSERT INTO activity VALUES(?,?,?,?,?,?,?)',seq,resource.id,c.operationId,actor.principalId,creating?'':title,title,editing?issue.version:version);
  run(db,'INSERT INTO content_activity VALUES(?,?,?,?,?,?,?,?,?)',seq,'issue',resource.id,c.commandType,p.commentId??null,revisionId,editing?entry.author_ref:JSON.stringify(nativeAuthor(actor)),actor.principalId,JSON.stringify({version}));fault('after_activity');
  run(db,'DELETE FROM issue_fts WHERE issue_id=?',resource.id);
  if(revisionId)run(db,'DELETE FROM content_fts WHERE resource_type=? AND resource_id=? AND subresource_id IS ?','issue',resource.id,p.commentId??null);
  fault('after_fts_delete');
  run(db,'INSERT INTO issue_fts VALUES(?,?)',resource.id,title.normalize('NFKC').toLowerCase());
  if(revisionId)run(db,'INSERT INTO content_fts VALUES(?,?,?,?)','issue',resource.id,p.commentId??null,(p.description??p.bodyMarkdown).normalize('NFKC').toLowerCase());fault('after_fts_insert');
  run(db,'INSERT INTO outbox VALUES(?,?,?,?)',`${actor.principalId}:${c.operationId}`,seq,JSON.stringify({issueId:resource.id,entityId:c.entityId,version,revisionId}),'pending');fault('after_outbox');
  const result=save({data:{outcome:'committed',effectApplied:true,entityId:c.entityId,issueId:resource.id,committedVersion:version,commitSeq:seq,serverTime:now,revisionId,...(p.commentId?{commentId:p.commentId,commentVersion:editing?version:1}:{})},meta});fault('after_receipt');return result;
 });
}
export function issueProjection(db,row,actor){
 const c=get(db,'SELECT * FROM issue_content WHERE issue_id=?',row.id);if(!c)return row;
 const r=c.body_revision_id&&get(db,'SELECT * FROM content_revision WHERE id=?',c.body_revision_id),q=get(db,'SELECT * FROM issue_queue WHERE issue_id=?',row.id);
 const resolution=get(db,'SELECT * FROM issue_resolution WHERE issue_id=?',row.id);
 return {...row,...accessProjection(db,actor,{type:'issue',id:row.id}),resolutionKind:resolution?.resolution_kind??null,resolvedAt:resolution?.resolved_at??null,currentResolutionRecordId:resolution?.current_record_id??null,number:get(db,'SELECT number FROM issue_number WHERE issue_id=?',row.id)?.number??null,description:r?.content_markdown??null,bodyRevisionId:c.body_revision_id,authorRef:JSON.parse(c.author_ref),parentId:c.parent_id,assigneeId:q?.assignee_id??null,priority:q?.priority==null?null:`P${q.priority}`,status:q?.status_category??null};
}
function query(db,actor,args,now,fn,kind){const allowed=['workspaceId','workspaceEpoch',...(kind==='archive'?['sourceMappingId']:kind==='history'?['entityId','revisionId','cursor','limit']:kind==='entries'?['entityId','cursor','limit']:['entityId'])];if(!plain(args)||args.cursor!==undefined&&(typeof args.cursor!=='string'||args.cursor.length<1||args.cursor.length>2048)||args.limit!==undefined&&(!Number.isSafeInteger(args.limit)||args.limit<1||args.limit>100)||Object.keys(args).some(k=>!allowed.includes(k))||!id(args.workspaceId)||!id(args.workspaceEpoch)||args.entityId!==undefined&&!id(args.entityId)||args.revisionId!==undefined&&!id(args.revisionId)||['entries','history'].includes(kind)&&!id(args.entityId))return failure('VALIDATION');return transaction(db,()=>{const denied=authorized(db,actor,args.workspaceId,args.workspaceEpoch,now??Date.now());if(denied)return failure(denied);return fn();});}
export function queryProjects(db,actor,args,now){return query(db,actor,args,now,()=>{if(!get(db,'SELECT can_read FROM credential WHERE id=?',actor.credentialId)?.can_read)return failure('FORBIDDEN');const rows=db.prepare('SELECT * FROM project WHERE deleted=0 ORDER BY id').all().filter(r=>scopeAllowed(db,actor,{kind:'project',projectId:r.id}));if(args.entityId)return rows.find(r=>r.id===args.entityId)?{data:rows.find(r=>r.id===args.entityId)}:failure('NOT_FOUND');return {data:{items:rows,nextCursor:null}};});}
export function queryIssueEntries(db,actor,args,now){return query(db,actor,args,now,()=>{
 if(!currentRead(db,actor,{type:'issue',id:args.entityId}))return failure('NOT_FOUND');
 const rows=db.prepare('SELECT * FROM issue_entry WHERE issue_id=? AND deleted_at IS NULL ORDER BY created_at,id').all(args.entityId).filter(e=>e.kind==='comment'||historicRead(db,actor,get(db,'SELECT * FROM content_revision WHERE id=?',e.current_revision_id)));
 return contentPage(db,actor,rows,args,'entries',e=>({id:e.id,issueId:e.issue_id,kind:e.kind,version:e.version,currentRevisionId:e.current_revision_id,authorRef:JSON.parse(e.author_ref),createdAt:e.created_at,editedAt:e.edited_at,...(e.kind!=='comment'?{workflow:JSON.parse(get(db,'SELECT payload FROM workflow_entry WHERE entry_id=?',e.id).payload)}:{}),bodyMarkdown:get(db,'SELECT content_markdown FROM content_revision WHERE id=?',e.current_revision_id)?.content_markdown??null}),now);
 },'entries');}
export function revisionProjection(r){return {id:r.id,resource:{type:r.resource_type,id:r.resource_id},subresourceId:r.subresource_id,contentKind:r.content_kind,contentMarkdown:r.content_markdown,title:r.title,resourceVersionAtCommit:r.resource_version_at_commit,originalAuthorRef:JSON.parse(r.original_author_ref),occurredAtRaw:r.occurred_at_raw,occurredAtNormalized:r.occurred_at_normalized,timeQuality:r.time_quality,sourceEditedAtRaw:r.source_edited_at_raw,recordedAt:r.recorded_at,recordedBy:r.recorded_by,origin:r.origin,sourceMappingId:r.source_mapping_id,originalScope:JSON.parse(r.original_scope),accessSnapshotId:r.access_snapshot_id};}
export function queryContentRevisions(db,actor,args,now){return query(db,actor,args,now,()=>{if(!currentRead(db,actor,{type:'issue',id:args.entityId},{allowDeleted:true}))return failure('NOT_FOUND');if(!hasScope(db,actor,'history:read'))return failure('FORBIDDEN');const rows=db.prepare('SELECT * FROM content_revision WHERE resource_type=? AND resource_id=? ORDER BY recorded_at,id').all('issue',args.entityId).filter(r=>historicRead(db,actor,r));if(args.revisionId){const row=rows.find(r=>r.id===args.revisionId);return row?{data:revisionProjection(row)}:failure('NOT_FOUND');}const coverage=db.prepare('SELECT * FROM history_coverage WHERE resource_type=? AND resource_id=?').all('issue',args.entityId);const page=contentPage(db,actor,rows,args,'revisions',revisionProjection,now);if(page.data)page.data.coverage=coverage;return page;},'history');}
export function queryArchiveRecord(db,actor,args,now){return query(db,actor,args,now,()=>{if(!id(args.sourceMappingId))return failure('VALIDATION');if(!hasScope(db,actor,'archive:read')||!get(db,'SELECT 1 FROM archive_grant WHERE source_mapping_id=? AND principal_id=?',args.sourceMappingId,actor.principalId))return failure('NOT_FOUND');const row=get(db,'SELECT * FROM source_mapping WHERE id=?',args.sourceMappingId);if(!row||!['issue','comment','wiki'].includes(row.source_entity_type))return failure('NOT_FOUND');run(db,'INSERT INTO archive_access_audit VALUES(?,?,?,?)',randomUUID(),row.id,actor.principalId,now??Date.now());return {data:row};},'archive');}
