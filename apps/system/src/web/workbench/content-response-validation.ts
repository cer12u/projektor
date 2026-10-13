// @module workbench
// @role model
import type {Issue} from './editor-contracts';
import {validContentId,type EditingResource,type BodyDocument} from "../../modules/work/content-contracts";
export function isIssue(value:unknown):value is Issue{
  if(!value||typeof value!=='object')return false;const v=value as Partial<Issue>;
  return typeof v.id==='string'&&validContentId({kind:'issue'},v.id)&&typeof v.projectId==='string'&&typeof v.body==='string'
    &&typeof v.revision==='number'&&Number.isSafeInteger(v.revision)&&v.revision>0&&typeof v.createdAt==='string'&&typeof v.updatedAt==='string';
}
export function validContentResponse(resource:EditingResource,value:unknown):value is BodyDocument{if(resource.kind==='issue')return isIssue(value);if(!value||typeof value!=='object')return false;const v=value as BodyDocument&{kind?:string;parentKind?:string;parentId?:string};return typeof v.id==='string'&&validContentId(resource,v.id)&&(typeof v.projectId==='string'||(v.projectId===null&&typeof v.workspaceId==='string'))&&typeof v.body==='string'&&Number.isSafeInteger(v.revision)&&v.revision>0&&typeof v.createdAt==='string'&&typeof v.updatedAt==='string'&&v.kind===resource.kind&&(resource.kind!=='comment'||(v.parentKind===resource.parentKind&&v.parentId===resource.parentId));}
