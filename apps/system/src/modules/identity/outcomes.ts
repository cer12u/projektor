// @module identity
// @role domain-outcome
import type {Failure,FailureKind} from "../change-outcomes";
/** Domain rejection. Only delivery chooses an HTTP status. */
export class IdentityError extends Error {
 readonly failure:Failure;
 constructor(kind:FailureKind,code:string,fields?:Record<string,string>){super(code);this.failure={kind,code,...(fields?{fields}:{})};}
}
