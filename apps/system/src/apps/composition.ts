// @module composition
// @role server-composition
import type {AuthDB} from "../adapters/d1/primitives";
import {createIdentityModule} from "../adapters/d1/identity/assembly";
import {scopeExistsSql} from '../adapters/d1/work/transaction';
import {assembleWorkContent} from "../adapters/d1/work/assembly";
import {assembleExecution} from "../adapters/d1/execution/assembly";
import {createPreparedOperations} from "./prepared-operations/application";
import {createOperationJournal} from "../adapters/d1/persistence/assembly";
import {parseCredentialEvidence} from "./http/credentials";
import {readRequestGate} from "../adapters/d1/runtime";
import {ApiError} from "../adapters/protocol-errors";
import type {ActorServices,RequestServices} from "./contracts";
/** Concrete per-request wiring. Only here do raw persistence and proof meet feature implementations. */
export function createRequestServices(db:AuthDB,now:number):RequestServices {
 const identity=createIdentityModule(db,now,{exists:scopeExistsSql});
 function bind(verified:Awaited<ReturnType<typeof identity.authenticate>>):ActorServices {
  const work=assembleWorkContent(db,verified.proof),execution=assembleExecution(db,verified.proof);
  return {async assertAvailable(){if(await readRequestGate(db)==='importing')throw new ApiError(503,'import_in_progress');},actor:verified.facts,identity:verified.api,work:work.api,execution:execution.api,operations:createPreparedOperations(createOperationJournal(db,verified.proof,[...work.definitions,...execution.definitions]),work.api,execution.api)};
 }
 return {
  identity:identity.entry,
  async authenticate(request){return bind(await identity.authenticate(parseCredentialEvidence(request)));},
  async authenticateFederated(assertion,trust){return bind(await identity.authenticateFederated(assertion,trust));},
 };
}
