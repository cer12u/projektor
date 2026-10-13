// @module workbench
// @role composition
import {useIssueAttributesController} from './issue-attributes-controller';
import {IssueAttributesView} from './issue-attributes-view';
import type {Identity} from "../../modules/identity/dto";
import type {IssueEditor} from './editor';
import {type Issue} from './editor-contracts';
export function IssueAttributes({editor,issue,identity,disabled,zone}:{editor:IssueEditor;issue:Issue;identity:Identity;disabled:boolean;zone:string}){return <IssueAttributesView model={useIssueAttributesController({editor,issue,identity,disabled,zone})}/>;}
