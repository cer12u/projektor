// @module administration
// @role contracts
import type {Identity, Permission} from "../../modules/identity/dto";
export interface Revision {revision:number}
export interface ManagedPrincipal extends Revision {principalId:string;kind:'human'|'agent';displayName:string;active:0|1;authVersion:number;globalAdministrator:0|1}
export interface ManagedMembership extends Revision {principalId:string;projectId:string;permissions:Permission[]}
export interface ManagedCredential extends Revision {credentialId:string;principalId:string;expiresAt:number;revokedAt:number|null}
export interface ManagedScope extends ManagedCredential {projectId:string;permissions:Permission[]}
export type ManagementRecord =
  | {kind:'principal';snapshot:ManagedPrincipal}
  | {kind:'membership';snapshot:ManagedMembership}
  | {kind:'credential';snapshot:ManagedCredential}
  | {kind:'scope';snapshot:ManagedScope};
export interface ManagementContext {globalAdministrator:boolean;projects:Identity['projects']}
export interface ManagementHistory {actorId:string;actorName:string;operationId:string;kind:string;beforeRevision:number;afterRevision:number;before:unknown;after:unknown;recordedAt:number;initialProjects?:{projectId:string;permissions:Permission[]}[]}
export interface PrincipalRegistration {operationId:string;principalId:string;kind:'human'|'agent';displayName:string;loginId:string|null;projects:{projectId:string;permissions:Permission[]}[]}
export interface ManagementDraft {displayName:string;active:boolean;permissions:Permission[]}
export interface ManagementSubmission {operationId:string;record:ManagementRecord;draft:ManagementDraft}
export interface SetupMetadata {principalId:string;revision:number;authVersion:number;rightId:string|null;purpose:'initial'|'reset'|null;expiresAt:number|null;consumedAt:number|null;revokedAt:number|null}
export interface SetupReceipt {operationId:string;snapshot:SetupMetadata;source?:string}
/** Tab-local unsent input is not a command or an authorization source. Preserve incomplete input. */
export interface SetupSubmission {actorId:string;principalId:string;operationId:string;revision:number;purpose:'initial'|'reset'|null;recipientRequestId?:string}
export interface SavedManagementEdit {operationId:string;record:ManagementRecord;draft:ManagementDraft;pending:ManagementSubmission|null;setupPending?:SetupSubmission|null}
