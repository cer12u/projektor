// @module workbench
// @role transport
import type {Identity} from '../../modules/identity/dto';
import type {DirectoryEntity,DirectoryHistory,DirectoryManagement} from '../../modules/work/directory-contracts';
import {createPrincipalReader,request,sessionRequest,captureAuthorityLease,AuthorityChanged} from '../session/access';
import {HttpError} from '../platform/index';
import {directoryEntity,directoryManagement,managesEntity,matchesProjectReceipt,type ProjectSubmission} from './project-draft';
export interface DirectoryReceipt {operationId:string;snapshot:DirectoryEntity}
export class ProjectClient {
 private readonly principal;
 private readonly leases=new WeakMap<object,()=>boolean>();
 constructor(readonly owner:string,identityChanged:(identity:Identity)=>void){this.principal=createPrincipalReader(owner,identityChanged);}
 currentAuthority(context:DirectoryManagement){return this.leases.get(context)?.()===true;}
 private async contextRead(){const value=await request<{management:unknown}>('/api/directory');return directoryManagement(value.management);}
 private async observe<T>(read:(identity:Identity)=>Promise<T>,check:(value:T,context:DirectoryManagement)=>boolean){return sessionRequest(async()=>{
  const identity=await this.principal.read(),lease=captureAuthorityLease();
  const value=await read(identity),context=await this.contextRead();await this.principal.read();
  if(!lease())throw new AuthorityChanged();if(!check(value,context))throw new HttpError(403,'forbidden');
  this.leases.set(context,lease);return {value,context};
 });}
 async context(){const {context}=await this.observe(()=>Promise.resolve(null),()=>true);return context;}
 private path(kind:DirectoryEntity['kind'],id?:string){return '/api/'+(kind==='project'?'projects':'workspaces')+(id?'/'+encodeURIComponent(id):'');}
 current(entity:Pick<DirectoryEntity,'kind'|'id'>){return this.observe(async()=>{const result=directoryEntity(await request(this.path(entity.kind,entity.id)));if(result.kind!==entity.kind||result.id!==entity.id)throw new Error('invalid_directory_target');return result;},(result,context)=>managesEntity(context,result));}
 history(entity:DirectoryEntity,afterRevision=0){return this.observe(async()=>{
  const result=await request<DirectoryHistory>(this.path(entity.kind,entity.id)+'/history?afterRevision='+afterRevision);
  if(!(result.nextAfterRevision===null||Number.isSafeInteger(result.nextAfterRevision)&&result.nextAfterRevision>afterRevision)||!Array.isArray(result.history)||result.history.some(h=>!Number.isSafeInteger(h.revision)||h.revision<=afterRevision||typeof h.operationId!=='string'||typeof h.actorId!=='string'||typeof h.recordedAt!=='string'||directoryEntity(h.after).id!==entity.id||h.after.kind!==entity.kind||(h.before!==null&&(directoryEntity(h.before).id!==entity.id||h.before.kind!==entity.kind))))throw new Error('invalid_directory_history');
  return result;
 },(_result,context)=>managesEntity(context,entity));}
 send(submission:ProjectSubmission){return this.observe(async identity=>{
  if(submission.owner!==this.owner)throw new Error('invalid_directory_owner');
  const {command}=submission,context=await this.contextRead();
  if(command.action==='create'?!context.canCreate:!(command.kind==='project'?context.projects:context.workspaces).some(v=>v.id===command.id))throw new HttpError(403,'forbidden');
  const result=await request<DirectoryReceipt>(this.path(command.kind,command.action==='edit'?command.id:undefined),{method:command.action==='create'?'POST':'PATCH',headers:{'Content-Type':'application/json','X-CSRF-Token':identity.csrfToken??''},body:JSON.stringify(command.input)});
  const snapshot=directoryEntity(result.snapshot);
  if(result.operationId!==command.input.operationId||!matchesProjectReceipt(command,snapshot))throw new Error('invalid_directory_receipt');
  return {operationId:result.operationId,snapshot};
 },(result,context)=>managesEntity(context,result.snapshot));}
 result(submission:ProjectSubmission){return this.observe(async()=>{
  if(submission.owner!==this.owner)throw new Error('invalid_directory_owner');
  const result=await request<DirectoryReceipt>('/api/directory-operations/'+encodeURIComponent(submission.command.input.operationId)),snapshot=directoryEntity(result.snapshot);
  if(result.operationId!==submission.command.input.operationId||!matchesProjectReceipt(submission.command,snapshot))throw new Error('invalid_directory_receipt');
  return {operationId:result.operationId,snapshot};
 },(result,context)=>managesEntity(context,result.snapshot));}
}
