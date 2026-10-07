import { executeCommand, failure, operationGet, StorageFailure } from './shared-core.mjs';
// ActorContext is supplied by a trusted fixture authenticator, never request JSON.
const status={VALIDATION:400,SCHEMA_UNSUPPORTED:400,TITLE_EMPTY:400,PRECONDITION_REQUIRED:428,UNAUTHENTICATED:401,EXPIRED:401,FORBIDDEN:403,NOT_FOUND:404,VERSION_CONFLICT:409,KEY_REUSE:409,EPOCH_MISMATCH:409,STORE_FENCED:503,WORKSPACE_MISMATCH:400,UNAVAILABLE:503,RESPONSE_LOST:503};
function invoke(db,actor,c,options){
 let result;
 try{result=executeCommand(db,actor,c,options);}catch(error){return {...failure('UNAVAILABLE','unknown'),attemptOutcome:error instanceof StorageFailure?error.outcome:'unknown'};}
 // Simulate a transport losing the complete response, never misreport as rollback.
 if(options?.dropResponse)return failure('RESPONSE_LOST','unknown');
 return result;
}
export function restUpdate(db,actor,{workspaceId,entityId,idempotencyKey,body},options){
 const result=workspaceId!==body?.workspaceId||entityId!==body?.entityId||idempotencyKey!==body?.operationId?failure('VALIDATION'):invoke(db,actor,body,options);
 return {status:result.error?(status[result.error.code]??500):200,body:result};
}
export function mcpUpdate(db,actor,{name,arguments:args},options){
 const result=name!=='issue_update_title'?failure('VALIDATION'):invoke(db,actor,args,options);
 return {isError:Boolean(result.error),structuredContent:result};
}
function lookup(db,actor,args,now){try{return operationGet(db,actor,args,now);}catch{return failure('UNAVAILABLE','unknown');}}
export function restOperationGet(db,actor,args,now){const body=lookup(db,actor,args,now);return {status:body.error?(status[body.error.code]??500):200,body};}
export function mcpOperationGet(db,actor,args,now){const result=lookup(db,actor,args,now);return {isError:Boolean(result.error),structuredContent:result};}
