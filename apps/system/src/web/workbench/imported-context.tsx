// @module workbench
// @role composition
import {useImportedContextController} from './imported-context-controller';
import {ImportedContextView} from './imported-context-view';
import {type BodyDocument,type EditingResource} from "../../modules/work/content-contracts";
import type {IssueEditor} from './editor';
import type {AttributeDraft} from './attribute-draft';
import {Directory} from './directory-model';
export function ImportedContext({document,resource,open,editor,directory,canEdit,draft={}}:{draft?:AttributeDraft;document:BodyDocument;resource:EditingResource;open:(r:EditingResource,id?:string)=>void;editor:IssueEditor;directory:Directory|null;canEdit:boolean}){return <ImportedContextView model={useImportedContextController({document,resource,open,editor,directory,canEdit,draft})}/>;}
