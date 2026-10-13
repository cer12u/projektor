// @module delivery
// @role public-contract
import type {WorkContent} from "../modules/work/public";
import type {Execution} from "../modules/execution/public";
import type {Operations} from "../modules/prepared-operations";
import type {IdentityUseCases,IdentityEntryPoints,IdentityFacts,AccessTrust} from "../modules/identity/public";
/** Bound once by request composition; HTTP/MCP never receive persistence or credential proof. */
export interface ActorServices {
 readonly actor:IdentityFacts;
 assertAvailable():Promise<void>;
 readonly identity:IdentityUseCases;
 readonly work:WorkContent;
 readonly execution:Execution;
 readonly operations:Operations;
}
export interface RequestServices {
 readonly identity:IdentityEntryPoints;
 authenticate(request:Request):Promise<ActorServices>;
 authenticateFederated(assertion:string,trust:AccessTrust):Promise<ActorServices>;
}
