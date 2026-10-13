// @module work
// @role public-contract
import type {ChangeOutcome,ReadOutcome,ResultOutcome} from '../change-outcomes';
import type {StoredOperationFence} from '../prepared-operations';
export interface WorkspaceSnapshot {kind:'workspace';id:string;scopeId:string;name:string;revision:number}
export interface ProjectSnapshot {kind:'project';id:string;workspaceId:string;key:string;slug:string;name:string;description:string;revision:number}
export type DirectoryEntity=WorkspaceSnapshot|ProjectSnapshot;
export type DirectoryChange=
 | {kind:'workspace';action:'create';input:{operationId:string;name:string}}
 | {kind:'workspace';action:'edit';id:string;input:{operationId:string;revision:number;name:string}}
 | {kind:'project';action:'create';input:{operationId:string;workspaceId:string;key:string;slug:string;name:string;description:string}}
 | {kind:'project';action:'edit';id:string;input:{operationId:string;revision:number;name?:string;description?:string}};
export interface DirectoryQuery {kind:'project'|'workspace';id:string}
export interface DirectoryHistory {nextAfterRevision:number|null;history:{revision:number;operationId:string;actorId:string;recordedAt:string;before:DirectoryEntity|null;after:DirectoryEntity}[]}
export interface DirectoryManagement {canCreate:boolean;projects:ProjectSnapshot[];workspaces:WorkspaceSnapshot[]}
export interface WorkDirectory {
 changeDirectory(command:DirectoryChange,fence?:StoredOperationFence):Promise<ChangeOutcome<DirectoryEntity>>;
 directoryEntity(query:DirectoryQuery):Promise<ReadOutcome<DirectoryEntity>>;
 directoryHistory(query:DirectoryQuery&{afterRevision?:number;limit?:number}):Promise<ReadOutcome<DirectoryHistory>>;
 directoryResult(query:{operationId:string}):Promise<ResultOutcome<DirectoryEntity>>;
}
