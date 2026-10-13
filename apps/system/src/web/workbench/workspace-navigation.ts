// @module workbench
// @role adapter
import {resourceKey,validContentId,type EditingResource} from "../../modules/work/content-contracts";
import {documentId,storageTarget,newTarget} from './content-target';
export function navigate(project:string,resource:EditingResource,target:string,unit?:string,mode:'replace'|'push'='replace'){
  const u=new URL(location.href),previous=readSelection(project);
  const sameTarget=u.searchParams.get('project')===project&&previous.target===target&&resourceKey(previous.resource)===resourceKey(resource);
  if(mode==='push'&&sameTarget&&(!unit||unit===u.searchParams.get('unit')))return;
  u.pathname='/';u.searchParams.set('project',project);u.searchParams.set('content',resource.kind);for(const k of['issue','wiki','comment','parentKind','parent'])u.searchParams.delete(k);
  const id=documentId(resource,target);if(id)u.searchParams.set(resource.kind,id);if(resource.kind==='comment'){u.searchParams.set('parentKind',resource.parentKind);u.searchParams.set('parent',resource.parentId);}
  if(unit)u.searchParams.set('unit',unit);else u.searchParams.delete('unit');
  if(u.href!==location.href)history[mode==='push'?'pushState':'replaceState'](null,'',u);
}

export function readSelection(project:string){const p=new URL(location.href).searchParams;let resource:EditingResource={kind:project.startsWith('workspace:')||p.get('content')==='wiki'?'wiki':'issue'};if(p.get('content')==='comment'&&(p.get('parentKind')==='issue'||p.get('parentKind')==='wiki')&&validContentId({kind:p.get('parentKind') as 'issue'|'wiki'},p.get('parent')??''))resource={kind:'comment',parentKind:p.get('parentKind') as 'issue'|'wiki',parentId:p.get('parent')!};const id=p.get(resource.kind);return{project,resource,target:id&&validContentId(resource,id)?storageTarget(resource,id):newTarget(resource,project),serial:0};}
