import { credentialAllows,hasScope } from './resource-access.mjs';
import {issueCompatibilitySummary} from './issue-compat.mjs';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { authorized, canonical, failure, transaction } from './shared-core.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const id=x=>typeof x==='string'&&UUID.test(x);
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
const integer=x=>Number.isSafeInteger(x)&&x>=0;
const TTL=15*60*1000;
export function normalizeMyIssues(args) {
 if(!plain(args)||Object.keys(args).some(k=>!['workspaceId','workspaceEpoch','status','projectId','limit','cursor'].includes(k)))return null;
 const q={workspaceId:args.workspaceId,workspaceEpoch:args.workspaceEpoch,status:args.status===undefined?'unresolved':args.status,projectId:args.projectId??null,limit:args.limit===undefined?50:args.limit};
 if(!id(q.workspaceId)||!id(q.workspaceEpoch)||!['unresolved','all'].includes(q.status)||(q.projectId!==null&&!id(q.projectId))||!Number.isSafeInteger(q.limit)||q.limit<1||q.limit>100)return null;
 if(args.cursor!==undefined&&(typeof args.cursor!=='string'||args.cursor.length<1||args.cursor.length>2048))return null;
 return q;
}
// One predicate for page and count; ACL and assignment apply before LIMIT.
export function myIssuesPredicate(actor,q) {
 const where=[`i.deleted=0`,`q.assignee_id=?`,`EXISTS(SELECT 1 FROM project_grant g WHERE g.principal_id=? AND g.project_id=i.project_id AND g.can_read=1)`,`(q.restricted_read=0 OR EXISTS(SELECT 1 FROM issue_read_grant r WHERE r.issue_id=i.id AND r.principal_id=? AND r.can_read=1))`];
 where.push(`(NOT EXISTS(SELECT 1 FROM resource_access ra WHERE ra.resource_type='issue' AND ra.resource_id=i.id AND ra.mode='restricted') OR EXISTS(SELECT 1 FROM resource_access ra,json_each(ra.reader_principal_ids) reader WHERE ra.resource_type='issue' AND ra.resource_id=i.id AND ra.mode='restricted' AND reader.value=?))`);
 where.push(`(NOT EXISTS(SELECT 1 FROM resource_access ra WHERE ra.resource_type='issue' AND ra.resource_id=i.id) OR (EXISTS(SELECT 1 FROM principal_scope ps WHERE ps.principal_id=? AND ps.scope='issue:read') AND EXISTS(SELECT 1 FROM credential_scope cs WHERE cs.credential_id=? AND cs.scope='issue:read')))`);
 const values=[actor.principalId,actor.principalId,actor.principalId,actor.principalId,actor.principalId,actor.credentialId];
 if(q.status==='unresolved')where.push(`q.status_category NOT IN ('done','canceled')`);
 if(q.projectId!==null){where.push('i.project_id=?');values.push(q.projectId);}
 return {where:where.join(' AND '),values};
}
function encode(value){return Buffer.from(canonical(value)).toString('base64url');}
function sign(payload,key){return createHmac('sha256',Buffer.from(key,'hex')).update(payload).digest('base64url');}
function decodeCursor(cursor,key,fp,now) {
 try {
  const pieces=cursor.split('.');if(pieces.length!==2)return null;
  const [payload,signature]=pieces;
  if(!/^[A-Za-z0-9_-]+$/.test(payload)||!/^[A-Za-z0-9_-]{43}$/.test(signature))return null;
  const bytes=Buffer.from(payload,'base64url'),sig=Buffer.from(signature,'base64url');
  if(bytes.toString('base64url')!==payload||sig.toString('base64url')!==signature)return null;
  if(!timingSafeEqual(sig,Buffer.from(sign(payload,key),'base64url')))return null;
  const c=JSON.parse(bytes.toString('utf8'));
  if(!plain(c)||Object.keys(c).sort().join(',')!=='exp,fp,issued,last,revision,seq,v'||c.v!==1||c.fp!==fp||!integer(c.seq)||!integer(c.revision)||!integer(c.issued)||!integer(c.exp)||c.exp-c.issued!==TTL||now<c.issued||now>=c.exp||!Array.isArray(c.last)||c.last.length!==3||!integer(c.last[0])||c.last[0]>5||!integer(c.last[1])||!id(c.last[2]))return null;
  return c;
 }catch{return null;}
}
export function queryMyIssues(db,actor,args,now) {
 const q=normalizeMyIssues(args);if(!q)return failure('VALIDATION');
 return transaction(db,()=>{
  const at=now??Date.now();
  const denied=authorized(db,actor,q.workspaceId,q.workspaceEpoch,at);if(denied)return failure(denied);
  if(actor.source==='app_machine'&&!hasScope(db,actor,'issue:read'))return failure('FORBIDDEN');
  if(!credentialAllows(db,actor,'read'))return failure('FORBIDDEN');
  const w=db.prepare('SELECT change_seq FROM workspace WHERE id=?').get(q.workspaceId);
  const state=db.prepare('SELECT * FROM query_state WHERE id=1').get();
  if(!state||!/^[0-9a-f]{64}$/.test(state.cursor_key))return failure('UNAVAILABLE');
  const fp=createHash('sha256').update(canonical({v:1,querySchemaVersion:1,storeSchemaVersion:2,kind:'my-issues',actorId:actor.principalId,credentialId:actor.credentialId,actorKind:actor.actorKind,...q})).digest('hex');
  const cursor=args.cursor===undefined?null:decodeCursor(args.cursor,state.cursor_key,fp,at);
  if(args.cursor!==undefined&&!cursor)return failure('CURSOR_INVALID');
  const changed=Boolean(cursor&&(cursor.seq!==w.change_seq||cursor.revision!==state.revision));
  const predicate=myIssuesPredicate(actor,q);
  const from='FROM issue i JOIN issue_queue q ON q.issue_id=i.id JOIN membership a ON a.principal_id=q.assignee_id';
  const total=db.prepare(`SELECT COUNT(*) AS total ${from} WHERE ${predicate.where}`).get(...predicate.values).total;
  const tail=cursor?' AND (COALESCE(q.priority,5),q.created_at,i.id) > (?,?,?)':'';
  const rows=db.prepare(`SELECT i.id,i.project_id,i.title,i.version,q.assignee_id,a.kind AS assignee_kind,q.status_category,q.priority,q.created_at ${from} WHERE ${predicate.where}${tail} ORDER BY COALESCE(q.priority,5),q.created_at,i.id LIMIT ?`).all(...predicate.values,...(cursor?cursor.last:[]),q.limit+1);
  const items=[];let bytes=4096;
  for(const row of rows.slice(0,q.limit)){
   const item={...row,compatibility:issueCompatibilitySummary(db,row.id)},size=Buffer.byteLength(JSON.stringify(item))+1;
   if(bytes+size>900*1024)break;
   items.push(item);bytes+=size;
  }
  if(!items.length&&rows.length)return failure('RECORD_TOO_LARGE');
  const more=rows.length>items.length;
  let nextCursor=null;
  if(more){const last=items.at(-1);const payload=encode({v:1,fp,seq:cursor?.seq??w.change_seq,revision:cursor?.revision??state.revision,issued:cursor?.issued??at,exp:cursor?.exp??at+TTL,last:[last.priority??5,last.created_at,last.id]});nextCursor=`${payload}.${sign(payload,state.cursor_key)}`;}
  return {data:{items,nextCursor,total},meta:{workspaceId:q.workspaceId,actorId:actor.principalId,workspaceEpoch:q.workspaceEpoch,changeSeq:w.change_seq,visibilityVersion:state.revision,refreshRequired:changed,queryFingerprint:fp}};
 });
}
