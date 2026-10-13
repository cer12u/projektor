// @module persistence
// @role public-contract
/** Public durable-operation contract. No HTTP, MCP, Cloudflare or client storage dependency. */
import type {IssueChange,ContentChange,IssueView,ContentView,DirectoryChange,DirectoryEntity} from './work/public';
import type {ExecutionCommand,ReportCommand,ExecutionAttempt,ReportSnapshot} from './execution/public';
import type {Failure,ChangeOutcome} from "./change-outcomes";
import type {Permission} from "./identity/dto";
export type OperationJson=null|boolean|number|string|OperationJson[]|{[key:string]:OperationJson};
export type OperationRoute=
  | {kind:'project';id?:string}
  | {kind:'workspace';id?:string}
  | {kind:'issue';projectId:string;id?:string}
  | {kind:'wiki';projectId:string;id?:string}
  | {kind:'comment';projectId:string;parentKind:'issue'|'wiki';parentId:string;id?:string}
  | {kind:'execution';projectId:string;issueId:string;action:'acquire'|'renew'|'end'|'interrupt'}
  | {kind:'report';projectId:string;issueId:string;action:'progress'|'failed'|'completed'|'reconcile'|'restart'};
export interface OperationPreparation {route:OperationRoute;input:unknown}
export type OperationOutcome={status:'unknown'}|{status:'confirmed';snapshot:OperationJson};
export interface DurableOperation {
  sequence:number;operationId:string;formatVersion:number;recorded:true;inputHash:string;route:OperationRoute;input:OperationJson;
  target:{kind:string;targetId:string;projectId:string};requiredPermissions:Permission[];preparedAt:number;result:OperationOutcome;
}
export interface OperationPage {operations:DurableOperation[];nextAfter:number|null}
export type OperationSummary=Pick<DurableOperation,'sequence'|'operationId'|'formatVersion'|'inputHash'|'target'|'preparedAt'>&{result:{status:OperationOutcome['status']}};
export interface OperationSummaryPage {operations:OperationSummary[];nextAfter:number|null}
export interface OperationReceipt<T=OperationJson> {operationId:string;snapshot:T;source:'committed'|'recovered'}
export interface OperationPreparationAck {operation:DurableOperation;requestHash:string}

/** Trusted server invocation metadata; never decoded from a request body. */
export interface StoredOperationFence {
 operationId:string;formatVersion:1;kind:string;targetId:string;projectId:string;routeJson:string;inputJson:string;hash:string;permissions:readonly Permission[];
}
/** Closed server business commands; external JSON is decoded before this boundary. */
export type PreparedCommand=
 | {kind:'directory';command:DirectoryChange}
 | {kind:'issue';command:IssueChange}
 | {kind:'content';command:ContentChange}
 | {kind:'execution';command:ExecutionCommand}
 | {kind:'report';command:ReportCommand};
/** Current execution snapshots stay associated with their owning business command family. */
export type PreparedExecution=
 | {kind:'directory';receipt:OperationReceipt<DirectoryEntity>}
 | {kind:'issue';receipt:OperationReceipt<IssueView>}
 | {kind:'content';receipt:OperationReceipt<ContentView>}
 | {kind:'execution';receipt:OperationReceipt<ExecutionAttempt>}
 | {kind:'report';receipt:OperationReceipt<ReportSnapshot>}
 | {kind:'retained';receipt:OperationReceipt<OperationJson>};
export interface Operations {
 /** Injected external-boundary decoder; ordinary use cases accept the closed typed command below. */
 decodePreparation(value:OperationPreparation):PreparedCommand;
 prepare(command:PreparedCommand):Promise<DurableOperation>;
 list(options?:{after?:number;limit?:number}):Promise<OperationSummaryPage>;
 /** Discovery can encounter unknown future input formats, so it retains the opaque wire envelope. */
 get(operationId:string):Promise<DurableOperation>;
 execute(operationId:string):Promise<PreparedExecution>;
}

/** Failure reason and request-known identity; protected snapshots require explicit disclosure evidence. */
export class OperationError extends Error {
 constructor(public readonly failure:Failure,public readonly operationId?:string,public readonly outcome?:Exclude<ChangeOutcome<OperationJson>,{application:'confirmed'}>){super(failure.code??'operation_intents_unavailable');}
}

/** Exact immutable journal description; variable JSON belongs only to the persistence envelope. */
export interface PreparedDescription {
 route:OperationRoute;input:OperationJson;operationId:string;kind:string;projectId:string;
 target:{id:string}|{prefix:'I_'|'W_'|'C_'}|{directory:'project'|'workspace'};mutationInput:OperationJson;canonicalInputLimit:number;permissions:Permission[];
}
export interface OperationJournal {
 record(description:PreparedDescription):Promise<DurableOperation>;
 list(options?:{after?:number;limit?:number}):Promise<OperationSummaryPage>;
 get(operationId:string):Promise<DurableOperation>;
 executionFence(stored:DurableOperation,description:PreparedDescription):Promise<StoredOperationFence>;
}
