// @module administration
// @role authority
import type {Identity} from "../../modules/identity/dto";
import type {ManagementContext,ManagementRecord} from './management-contracts';
import {canManageProject,canManageRecord} from './management-access';
import {createPrincipalReader,type PrincipalReader} from '../session/access';
import {request} from '../session/access';
import {HttpError} from '../platform/index';
import {sessionRequest} from '../session/access';
import {captureAuthorityLease as authorityObservation,AuthorityChanged} from '../session/access';
/** Authorizes result application separately from request transport and DTO validation. */
export class ManagementAuthority {
  private readonly principal:PrincipalReader;
  constructor(owner:string,identityChanged:(identity:Identity)=>void){this.principal=createPrincipalReader(owner,identityChanged);}
  identity(){return this.principal.read();}
  assertRecord(context:ManagementContext,record:ManagementRecord){if(!canManageRecord(context,record))throw new HttpError(403,'forbidden');}
  context(){return request<ManagementContext>('/api/management/context');}
  async globalIdentity(strict=true){const identity=await this.identity(),context=await this.context();if(strict?context.globalAdministrator!==true:!context.globalAdministrator)throw new HttpError(403,'forbidden');return identity;}
  async read<T>(work:()=>Promise<T>,scope?:(result:T)=>{projectId?:string},finish?:(result:T,identity:Identity)=>T){return sessionRequest(async()=>{
    await this.identity();const authority=authorityObservation(),result=await work(),target=scope?.(result);
    // Global authority is separate from project membership and is absent from /me.
    const context=target&&!target.projectId?await this.context():null,identity=await this.identity();if(!authority())throw new AuthorityChanged();
    if(target&&(target.projectId?!canManageProject(identity,target.projectId):context?.globalAdministrator!==true))throw new HttpError(403,'forbidden');
    return finish?finish(result,identity):result;
  });}

  mutate(record:ManagementRecord,work:(identity:Identity)=>Promise<ManagementRecord>){return sessionRequest(async()=>{
    const identity=await this.identity(),authority=authorityObservation(),context=await this.context();
    if(!canManageRecord(context,record))throw new HttpError(403,'forbidden');
    const result=await work(identity);
    // Self-revocation may commit and then fail here. Retain the operation for read-only recovery.
    const current=await this.context(),after=await this.identity();if(!authority())throw new AuthorityChanged();if(!canManageRecord({...current,projects:after.projects},result))throw new HttpError(403,'forbidden');return result;
  });}
}
