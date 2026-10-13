// @module execution
// @role assembly
import type {AuthDB} from "../primitives";
import type {Authenticated} from "../identity/authorization";
import type {Execution} from "../../../modules/execution/public";
import type {D1OperationDefinition} from "../persistence/transaction";
import {createExecution} from "../../../modules/execution/application";
import {createExecutionPersistence,createExecutionDefinitions} from "./adapter";
/** Composition only; command and persistence policy stay in their respective owners. */
export function assembleExecution(db:AuthDB,auth:Authenticated):{api:Execution;definitions:readonly D1OperationDefinition[]}{
 return {api:createExecution(createExecutionPersistence(db,auth)),definitions:createExecutionDefinitions()};
}
