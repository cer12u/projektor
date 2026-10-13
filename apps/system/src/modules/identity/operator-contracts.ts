// @module identity
// @role application-contracts
import type {PrincipalProvision,ProjectRights} from './rules';
import type {CredentialEnvelope,CredentialEnvironment} from './credential-contracts';
export interface OperatorContext{operatorId:string;operationId:string;environment:CredentialEnvironment}
export interface CredentialProvision{principalId:string;credentialId:string;authVersion:number;expiresAt:number;scopes:ProjectRights[]}
export interface PrincipalProvisionSnapshot{principalId:string;kind:'human'|'agent';loginId:string|null;authVersion:number;globalAdministrator:number;projects:ProjectRights[]}
export interface CredentialProvisionSnapshot{credentialId:string;principalId:string;expiresAt:number;scopes:ProjectRights[]}
export interface OperatorReceipt{operatorId:string;operationId:string;kind:'principal.create'|'credential.create';targetId:string;snapshot:PrincipalProvisionSnapshot|CredentialProvisionSnapshot}
export interface OperatorCommand{context:OperatorContext;kind:OperatorReceipt['kind'];target:string;inputHash:string}
export interface OperatorPersistence{
 readReceipt(command:OperatorCommand):Promise<OperatorReceipt|null>;
 commitPrincipal(command:OperatorCommand,input:PrincipalProvision):Promise<OperatorReceipt>;
 commitCredential(command:OperatorCommand,input:CredentialProvision,tokenHash:string):Promise<OperatorReceipt>;
 credentialDeliveryAllowed(input:CredentialProvision,tokenHash:string):Promise<boolean>;
}
/** Provided by an independently approved secure store; never a file/default VM location. */
export interface SecureCredentialDelivery{storeCredential(credential:CredentialEnvelope):Promise<void>}
export interface OperatorCrypto{digest(value:string):Promise<string>;randomToken():string}
export type CredentialProvisionResult={receipt:OperatorReceipt;delivered:true}|{receipt:OperatorReceipt;delivered:false;reason:'already_issued'|'delivery_not_authorized'|'handoff_failed_revoke_and_reissue_explicitly'};
export interface IdentityOperator{
 provisionPrincipal(context:OperatorContext,input:PrincipalProvision):Promise<OperatorReceipt>;
 issueCredential(context:OperatorContext,input:CredentialProvision,origin:string):Promise<CredentialProvisionResult>;
}

export class OperatorFailure extends Error{
 readonly application='unknown' as const;
 constructor(readonly operationId:string|undefined,readonly failure:{kind:import('../change-outcomes').FailureKind;code:string}){super(failure.code);}
}
