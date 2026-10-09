import {randomUUID} from 'node:crypto';
import {currentRead,resourceScope,scopeAllowed,historicRead,originalRead} from './resource-access.mjs';
const get=(db,s,...a)=>db.prepare(s).get(...a);
const run=(db,s,...a)=>{const r=db.prepare(s).run(...a);if(r.changes!==1)throw Error('Required link write suppressed');return r;};
import {PARSER_VERSION,parseContentLinks} from './link-parser.mjs';
export {PARSER_VERSION,parseContentLinks} from './link-parser.mjs';
export const scopeKey=s=>s.kind==='project'?JSON.stringify({kind:'project',projectId:s.projectId}):JSON.stringify({kind:'workspace_shared'});
export function resolveWikiAlias(db,actor,{scope,kind,rawKey}){
 if(!scopeAllowed(db,actor,scope))return {resolution:'unresolved',targetResource:null};
 const key=kind==='slug'?rawKey.normalize('NFC'):rawKey;
 const candidates=db.prepare('SELECT target_page_id FROM wiki_alias WHERE scope=? AND kind=? AND comparison_key=?').all(scopeKey(scope),kind,key).filter(x=>currentRead(db,actor,{type:'wiki',id:x.target_page_id}));
 const ids=[...new Set(candidates.map(x=>x.target_page_id))];return {resolution:ids.length===1?'resolved':ids.length?'ambiguous':'unresolved',targetResource:ids.length===1?{type:'wiki',id:ids[0]}:null};
}
function initialDecision(db,actor,scope,occ){
 if(occ.kind==='stable_id'){const [,type,id]=/^projektor:(wiki|issue)\/(.+)$/.exec(occ.rawTarget);const target={type,id};return currentRead(db,actor,target)?{resolution:'resolved',targetResource:target}:{resolution:'unresolved',targetResource:null};}
 if(occ.kind==='title')return resolveWikiAlias(db,actor,{scope,kind:'title',rawKey:occ.rawTarget});
 return resolveWikiAlias(db,actor,{scope,kind:'legacy_url',rawKey:occ.rawTarget});
}
export function currentLinkView(db,resource,version){return get(db,'SELECT * FROM link_view WHERE resource_type=? AND resource_id=? AND resource_version=?',resource.type,resource.id,version);}
export function linkDecisions(db,view){if(!view)return [];const rows=db.prepare('SELECT occurrence_id AS occurrenceId,binding_id AS bindingId,binding_version AS bindingVersion FROM link_view_decision WHERE link_view_id=? ORDER BY ordinal').all(view.id);return rows.length?rows:JSON.parse(view.decisions);}
function saveView(db,{resource,resourceVersion,revisionId,decisions,access}){
 const viewId=randomUUID();run(db,'INSERT INTO link_view VALUES(?,?,?,?,?,?,?,?)',viewId,resource.type,resource.id,resourceVersion,revisionId,'[]',JSON.stringify(access.originalScope),access.accessSnapshotId);for(let ordinal=0;ordinal<decisions.length;ordinal++){const d=decisions[ordinal];run(db,'INSERT INTO link_view_decision VALUES(?,?,?,?,?)',viewId,ordinal,d.occurrenceId,d.bindingId,d.bindingVersion);}return viewId;
}
function invalid(){const e=Error('Invalid link occurrence mapping');e.code='LINK_MAPPING_INVALID';throw e;}
export function validateContentLinkChange({db,resource,previousRevision,resourceVersion,markdown,linkOccurrenceMap=[]}){
 const parsed=parseContentLinks(markdown),view=previousRevision?currentLinkView(db,resource,resourceVersion-1):null,mapped=new Set(),used=new Set(),viewPairs=new Map(linkDecisions(db,view).map(d=>[d.occurrenceId,d]));
 for(const m of linkOccurrenceMap){
  const prior=get(db,'SELECT * FROM link_occurrence WHERE id=?',m.priorOccurrenceId),pair=viewPairs.get(m.priorOccurrenceId);
  if(mapped.has(m.newOrdinal)||used.has(m.priorOccurrenceId)||!prior||prior.source_type!==resource.type||prior.source_id!==resource.id||prior.source_revision_id!==previousRevision?.id||!parsed[m.newOrdinal]||prior.raw_target!==parsed[m.newOrdinal].rawTarget||prior.kind!==parsed[m.newOrdinal].kind||!pair||pair.bindingId!==m.bindingId||pair.bindingVersion!==m.bindingVersion)return 'LINK_MAPPING_INVALID';
  mapped.add(m.newOrdinal);used.add(m.priorOccurrenceId);
 }
 return null;
}
export function validateResolveContentLink(db,{actor,resource,resourceVersion,payload:p}){
 const old=currentLinkView(db,resource,resourceVersion-1),pair=old&&linkDecisions(db,old).find(x=>x.occurrenceId===p.occurrenceId);
 if(!old||old.source_revision_id!==p.sourceRevisionId||!pair||pair.bindingVersion!==p.expectedBindingVersion||!currentRead(db,actor,p.targetResource))return 'LINK_MAPPING_INVALID';
 const occurrence=get(db,'SELECT * FROM link_occurrence WHERE id=?',p.occurrenceId);
 return !occurrence||occurrence.source_type!==resource.type||occurrence.source_id!==resource.id||occurrence.source_revision_id!==p.sourceRevisionId?'LINK_MAPPING_INVALID':null;
}
export function captureContentLinks({db,resource,previousRevision,newRevisionId,resourceVersion,markdown,linkOccurrenceMap=[],access,actor,restoreRevisionId=null}){
 const validation=validateContentLinkChange({db,resource,previousRevision,resourceVersion,markdown,linkOccurrenceMap});if(validation)invalid();
 const scope=resourceScope(db,resource).scope;
 const oldView=previousRevision?currentLinkView(db,resource,resourceVersion-1):null;
 const parsed=parseContentLinks(markdown),maps=new Map(),used=new Set(),oldPairs=new Map(linkDecisions(db,oldView).map(d=>[d.occurrenceId,d]));
 let restoreView=null;
 if(restoreRevisionId){const ref=get(db,'SELECT link_view_id FROM revision_link_view WHERE revision_id=?',restoreRevisionId);restoreView=ref&&get(db,'SELECT * FROM link_view WHERE id=?',ref.link_view_id);if(!restoreView)invalid();}
 for(const m of linkOccurrenceMap){
  if(maps.has(m.newOrdinal)||used.has(m.priorOccurrenceId)||!oldView)invalid();
  const prior=get(db,'SELECT * FROM link_occurrence WHERE id=?',m.priorOccurrenceId),pair=oldPairs.get(m.priorOccurrenceId);
  if(!prior||prior.source_type!==resource.type||prior.source_id!==resource.id||prior.source_revision_id!==previousRevision.id||!parsed[m.newOrdinal]||prior.raw_target!==parsed[m.newOrdinal].rawTarget||prior.kind!==parsed[m.newOrdinal].kind||!pair||pair.bindingId!==m.bindingId||pair.bindingVersion!==m.bindingVersion)invalid();
  maps.set(m.newOrdinal,pair);used.add(m.priorOccurrenceId);
 }
 const decisions=[],restorePairs=restoreView?new Map(linkDecisions(db,restoreView).map(d=>[d.occurrenceId,d])):null;
 for(const occ of parsed){
  let inherited=maps.get(occ.ordinal);
  if(restoreView){const previous=get(db,'SELECT * FROM link_occurrence WHERE source_revision_id=? AND ordinal=?',restoreRevisionId,occ.ordinal);if(!previous||previous.raw_target!==occ.rawTarget||previous.kind!==occ.kind)invalid();inherited=restorePairs.get(previous.id);if(!inherited)invalid();}
  let bindingId=inherited?.bindingId,bindingVersion=inherited?.bindingVersion;
  if(!inherited){bindingId=randomUUID();bindingVersion=1;const decision=previousRevision?{resolution:'unresolved',targetResource:null}:initialDecision(db,actor,scope,occ);run(db,'INSERT INTO link_binding VALUES(?,?,?,?,?,?,?,?,?,?)',bindingId,1,resource.type,resource.id,occ.rawTarget,scopeKey(scope),decision.targetResource?.type??null,decision.targetResource?.id??null,decision.resolution,previousRevision?'edit_requires_explicit_resolution':'initial_parser_v1');}
  const occurrenceId=randomUUID();run(db,'INSERT INTO link_occurrence VALUES(?,?,?,?,?,?,?,?,?,?)',occurrenceId,resource.type,resource.id,newRevisionId,occ.ordinal,occ.rawTarget,occ.kind,bindingId,bindingVersion,PARSER_VERSION);decisions.push({occurrenceId,bindingId,bindingVersion});
 }
 const linkViewId=saveView(db,{resource,resourceVersion,revisionId:newRevisionId,decisions,access});run(db,'INSERT INTO revision_link_view VALUES(?,?)',newRevisionId,linkViewId);return linkViewId;
}
export function carryLinkView(db,{resource,fromVersion,resourceVersion,access}){
 const view=currentLinkView(db,resource,fromVersion);if(!view)return null;return saveView(db,{resource,resourceVersion,revisionId:view.source_revision_id,decisions:linkDecisions(db,view),access});
}
export function resolveContentLinkDecision(db,{actor,resource,resourceVersion,payload,access}){
 if(validateResolveContentLink(db,{actor,resource,resourceVersion,payload}))invalid();
 const old=currentLinkView(db,resource,resourceVersion-1),p=payload;
 if(!old||old.source_revision_id!==p.sourceRevisionId)invalid();
 const decisions=linkDecisions(db,old),pair=decisions.find(x=>x.occurrenceId===p.occurrenceId);
 if(!pair||pair.bindingVersion!==p.expectedBindingVersion)invalid();
 const occurrence=get(db,'SELECT * FROM link_occurrence WHERE id=?',p.occurrenceId);
 if(!occurrence||occurrence.source_revision_id!==p.sourceRevisionId||!currentRead(db,actor,p.targetResource))invalid();
 const binding=get(db,'SELECT * FROM link_binding WHERE id=? AND version=?',pair.bindingId,pair.bindingVersion);
 const next=get(db,'SELECT MAX(version) AS n FROM link_binding WHERE id=?',pair.bindingId).n+1;
 run(db,'INSERT INTO link_binding VALUES(?,?,?,?,?,?,?,?,?,?)',pair.bindingId,next,resource.type,resource.id,binding.raw_target,binding.lookup_scope,p.targetResource.type,p.targetResource.id,'resolved','explicit_command');
 return saveView(db,{resource,resourceVersion,revisionId:old.source_revision_id,decisions:decisions.map(x=>x.occurrenceId===p.occurrenceId?{...x,bindingVersion:next}:x),access});
}
export function projectLinkView(db,actor,view,{historic=false}={}){
 if(!view||!originalRead(db,actor,view.original_scope,view.access_snapshot_id,{type:view.resource_type,id:view.resource_id})||!currentRead(db,actor,{type:view.resource_type,id:view.resource_id},{allowDeleted:historic})||historic&&!historicRead(db,actor,view))return null;
 return {id:view.id,resourceVersion:view.resource_version,sourceRevisionId:view.source_revision_id,items:(view.projectedDecisions??linkDecisions(db,view)).map(pair=>{const o=get(db,'SELECT * FROM link_occurrence WHERE id=?',pair.occurrenceId),b=get(db,'SELECT * FROM link_binding WHERE id=? AND version=?',pair.bindingId,pair.bindingVersion),target=b.target_id?{type:b.target_type,id:b.target_id}:null;const visible=target&&currentRead(db,actor,target);return {...pair,ordinal:o.ordinal,rawTarget:o.raw_target,kind:o.kind,resolution:target&&!visible?'not_available':b.resolution,targetResource:visible?target:null};})};
}
export function backlinks(db,actor,target){
 if(!currentRead(db,actor,target))return null;
 const views=db.prepare('SELECT v.* FROM link_view v WHERE NOT EXISTS(SELECT 1 FROM link_view n WHERE n.resource_type=v.resource_type AND n.resource_id=v.resource_id AND n.resource_version>v.resource_version)').all();
 return views.filter(v=>projectLinkView(db,actor,{...v,projectedDecisions:[]})!==null).flatMap(v=>linkDecisions(db,v).filter(d=>{const b=get(db,'SELECT * FROM link_binding WHERE id=? AND version=?',d.bindingId,d.bindingVersion);return b.target_type===target.type&&b.target_id===target.id;}).map(d=>({sourceResource:{type:v.resource_type,id:v.resource_id},occurrenceId:d.occurrenceId,linkViewId:v.id})));
}
