// @module workbench
// @role model
import {resourceKey,validContentId,type EditingResource} from "../../modules/work/content-contracts";
export function documentId(resource:EditingResource,target:string){if(validContentId(resource,target))return target;const stem=resourceKey(resource)+':';return target.startsWith(stem)&&validContentId(resource,target.slice(stem.length))?target.slice(stem.length):null;}

export function storageTarget(resource:EditingResource,id:string){return resource.kind==='issue'?id:resourceKey(resource)+':'+id;}

export function newTarget(resource:EditingResource,project:string){return resource.kind==='issue'?'new:'+project:'new:'+resourceKey(resource)+':'+project;}
