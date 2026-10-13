// @module persistence
// @role transaction-spi
/** Private D1 participant SPI. Only domain/platform assembly may implement or consume it. */
import type {OperationRoute} from "../../../modules/prepared-operations";
import type {Json,Sql} from "./commit";
export {canonicalInput,readMutationResult,readMutationReceipt,recoverMutation,executeMutation,fingerprintCommand,sql} from "./commit";
export type {CheckedWrite,MutationReceipt,Json,MutationAdapter,MutationCommand,MutationTarget,ReadPolicyFor,Sql} from "./commit";
export {intentFenceSql} from "./journal-store";
export interface OperationRowExpressions {
 operationKind:Sql;projectId:Sql;targetId:Sql;operationId:Sql;routeJson:Sql;inputJson:Sql;formatVersion:Sql;
}
export interface RecoveryPolicy {
 /** Current trusted authority discriminator; defaults to project. */
 authority?:Sql;
 supported:Sql;
 /** JSON array of CURRENT domain-required permissions; captured requirements are added by the journal. */
 permissions:Sql;
 preparedVisible:Sql;
 confirmedVisible:Sql;
}
export interface D1OperationDefinition {
 readonly routeTag:string;
 readonly operationKinds:readonly string[];
 recovery(row:OperationRowExpressions):RecoveryPolicy;
}

/** Private immutable journal metadata; no business SQL builder. */
export interface PreparedIntent {
 route:OperationRoute;input:Json;
 operationId:string;kind:string;targetId:string;projectId:string;routeJson:string;inputJson:string;hash:string;permissions:import("../../../modules/identity/dto").Permission[];
}
export type {StoredOperationFence as StoredIntentFence} from "../../../modules/prepared-operations";
