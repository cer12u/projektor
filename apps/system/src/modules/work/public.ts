// @module work
// @role public-contract
import type {OperationJson,StoredOperationFence} from "../prepared-operations";
import type {EditingResource,WikiDocument,CommentDocument,ContentHistory} from "./content-contracts";
import type {PlannedIssue,Schedule,IssueState,TimeValue} from "./planning-contracts";
import type {ContentReference} from "./reference-contracts";
import type {ChangeOutcome,ReadOutcome,ResultOutcome} from "../change-outcomes";
export {decodeIssueChange,decodeContentChange,decodeLegacyReference,workPermissions,WORK_INPUT_LIMITS} from './rules';
export type ContentResource=Exclude<EditingResource,{kind:'issue'}>;
export interface IssueCreateInput {operationId:string;body:string;title?:string;references?:ContentReference[]}
export interface IssuePatch {body?:string;title?:string;references?:ContentReference[];parentId?:string|null;typeId?:string|null;priority?:number|null;assigneeId?:string|null;state?:IssueState;schedule?:Schedule}
export type IssueEditInput=IssuePatch&{operationId:string;revision:number};
export type IssueChange={kind:'create';projectId:string;input:IssueCreateInput}|{kind:'edit';projectId:string;issueId:string;input:IssueEditInput};
export type WikiCreateInput=IssueCreateInput;
export type WikiEditInput=Pick<IssueEditInput,'operationId'|'revision'|'body'|'title'|'references'>;
export type CommentCreateInput=Pick<IssueCreateInput,'operationId'|'body'>;
export interface CommentEditInput extends CommentCreateInput {revision:number}
export type ContentChange=
 | {kind:'create';projectId:string;resource:{kind:'wiki'};input:WikiCreateInput}
 | {kind:'edit';projectId:string;resource:{kind:'wiki'};id:string;input:WikiEditInput}
 | {kind:'create';projectId:string;resource:Extract<ContentResource,{kind:'comment'}>;input:CommentCreateInput}
 | {kind:'edit';projectId:string;resource:Extract<ContentResource,{kind:'comment'}>;id:string;input:CommentEditInput};
export interface IssueView extends PlannedIssue {title:string;references:ContentReference[];workspaceId:string|null;number:number|null;parentId:string|null;typeId:string|null;statusId:string|null;createdById:string|null;priorityKey:string|null;metadata:Record<string,OperationJson>|null;revisionOrigin:'native'|'new-import-baseline'}
export type ContentView=WikiDocument|CommentDocument;
export interface IssueListQuery {q:string;state:string;mine:boolean;page:number;pageSize:number;order:'priority'}
export interface ProjectQuery {projectId:string}
export interface IssueQuery extends ProjectQuery {issueId:string}
export interface IssueHistoryQuery extends IssueQuery {afterRevision:number;limit:number}
export interface ContentQuery extends ProjectQuery {resource:ContentResource;id:string}
export interface IssueListPage {issues:IssueView[];total:number;page:number;pageSize:number;order:'priority'}
export interface AssigneePage {principals:{id:string;kind:'human'|'agent';displayName:string}[]}
export interface IssueHistoryEntry extends ContentHistory {issueId:string;projectId:string}
export interface IssueHistoryPage {history:IssueHistoryEntry[];resolutionEvents:{revision:number;kind:string;time:TimeValue;recordedAt:string}[];nextAfterRevision:number|null;nextResolutionAfterRevision:number|null}
export interface ContentListPage {documents:ContentView[];total:number;page:number;pageSize:number}
export interface ContentHistoryPage {history:ContentHistory[];nextAfterRevision:number|null;resolutionEvents:[];nextResolutionAfterRevision:null}
export interface DirectoryView {projects:{id:string;workspaceId:string;key:string;slug:string;name:string;description:string}[];workspaces:{id:string;scopeId:string;name:string}[];definitions:{sourceTable:string;scopeId:string;record:Record<string,OperationJson>}[]}
export type LegacyReference={kind:'issue-number';projectKey:string;number:number}|{kind:'project-slug';slug:string}|{kind:'wiki-slug';slug:string};
export interface LegacyResolution {url:string;id:string;scopeId:string;content:'issue'|'wiki'|'project'}
export interface ImportedSourceQuery {scopeId:string;kind:'issues'|'wiki_pages'|'issue_comments'|'projects';id:string;page?:number}
export interface ImportedSourcePage {record:Record<string,OperationJson>;history:{sourceTable:string;sourceId:string;actorName:string|null;record:Record<string,OperationJson>}[];page:number;historyTotal:number}
/** Actor-bound commands and typed data only. Credentials, SQL and provider state stay outside. */
export interface WorkContent {
 listIssues(query:ProjectQuery&{query:IssueListQuery}):Promise<ReadOutcome<IssueListPage>>;
 listAssignees(query:ProjectQuery):Promise<ReadOutcome<AssigneePage>>;
 getIssue(query:IssueQuery):Promise<ReadOutcome<IssueView>>;
 getIssueHistory(query:IssueHistoryQuery):Promise<ReadOutcome<IssueHistoryPage>>;
 changeIssue(command:IssueChange,fence?:StoredOperationFence):Promise<ChangeOutcome<IssueView>>;
 issueResult(query:ProjectQuery&{operationId:string}):Promise<ResultOutcome<IssueView>>;
 listContent(query:ProjectQuery&{resource:ContentResource;page:number;pageSize:number}):Promise<ReadOutcome<ContentListPage>>;
 getContent(query:ContentQuery):Promise<ReadOutcome<ContentView>>;
 contentHistory(query:ContentQuery&{afterRevision:number;limit:number}):Promise<ReadOutcome<ContentHistoryPage>>;
 changeContent(command:ContentChange,fence?:StoredOperationFence):Promise<ChangeOutcome<ContentView>>;
 contentResult(query:ProjectQuery&{resource:ContentResource;operationId:string}):Promise<ResultOutcome<ContentView>>;
 directory():Promise<ReadOutcome<DirectoryView>>;
 resolveLegacy(query:LegacyReference):Promise<ReadOutcome<LegacyResolution>>;
 importedSource(query:ImportedSourceQuery):Promise<ReadOutcome<ImportedSourcePage>>;
}
