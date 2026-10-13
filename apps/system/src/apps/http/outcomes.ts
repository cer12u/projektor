// @module delivery
// @role outcome-mapping
import {OperationError} from "../../modules/prepared-operations";
import {InputError} from "../../modules/change-outcomes";
import {IdentityError} from "../../modules/identity/public";
import type {ChangeOutcome,Failure,ReadOutcome,ResultOutcome,Receipt} from "../../modules/change-outcomes";

/** Protocol mapping only. It never infers whether a failed attempt committed. */
export class DeliveryFailure extends Error {
 constructor(public readonly status:number,public readonly body:Record<string,unknown>){super(typeof body.error==='string'?body.error:'unavailable');}
}
const statuses={invalid:400,unauthenticated:401,forbidden:403,conflict:409,input_mismatch:409,not_found:404,unavailable:503,internal:500,rate_limited:429} as const;
function reject(failure:Failure,fallback:string,extra:Record<string,unknown>={}):never {
 throw new DeliveryFailure(statuses[failure.kind],{error:failure.code??fallback,
  ...(failure.reason!==undefined?{reason:failure.reason}:{}),
  ...(failure.fields!==undefined?{fields:failure.fields}:{}),...extra});
}
export async function readValue<T>(pending:Promise<ReadOutcome<T>>,fallback='temporarily_unavailable'):Promise<T>{
 const outcome=await pending;
 if(outcome.status==='value')return outcome.value;
 return reject(outcome.failure,fallback);
}
export async function resultValue<T>(pending:Promise<ResultOutcome<T>>,fallback='temporarily_unavailable',operationId?:string):Promise<Receipt<T>>{
 const outcome=await pending;
 if(outcome.status==='confirmed')return outcome.receipt;
 const knownId=operationId??(outcome.status==='missing'?outcome.operationId:undefined);
 return reject(outcome.failure,fallback,knownId&&/^[A-Za-z0-9_-]{1,128}$/.test(knownId)?{operationId:knownId,application:'unknown'}:{});
}
export async function changeValue<T,C=T>(pending:Promise<ChangeOutcome<T,C>>,fallback='temporarily_unavailable'):Promise<Receipt<T>&{source:'committed'|'recovered'}>{
 const outcome=await pending;
 if(outcome.application==='confirmed')return {...outcome.receipt,source:outcome.source};
 if(outcome.application==='not_applied')return reject(outcome.failure,fallback,{mutationOutcome:outcome.certificate});
 return reject(outcome.failure,fallback,{operationId:outcome.operationId,application:'unknown',...(outcome.disclosure==='allowed'&&outcome.authorizedCurrent!==undefined?{current:outcome.authorizedCurrent}:{})});
}

export function protocolFailure(error:unknown):DeliveryFailure|undefined {
 if(error instanceof DeliveryFailure)return error;
 if(error instanceof InputError)return new DeliveryFailure(400,{error:error.code,...(error.fields?{fields:error.fields}:{})});
 if(error instanceof OperationError){
  const f=error.failure,o=error.outcome;
  const extra=o?.application==='not_applied'?{mutationOutcome:o.certificate}:error.operationId?{operationId:error.operationId,application:'unknown',...(o?.application==='unknown'&&o.disclosure==='allowed'&&o.authorizedCurrent!==undefined?{current:o.authorizedCurrent}:{})}:{};
  return new DeliveryFailure(statuses[f.kind],{error:f.code??'operation_intents_unavailable',...(f.fields?{fields:f.fields}:{}),...(f.reason?{reason:f.reason}:{}),...extra});
 }
 if(error instanceof IdentityError){const f=error.failure;return new DeliveryFailure(statuses[f.kind],{error:f.code??'identity_unavailable',...(f.fields?{fields:f.fields}:{}),...(f.reason?{reason:f.reason}:{})});}
 return undefined;
}

/** A failed lookup never establishes nonapplication or permits protected result disclosure. */
export function resultFailureBody(body:Record<string,unknown>,operationId?:string):Record<string,unknown>{
 if(!operationId||!/^[A-Za-z0-9_-]{1,128}$/.test(operationId))return body;
 return {error:body.error,...(body.reason!==undefined?{reason:body.reason}:{}),...(body.fields!==undefined?{fields:body.fields}:{}),operationId,application:'unknown'};
}
