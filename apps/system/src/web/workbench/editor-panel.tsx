// @module workbench
// @role composition
import {useEditorPanelController} from './editor-panel-controller';
import {EditorPanelView} from './editor-panel-view';
import type {Directory} from './directory-model';
import {type EditingResource} from "../../modules/work/content-contracts";
import type {Identity} from "../../modules/identity/dto";
import {IssueEditor} from './editor';
export function EditorPanel({directory,editor,canEdit,identity,zone,identityChanged,openContent}:{directory:Directory|null;editor:IssueEditor;canEdit:boolean;identity:Identity;zone:string;identityChanged:(i:Identity)=>void;openContent:(r:EditingResource,id?:string)=>void}){return <EditorPanelView model={useEditorPanelController({directory,editor,canEdit,identity,zone,identityChanged,openContent})}/>;}
