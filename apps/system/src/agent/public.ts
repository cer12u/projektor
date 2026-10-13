// @module agent-sdk
// @role public
// Explicit private credential provider, canonical HTTPS target; no public registration or Access bypass.
import type {CredentialEnvelope} from "../modules/identity/credential-contracts";
import type{Identity}from"../modules/identity/dto";
import {agentOperationClient,businessOperationRoute,verifyPreparedReceipt} from "./operations";
import type {OperationPreparation,DurableOperation,OperationSummaryPage,OperationReceipt} from "../modules/prepared-operations";
import {agentHttpRequest} from "./http";
import {clientRouteAllowed,requestOperationId} from "./routes";
export {AgentHttpError} from "./http";
export type CredentialSource=()=>Promise<CredentialEnvelope>;
export type AgentTransport=(url:string,request:RequestInit)=>Promise<Response>;
export interface AdmissionTarget {readonly origin:string;readonly environment:CredentialEnvelope['environment']}
export interface AdmissionResult {readonly headers:Readonly<Record<string,string>>}
export interface RequestAdmission {authorize(target:AdmissionTarget):Promise<AdmissionResult>}
export interface AgentClientOptions {origin:string;principalId:string;credentialId:string;environment:CredentialEnvelope['environment'];loadCredential:CredentialSource;admission?:RequestAdmission;transport?:AgentTransport}
export interface AgentOperations {
 prepare(value:OperationPreparation):Promise<DurableOperation>;
 list(options?:{after?:number;limit?:number}):Promise<OperationSummaryPage>;
 get(operationId:string):Promise<DurableOperation>;
 execute<T=unknown>(operationId:string):Promise<OperationReceipt<T>>;
}
export interface AgentClient {
 identity():Promise<Identity>;
 api<T>(path:string,method?:string,body?:unknown):Promise<T>;
 operations:AgentOperations;
 handoff(nonce:string,receive:(ticket:string)=>Promise<void>):Promise<{principalId:string;expiresAt:number}>;
}
export async function privateAgentClient(input:AgentClientOptions):Promise<AgentClient>{
 // Bind all authority and destinations before the first asynchronous provider call.
 const options={...input};
 if(Object.keys(options).some(key=>!['origin','principalId','credentialId','environment','loadCredential','admission','transport'].includes(key)))throw new Error('client_configuration_invalid');
 if(options.admission&&typeof options.admission.authorize!=='function')throw new Error('admission_configuration_invalid');
 const admissionProvider=options.admission?.authorize.bind(options.admission),transport=options.transport??fetch;
 const url=new URL(options.origin);if(url.origin!==options.origin||url.username||url.password||(url.protocol!=='https:'&&!(options.environment==='synthetic-local'&&url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname))))throw new Error('canonical_https_origin_required');
 if(!['production','synthetic-local'].includes(options.environment)||![options.principalId,options.credentialId].every(v=>/^[A-Za-z0-9_-]{1,128}$/.test(v)))throw new Error('explicit_credential_target_required');

 let envelope:CredentialEnvelope;
 try{envelope=await options.loadCredential();}catch{throw new Error('application_credential_provider_unavailable');}
 if(!envelope||envelope.version!==1||envelope.origin!==options.origin||envelope.environment!==options.environment||envelope.principalId!==options.principalId||envelope.credentialId!==options.credentialId||!/^[A-Za-z0-9_-]{43}$/.test(envelope.token)||Object.keys(envelope).some(k=>!['version','environment','origin','principalId','credentialId','token'].includes(k)))throw new Error('credential_target_mismatch');
 const applicationToken=envelope.token,authorization='Bearer '+applicationToken;
 function checkedTarget(path:string,method:string){
  const target=new URL(path,options.origin);if(target.origin!==options.origin||target.pathname+target.search!==path||target.hash||/%2f|%5c|\.\./i.test(target.pathname))throw new Error('client_route_rejected');
  const p=target.pathname,allowed=clientRouteAllowed(p,method,target.search);
  if(!allowed||!['GET','POST','PATCH'].includes(method))throw new Error('client_route_rejected');
  return target;
 }
 async function wire<T>(path:string,method='GET',body?:unknown):Promise<T>{
  const target=checkedTarget(path,method),expectedOperationId=requestOperationId(target.pathname,method,body);
  const admission:Record<string,string>={};
  if(admissionProvider){
   let result:AdmissionResult;
   try{result=await admissionProvider({origin:options.origin,environment:options.environment});}catch{throw new Error('admission_provider_unavailable');}
   if(!result||typeof result!=='object'||!result.headers||typeof result.headers!=='object'||Array.isArray(result.headers))throw new Error('admission_credential_invalid');
   for(const [name,value]of Object.entries(result.headers)){
    if(!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)||['authorization','cookie','set-cookie','host','origin','referer','content-type','x-csrf-token'].includes(name.toLowerCase())||typeof value!=='string'||!value.length||/[^\x20-\x7e]/.test(value))throw new Error('admission_credential_invalid');
    admission[name]=value;
   }
  }
  return agentHttpRequest<T>(target.href,{method,credentials:'omit',redirect:'error',headers:{...admission,Authorization:authorization,...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})},[applicationToken,...Object.values(admission)],transport,expectedOperationId);
 }
 async function identity(){const i=await wire<Identity>('/api/auth/me');if(!i||i.principal?.id!==options.principalId||i.principal?.kind!=='agent'||i.authentication!=='api')throw new Error('credential_subject_mismatch');return i;}
 const operations=agentOperationClient(wire);
 async function api<T>(path:string,method='GET',body?:unknown):Promise<T>{
  const target=checkedTarget(path,method),route=businessOperationRoute(path,method);
  if(route){
   const prepared=await operations.prepare({route,input:body});
   const receipt=await operations.execute(prepared.operationId);
   verifyPreparedReceipt(prepared,receipt,options.principalId);
   return receipt as T;
  }
  if(target.pathname==='/api/agent/operations'){
   if(method==='POST')return await operations.prepare(body as OperationPreparation) as T;
   return await operations.list({after:Number(target.searchParams.get('after')??0),limit:Number(target.searchParams.get('limit')??20)}) as T;
  }
  if(target.pathname.startsWith('/api/agent/operations/')){
   const operationId=target.pathname.split('/')[4];
   if(method==='GET')return await operations.get(operationId) as T;
   if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)throw new Error('operation_input_invalid');
   return await operations.execute(operationId) as T;
  }
  return wire<T>(path,method,body);
 }
 // Exact credential-bound identity is pinned once. Current authorization is checked by every server request.
 await identity();
 return{identity,api,operations,async handoff(nonce:string,receive:(ticket:string)=>Promise<void>){if(!/^[A-Za-z0-9_-]{43}$/.test(nonce))throw new Error('nonce_invalid');await identity();const v=await api<{ticket:string;expiresAt:number;principalId:string}>('/api/auth/browser-session/tickets','POST',{nonce});if(v.principalId!==options.principalId||!/^[A-Za-z0-9_-]{43}$/.test(v.ticket)||!Number.isSafeInteger(v.expiresAt))throw new Error('handoff_invalid');await identity();await receive(v.ticket);return{principalId:v.principalId,expiresAt:v.expiresAt};}};
}

import {withExecution} from "./execution";
export async function agentExecutionClient(options:AgentClientOptions){return withExecution(await privateAgentClient(options));}
export type {Attempt,ExecutionReport,Confirmation,Reconciliation,Restart,Receipt,MutationReceipt,LeaseInput,ReportInput,ReconcileInput,ReportSnapshot,Reports,ReportHistory} from "./execution";
