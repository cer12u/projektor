// @module work
// @role public-contract
import type {ContentReference} from "./reference-contracts";
import type {PlannedIssue} from "./planning-contracts";
export interface BodyDocument {id:string;projectId:string|null;workspaceId?:string|null;scopeId?:string;body:string;title?:string;references?:ContentReference[];metadata?:Record<string,unknown>|null;revision:number;revisionOrigin?:'native'|'source-version'|'new-import-baseline';createdAt:string;updatedAt:string}
export type ParentKind='issue'|'wiki';
export type EditingResource={kind:'issue'}|{kind:'wiki'}|{kind:'comment';parentKind:ParentKind;parentId:string};
export interface WikiDocument extends BodyDocument {kind:'wiki'}
export interface CommentDocument extends BodyDocument {kind:'comment';parentKind:ParentKind;parentId:string}
export type HistoryIssueSnapshot=Partial<PlannedIssue>&{parentId?:string|null;typeId?:string|null};
export interface ContentHistory {revision:number;revisionOrigin?:'native'|'source-version'|'new-import-baseline';operationId:string;actorId?:string;actorName:string;beforeBody:string|null;afterBody:string;beforeTitle?:string|null;afterTitle?:string;beforeReferences?:ContentReference[]|null;afterReferences?:ContentReference[]|null;changedFields?:string[];before?:HistoryIssueSnapshot|null;after?:HistoryIssueSnapshot|null;createdAt:string;kind:string}
