// @module workbench
// @role composition
import {useParentCommentsController} from './parent-comments-controller';
import {ParentCommentsView} from './parent-comments-view';
import {type EditingResource,type BodyDocument} from "../../modules/work/content-contracts";
import type {Identity} from "../../modules/identity/dto";
export function ParentComments({document,kind,identity,identityChanged,open,canEdit}:{document:BodyDocument;kind:'issue'|'wiki';identity:Identity;identityChanged:(i:Identity)=>void;open:(r:EditingResource,id?:string)=>void;canEdit:boolean}){return <ParentCommentsView model={useParentCommentsController({document,kind,identity,identityChanged,open,canEdit})}/>;}
