// @module workbench
// @role contracts
import type {PlannedIssue,Schedule,IssueState} from "../../modules/work/planning-contracts";
import type {BodyDocument,ContentHistory} from "../../modules/work/content-contracts";
export type Issue=PlannedIssue;
export interface IssueChanges {title?:string;parentId?:string|null;typeId?:string|null;priority?:number|null;assigneeId?:string|null;state?:IssueState;schedule?:Schedule}
export interface Receipt {operationId:string;snapshot:BodyDocument;source?:'committed'|'recovered'}
export type IssueHistory=ContentHistory;
