// @module identity
// @role application
import {InputError} from '../change-outcomes';
import {IdentityError} from './outcomes';
import {OperatorFailure} from './operator-contracts';
import {normalizePrincipalProvision} from './rules';
import {credentialProvision,credentialOrigin,operatorContext,operatorInput} from './operator-rules';
import type {OperatorPersistence,OperatorCrypto,SecureCredentialDelivery,IdentityOperator,OperatorContext,OperatorCommand} from './operator-contracts';
/** Private trusted-operator entry. The host owns approval and secure delivery, not HTTP authentication. */
export function createIdentityOperatorApplication(store:OperatorPersistence,crypto:OperatorCrypto,delivery:SecureCredentialDelivery):IdentityOperator{
 async function command(context:OperatorContext,kind:OperatorCommand['kind'],target:string,input:unknown):Promise<OperatorCommand>{return{context,kind,target,inputHash:await crypto.digest(operatorInput({environment:context.environment,input}))};}
 async function run<T>(id:string,work:()=>Promise<T>):Promise<T>{try{return await work();}catch(error){throw new OperatorFailure(typeof id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(id)?id:undefined,error instanceof IdentityError?{kind:error.failure.kind,code:error.failure.code??'operator_unavailable'}:error instanceof InputError?{kind:'invalid',code:error.code}:{kind:'unavailable',code:'operator_unavailable'});}}
 return{
  async provisionPrincipal(rawContext,raw){return run(rawContext.operationId,async()=>{const context=operatorContext(rawContext),input=normalizePrincipalProvision(raw),c=await command(context,'principal.create',input.principalId,input),previous=await store.readReceipt(c);return previous??store.commitPrincipal(c,input);});},
  async issueCredential(rawContext,raw,rawOrigin){return run(rawContext.operationId,async()=>{
   const context=operatorContext(rawContext),input=credentialProvision(raw),origin=credentialOrigin(rawOrigin,context),c=await command(context,'credential.create',input.credentialId,{...input,origin}),previous=await store.readReceipt(c);
   if(previous)return{receipt:previous,delivered:false,reason:'already_issued'};
   const token=crypto.randomToken(),tokenHash=await crypto.digest(token),receipt=await store.commitCredential(c,input,tokenHash);
   if(!await store.credentialDeliveryAllowed(input,tokenHash))return{receipt,delivered:false,reason:'delivery_not_authorized'};
   try{await delivery.storeCredential({version:1,environment:context.environment,origin,principalId:input.principalId,credentialId:input.credentialId,token});return{receipt,delivered:true};}
   catch{return{receipt,delivered:false,reason:'handoff_failed_revoke_and_reissue_explicitly'};}
  });}
 };
}
