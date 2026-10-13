// @module persistence
// @role private-d1
/** Boundary mapping only. Never infers nonapplication from status, absence or a thrown exception. */
import {ApiError} from "../../protocol-errors";
import {MutationError} from './public';
import {InputError} from "../../../modules/change-outcomes";
import type {ChangeOutcome,Failure,ReadOutcome,ResultOutcome,Receipt} from "../../../modules/change-outcomes";
export function failureOf(error:unknown):Failure {
 if(error instanceof InputError)return {kind:'invalid',code:error.code,...(error.fields?{fields:error.fields}:{})};
 if(error instanceof ApiError||error instanceof MutationError){
  const kind=error.status===400?'invalid':error.status===401?'unauthenticated':error.status===403?'forbidden':error.status===404?'not_found':error.status===409?(error.code==='operation_input_mismatch'?'input_mismatch':'conflict'):error.status===429?'rate_limited':error.status===500?'internal':'unavailable';
  return {kind,code:error.code,...(error instanceof MutationError&&error.reason?{reason:error.reason}:{}),...(error instanceof ApiError&&error.fields?{fields:error.fields}:{})};
 }
 // Delivery retains its own unnamed-error fallback; no fabricated domain code or success.
 return {kind:'unavailable'};
}
export function failedChange<T,C=T>(operationId:string,error:unknown):ChangeOutcome<T,C>{
 const failure=failureOf(error);
 if(error instanceof MutationError&&error.status===403&&error.mutationOutcome?.operationId===operationId&&error.mutationOutcome.status==='not_applied'&&error.mutationOutcome.phase==='pre_dispatch')return {application:'not_applied',disclosure:'withheld',certificate:error.mutationOutcome,failure};
 if(failure.kind==='unauthenticated'||failure.kind==='forbidden')return {application:'unknown',disclosure:'denied',operationId,failure};
 if(error instanceof MutationError&&failure.kind==='conflict')return {application:'unknown',disclosure:'allowed',operationId,failure,...(error.current!==undefined?{authorizedCurrent:error.current as C}:{})};
 return {application:'unknown',disclosure:'withheld',operationId,failure};
}
export async function observeChange<T,C=T>(operationId:string,run:()=>Promise<Receipt<T>&{source:'committed'|'recovered'}>):Promise<ChangeOutcome<T,C>>{
 try{const {source,...receipt}=await run();return {application:'confirmed',disclosure:'allowed',source,receipt};}catch(error){return failedChange<T,C>(operationId,error);}
}
export async function observeRead<T>(run:()=>Promise<T>):Promise<ReadOutcome<T>>{
 try{return {status:'value',value:await run()};}catch(error){const failure=failureOf(error);return {status:failure.kind==='unauthenticated'||failure.kind==='forbidden'?'denied':failure.kind==='not_found'?'not_found':failure.kind==='invalid'?'invalid':failure.kind==='conflict'?'conflict':'unavailable',failure};}
}
export async function observeResult<T>(operationId:string,run:()=>Promise<Receipt<T>>):Promise<ResultOutcome<T>>{
 try{return {status:'confirmed',receipt:await run()};}catch(error){const failure=failureOf(error);if(failure.kind==='not_found')return {status:'missing',operationId,application:'unknown',failure};return {status:failure.kind==='unauthenticated'||failure.kind==='forbidden'?'denied':failure.kind==='invalid'?'invalid':'unavailable',failure};}
}
