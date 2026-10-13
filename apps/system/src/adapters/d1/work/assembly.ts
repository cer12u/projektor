// @module work
// @role assembly
import type {AuthDB} from "../primitives";
import type {Authenticated} from "../identity/authorization";
import type {WorkContent} from "../../../modules/work/public";
import type {D1OperationDefinition} from "../persistence/transaction";
import {createWorkContent} from "../../../modules/work/application";
import {createD1WorkPort,createD1WorkDefinitions} from "./adapter";
/** Request composition binds one verified actor, without exposing DB state through the API. */
export function assembleWorkContent(db:AuthDB,auth:Authenticated):{api:WorkContent;definitions:readonly D1OperationDefinition[]}{
 return {api:createWorkContent(createD1WorkPort(db,auth)),definitions:createD1WorkDefinitions()};
}
