import {isID,type LegacyTarget,type ProductPorts,type Selected} from './contracts.ts';
import {parseRoute,UIRouter} from './router.ts';

/** The response is data, never an arbitrary redirect instruction. */
export function legacyNativePath(target:Pick<LegacyTarget,'kind'|'id'>,workspaceId:string):string{
  if(!isID(workspaceId)||!isID(target?.id)||!['issue','wiki','project'].includes(target?.kind))throw Error('LEGACY_URL_UNAVAILABLE');
  const view=target.kind==='wiki'?'wiki-page':target.kind;
  const field=target.kind==='wiki'?'pageId':target.kind==='issue'?'issueId':'projectId';
  return `/?view=${view}&workspaceId=${workspaceId}&${field}=${target.id}`;
}
export function boundLegacyTarget(body:any,selected:Selected):LegacyTarget{
  const data=body?.data,meta=body?.meta;
  if(meta?.workspaceId!==selected.workspace.id||meta?.workspaceEpoch!==selected.workspace.epoch||meta?.actorId!==selected.principal.id)throw Error('LEGACY_URL_UNAVAILABLE');
  if(data?.canonicalPath!==legacyNativePath(data,selected.workspace.id))throw Error('LEGACY_URL_UNAVAILABLE');
  return {kind:data.kind,id:data.id,canonicalPath:data.canonicalPath};
}
/** App calls only after bootstrap selected an authorized workspace. Abort on
 * principal, epoch, access revision or visibility changes; router generation
 * also prevents an older response from replacing newer navigation. */
export async function resolveLegacyNavigation(router:UIRouter,ports:ProductPorts,selected:Selected,{signal,visible=()=>true}:{signal:AbortSignal;visible?:()=>boolean}):Promise<'resolved'|'unavailable'|'stale'>{
  const path=router.legacyPath,generation=router.navigationGeneration;
  const current=()=>!signal.aborted&&visible()&&!router.busy&&router.legacyPath===path&&router.navigationGeneration===generation&&router.route.workspaceId===selected.workspace.id;
  if(!path||!current())return 'stale';
  try{
    if(!ports.legacyURL)throw Error('LEGACY_URL_UNAVAILABLE');
    const target=await ports.legacyURL(selected,{path,signal});
    if(!current())return 'stale';
    if(target.canonicalPath!==legacyNativePath(target,selected.workspace.id))throw Error('LEGACY_URL_UNAVAILABLE');
    return router.resolveLegacy(parseRoute(legacyNativePath(target,selected.workspace.id)),path,generation)?'resolved':'stale';
  }catch{return current()?'unavailable':'stale';}
}
