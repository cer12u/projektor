// @module identity
// @role private-policy
import type {AccessTrust} from "./public";
export type {AccessTrust} from "./public";
export interface VerifiedAccessAssertion extends AccessTrust {subject:string;expiresAt:number;notBefore:number}
