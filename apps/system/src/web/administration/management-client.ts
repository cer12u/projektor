// @module administration
// @role transport
import type {Identity} from "../../modules/identity/dto";
import {HttpError} from '../platform/index';
import {request} from '../session/access';
import {ManagementAuthority} from './management-authority';
import {SetupNotApplied} from './setup-not-applied';
import {managementChange,managementQuery,registrationInput} from './management-command';
import {managementIdPattern} from './management-validation';
import {managementRecord,historyInitialProjects,sameManagementTarget} from './management-response-validation';
import type {ManagementRecord,ManagementHistory,ManagementSubmission,PrincipalRegistration,SetupMetadata,SetupReceipt} from './management-contracts';
export {SetupNotApplied} from './setup-not-applied';
export class ManagementClient {
  private readonly access:ManagementAuthority;
  constructor(readonly owner:string,identityChanged:(identity:Identity)=>void){this.access=new ManagementAuthority(owner,identityChanged);}
  context(){return this.access.read(()=>this.access.context(),undefined,(context,identity)=>({...context,projects:identity.projects}));}
  list(kind:ManagementRecord['kind'],projectId?:string,after?:string){return this.access.read(async()=>{
    const response=await request<{records:unknown[];nextAfter:string|null}>('/api/management/records?'+managementQuery(kind,projectId,after));
    const records=response.records.map(managementRecord);if(records.some(r=>r.kind!==kind||('projectId'in r.snapshot&&r.snapshot.projectId!==projectId)))throw new Error('invalid_management_list');return{records,nextAfter:response.nextAfter};
  },()=>({projectId:kind==='membership'||kind==='scope'?projectId:undefined}));}
  current(kind:ManagementRecord['kind'],targetId:string,projectId?:string){return this.access.read(async()=>{
    if(!managementIdPattern.test(targetId))throw new Error('invalid_target_id');
    const response=await request<{snapshot:unknown}>(`/api/management/records/${encodeURIComponent(targetId)}?`+managementQuery(kind,projectId));
    const record=managementRecord(response.snapshot),context=await this.access.context();
    if(record.kind!==kind||('projectId'in record.snapshot&&record.snapshot.projectId!==projectId)||('credentialId'in record.snapshot?record.snapshot.credentialId:record.snapshot.principalId)!==targetId)throw new Error('invalid_management_record');
    this.access.assertRecord(context,record);return{record,context};
  },()=>({projectId:kind==='membership'||kind==='scope'?projectId:undefined}),(result,identity)=>({...result,context:{...result.context,projects:identity.projects}}));}
  history(record:ManagementRecord,after?:string){return this.access.read(async()=>{
    const query=new URLSearchParams(managementQuery(record.kind,'projectId'in record.snapshot?record.snapshot.projectId:undefined,after));query.set('targetId','credentialId'in record.snapshot?record.snapshot.credentialId:record.snapshot.principalId);
    const response=await request<{history:ManagementHistory[];nextAfter:string|null}>('/api/management/history?'+query.toString());
    const history=response.history.map(row=>{
      const afterRecord=managementRecord(row.after),beforeRecord=row.before===null?null:managementRecord(row.before);
      if(!sameManagementTarget(record,afterRecord)||(beforeRecord&&!sameManagementTarget(record,beforeRecord)))throw new Error('invalid_management_history');
      if(row.initialProjects!==undefined&&(record.kind!=='principal'||row.kind!=='management.principal.create'))throw new Error('invalid_management_history');
      return{...row,before:beforeRecord?.snapshot??null,after:afterRecord.snapshot,...(row.initialProjects!==undefined?{initialProjects:historyInitialProjects(row.initialProjects)}:{})};
    });return{history,nextAfter:response.nextAfter};
  },()=>({projectId:'projectId'in record.snapshot?record.snapshot.projectId:undefined}));}
  result(operationId:string){return this.access.read(async()=>{
    if(!managementIdPattern.test(operationId))throw new Error('invalid_operation_id');
    const response=await request<{snapshot:unknown}>(`/api/management/operations/${encodeURIComponent(operationId)}`);return managementRecord(response.snapshot);
  },record=>({projectId:'projectId'in record.snapshot?record.snapshot.projectId:undefined}));}
  async send(submission:ManagementSubmission){
    if(!navigator.locks)throw new HttpError(400,'browser_coordination_unavailable');
    return this.access.mutate(submission.record,async(identity)=>{
      if(!managementIdPattern.test(submission.operationId))throw new Error('invalid_operation_id');
      const change=managementChange(submission.record,submission.draft);
      const response=await request<{snapshot:unknown}>(change.path,{method:change.method,headers:{'Content-Type':'application/json','X-CSRF-Token':identity.csrfToken??''},body:JSON.stringify({operationId:submission.operationId,...change.body})});
      const record=managementRecord(response.snapshot);if(!sameManagementTarget(record,submission.record)||record.snapshot.revision!==submission.record.snapshot.revision+1)throw new Error('invalid_management_receipt');
      return record;
    });
  }
  register(input:PrincipalRegistration){return this.access.read(async()=>{
    if(!navigator.locks)throw new HttpError(400,'browser_coordination_unavailable');const identity=await this.access.globalIdentity(false);
    const response=await request<{snapshot:unknown}>('/api/management/principals',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':identity.csrfToken??''},body:JSON.stringify(registrationInput(input))});
    const record=managementRecord(response.snapshot);if(record.kind!=='principal'||record.snapshot.principalId!==input.principalId||record.snapshot.kind!==input.kind||record.snapshot.globalAdministrator!==0)throw new Error('invalid_registration_receipt');return record;
  },()=>({}));}
  setupState(principalId:string){return this.access.read(async()=>{
    if(!managementIdPattern.test(principalId))throw new Error('invalid_target_id');
    const response=await request<{snapshot:SetupMetadata}>(`/api/management/principals/${encodeURIComponent(principalId)}/password-setup`);
    if(response.snapshot.principalId!==principalId)throw new Error('invalid_setup_target');return response.snapshot;
  },()=>({}));}
  setupResult(operationId:string,principalId:string){return this.access.read(async()=>{
    if(!managementIdPattern.test(operationId))throw new Error('invalid_operation_id');
    const response=await request<SetupReceipt>(`/api/management/password-setup/operations/${encodeURIComponent(operationId)}`);
    if(response.operationId!==operationId||response.snapshot.principalId!==principalId||'setupRight'in response)throw new Error('invalid_setup_result');return response;
  },()=>({}));}
  async changeSetup(principalId:string,revision:number,operationId:string,purpose:'initial'|'reset'|null,recipientRequestId?:string){let started=false,rejected=false;try{return await this.access.read(async()=>{
    if(!navigator.locks)throw new HttpError(400,'browser_coordination_unavailable');
    const identity=await this.access.globalIdentity();
    if(!managementIdPattern.test(principalId)||!managementIdPattern.test(operationId)||purpose&&(!recipientRequestId||!managementIdPattern.test(recipientRequestId)))throw new Error('invalid_setup_identifier');
    let response:SetupReceipt;started=true;
    try{response=await request<SetupReceipt>(`/api/management/principals/${encodeURIComponent(principalId)}/password-setup/${purpose?'issue':'revoke'}`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':identity.csrfToken??''},body:JSON.stringify({operationId,revision,...(purpose?{purpose,recipientRequestId}:{})})});}catch(error){if(error instanceof HttpError&&[400,409,413,415].includes(error.status))rejected=true;throw error;}
    if(response.operationId!==operationId||response.snapshot.principalId!==principalId||response.snapshot.revision!==revision+1||('setupRight'in response))throw new Error('invalid_setup_receipt');return response;
  },()=>({}));}catch(error){if(!started||rejected)throw new SetupNotApplied(error);throw error;}}

}
