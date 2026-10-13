// @module workbench
// @role controller
import {type EditingResource,type BodyDocument} from "../../modules/work/content-contracts";
import {useMemo} from 'react';
import type {Identity} from "../../modules/identity/dto";
import {IssueApi} from './issue-api';
export function useParentCommentsController({document,kind,identity,identityChanged,open,canEdit}:{document:BodyDocument;kind:'issue'|'wiki';identity:Identity;identityChanged:(i:Identity)=>void;open:(r:EditingResource,id?:string)=>void;canEdit:boolean}){
 const resource:EditingResource={kind:'comment',parentKind:kind,parentId:document.id};
 const api=useMemo(()=>new IssueApi(identity.principal.id,identityChanged,{kind:'comment',parentKind:kind,parentId:document.id}),[identity.principal.id,identityChanged,kind,document.id]);
return {document,open,canEdit,resource,api};
}
