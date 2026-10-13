// @module agent-sdk
// @role private-transport
/** Credential-safe HTTP wire boundary; no route policy or credential discovery. */
/** Preserve server error code/reason/current without importing browser state machinery. */
export class AgentHttpError extends Error {
 constructor(public status:number,public code:string,public fields?:Record<string,string>,public current?:unknown,public reason?:string,public operationId?:string,public application?:'unknown'){super(code);}
}
function reflectsCredential(value:unknown,secrets:readonly string[]):boolean{
 if(typeof value==='string')return secrets.some(secret=>value.includes(secret));
 if(Array.isArray(value))return value.some(v=>reflectsCredential(v,secrets));
 if(value&&typeof value==='object')return Object.entries(value).some(([k,v])=>reflectsCredential(k,secrets)||reflectsCredential(v,secrets));
 return false;
}
export async function agentHttpRequest<T>(url:string,options:RequestInit,secrets:readonly string[],transport:(url:string,request:RequestInit)=>Promise<Response>,expectedOperationId?:string):Promise<T>{
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
 try{
  let response:Response;
  try{response=await transport(url,{...options,signal:controller.signal});}catch{throw new AgentHttpError(0,'application_transport_unavailable');}
  let value:unknown;
  try{value=await response.json();}catch{throw new AgentHttpError(response.status,'application_response_invalid');}
  if(reflectsCredential(value,secrets))throw new AgentHttpError(response.status,'credential_reflection_rejected');
  if(!value||typeof value!=='object'||Array.isArray(value))throw new AgentHttpError(response.status,'application_response_invalid');
  if(!response.ok){
   const error=value as {error?:string;fields?:Record<string,string>;current?:unknown;reason?:string;operationId?:unknown;application?:unknown};
   // Error evidence can identify this request, never a different operation or positive application certainty.
   if(Object.hasOwn(error,'operationId')&&(typeof error.operationId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(error.operationId)||error.operationId!==expectedOperationId))throw new AgentHttpError(response.status,'application_response_invalid');
   if(Object.hasOwn(error,'application')&&(error.application!=='unknown'||error.operationId===undefined))throw new AgentHttpError(response.status,'application_response_invalid');
   throw new AgentHttpError(response.status,error.error??'request_failed',error.fields,error.current,error.reason,
    typeof error.operationId==='string'?error.operationId:undefined,error.application==='unknown'?'unknown':undefined);
  }
  return value as T;
 }finally{clearTimeout(timer);}
}
