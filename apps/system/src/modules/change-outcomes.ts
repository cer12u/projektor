// @module persistence
// @role public-contract
/** Shared persistence evidence, not a business module or an instruction to retry. */
export interface Receipt<T>{operationId:string;snapshot:T}
export type FailureKind='invalid'|'unauthenticated'|'forbidden'|'conflict'|'input_mismatch'|'not_found'|'unavailable'|'internal'|'rate_limited';
export interface Failure {kind:FailureKind;code?:string;reason?:string;fields?:Record<string,string>}
export interface NonapplicationCertificate {operationId:string;status:'not_applied';phase:'pre_dispatch'}
export type ReadOutcome<T>=
 | {status:'value';value:T}
 | {status:'denied';failure:Failure}
 | {status:'not_found'|'invalid'|'conflict'|'unavailable';failure:Failure};
export type ResultOutcome<T>=
 | {status:'confirmed';receipt:Receipt<T>}
 | {status:'missing';operationId:string;application:'unknown';failure:Failure}
 | {status:'denied'|'invalid'|'unavailable';failure:Failure};
export type ChangeOutcome<T,C=T>=
 | {application:'confirmed';disclosure:'allowed';source:'committed'|'recovered';receipt:Receipt<T>}
 | {application:'not_applied';disclosure:'withheld';certificate:NonapplicationCertificate;failure:Failure}
 | {application:'unknown';disclosure:'allowed';operationId:string;failure:Failure;authorizedCurrent?:C}
 | {application:'unknown';disclosure:'denied'|'withheld';operationId:string;failure:Failure};
/** External data is decoded before entering a typed feature use case. */
export class InputError extends Error {
 constructor(public readonly code:string,public readonly fields?:Record<string,string>){super(code);}
}
