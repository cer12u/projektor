import {executeCommand,failure} from './shared-core.mjs';
import {queryWiki,queryWikiRevisions,queryWikiResolve,queryLinks,queryBacklinks} from './wiki.mjs';
import {revisionProjection} from './issue-content.mjs';
const common=['workspaceId','workspaceEpoch'],plain=x=>x&&typeof x==='object'&&!Array.isArray(x);
export const wikiCommandTools=Object.freeze({wiki_create:'Wiki.Create',wiki_edit:'Wiki.Edit',wiki_rename:'Wiki.Rename',wiki_move_tree:'Wiki.MoveTree',wiki_trash:'Wiki.Trash',wiki_restore:'Wiki.Restore',wiki_restore_revision:'Wiki.RestoreRevision',content_resolve_link:'Content.ResolveLink'});
export const wikiQueryFields=Object.freeze({wiki_get:['entityId','includeDeleted'],wiki_list:['scope','search','includeDeleted','limit','cursor'],wiki_revision_get:['entityId','revisionId'],wiki_revision_list:['entityId','limit','cursor'],wiki_resolve:['scope','kind','rawKey'],links_list:['resource','linkViewId','revisionId','resourceVersion','limit','cursor'],backlinks_list:['resource','limit','cursor']});
const required={wiki_get:['entityId'],wiki_list:[],wiki_revision_get:['entityId','revisionId'],wiki_revision_list:['entityId'],wiki_resolve:['scope','kind','rawKey'],links_list:['resource'],backlinks_list:['resource']};
export function validateWikiQuery(name,args){return !Object.hasOwn(wikiQueryFields,name)||!plain(args)||Object.keys(args).some(k=>![...common,...wikiQueryFields[name]].includes(k))||[...common,...required[name]].some(k=>args[k]===undefined)||args.includeDeleted!==undefined&&typeof args.includeDeleted!=='boolean'?'VALIDATION':null;}
export function wikiQuery(db,actor,name,args,now){
 if(validateWikiQuery(name,args))return failure('VALIDATION');
 const query={wiki_get:queryWiki,wiki_list:queryWiki,wiki_revision_get:queryWikiRevisions,wiki_revision_list:queryWikiRevisions,wiki_resolve:queryWikiResolve,links_list:queryLinks,backlinks_list:queryBacklinks}[name];
 const result=query(db,actor,args,now);if(result.error)return result;
 let data=result.data;
 if(name.startsWith('wiki_revision_')){const project=r=>({...revisionProjection(r),summary:r.summary,restoredFromRevisionId:r.restoredFromRevisionId,linkView:r.linkView});data=name==='wiki_revision_get'?project(data):{...data,items:data.items.map(project)};}
 return {...result,data,meta:{...result.meta,workspaceId:args.workspaceId,workspaceEpoch:args.workspaceEpoch,actorId:actor.principalId}};
}
export function wikiMCP(db,actor,{name,arguments:args},options={}){
 const result=Object.hasOwn(wikiCommandTools,name)?args?.commandType===wikiCommandTools[name]?executeCommand(db,actor,args,options):failure('VALIDATION'):wikiQuery(db,actor,name,args,options.now);
 return {isError:Boolean(result.error),structuredContent:result};
}
