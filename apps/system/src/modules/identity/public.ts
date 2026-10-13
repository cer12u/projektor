// @module identity
// @role public-use-cases
/** Identity owns credential, membership and setup state. All calls are storage/transport independent. */
import type {Identity} from "./dto";
import type {ChangeOutcome,ReadOutcome,ResultOutcome} from "../change-outcomes";
export type {Receipt} from "../change-outcomes";
import type {ManagementCommand,PrincipalRegistration} from './rules';
export interface PrincipalSnapshot {principalId:string;kind:'human'|'agent';displayName:string;active:number;authVersion:number;globalAdministrator:number;revision:number}
export interface MembershipSnapshot {principalId:string;projectId:string;revision:number;relationExists?:false;permissions:import("./dto").Permission[]}
export interface CredentialSnapshot {credentialId:string;principalId:string;expiresAt:number;revokedAt:number|null;revision:number}
export interface ScopeSnapshot extends CredentialSnapshot {projectId:string;relationExists?:false;permissions:import("./dto").Permission[]}
export type ManagementSnapshot=PrincipalSnapshot|MembershipSnapshot|CredentialSnapshot|ScopeSnapshot;
export interface ActorFacts {readonly id:string;readonly kind:'human'|'agent';readonly authentication:'session'|'api'|'federated';readonly csrf_token:string|null;readonly assertion_expires_at?:number}
export type IdentityFacts=ActorFacts;
export interface AccessTrust {issuer:string;audience:string}
export interface PasswordProof {challenge:string|null;csrf:string|null;source:string}
export type SetupPurpose='initial'|'reset';
export interface SetupMetadata {principalId:string;revision:number;authVersion:number;rightId:string|null;purpose:SetupPurpose|null;expiresAt:number|null;consumedAt:number|null;revokedAt:number|null}
export interface SetupContext {principalId:string;loginId:string;displayName:string;purpose:SetupPurpose;expiresAt:number}
export interface PasswordSetupSnapshot {principalId:string;authVersion:number;configured:true}
export interface ManagementContext {globalAdministrator:boolean;projects:{id:string;permissions:string[]}[]}
export interface ManagementHistoryEntry {actorId:string;actorName:string;operationId:string;kind:string;beforeRevision:number;afterRevision:number;before:ManagementSnapshot|null;after:ManagementSnapshot|null;recordedAt:number;initialProjects?:{projectId:string;permissions:string[]}[]}
export interface ManagementPage {records:ManagementSnapshot[];nextAfter:string|null}
export interface ManagementHistoryPage {history:ManagementHistoryEntry[];nextAfter:string|null}
export interface PrincipalDisplay {id:string;kind:'human'|'agent';displayName:string;active:boolean}
export type SetupManagementOutcome=ChangeOutcome<SetupMetadata>;
export type ManagementKind='principal'|'membership'|'credential'|'scope';
export interface ManagementQuery {kind:string|null;projectId:string|null;after?:string|null;targetId?:string}
export interface OwnerSetupStatus {principalId:string;operationId:string;state:'ready'|'completed';expiresAt:number;completedAuthVersion?:number}
export type RecipientSetupStatus=
 | {requestId:string;state:'waiting';expiresAt:number}
 | {requestId:string;state:'ready'|'completed';expiresAt:number;principalId:string;loginId:string;displayName:string;purpose:SetupPurpose;operationId:string;issuerId:string;issuerDisplayName:string;targetAuthVersion:number;completedAuthVersion?:number};
export interface RecipientCompletionInput {operationId:string;principalId:string;issuerId:string;purpose:SetupPurpose;password:string}
export type RecipientAbandonment={abandoned:true}|{abandoned:false;reason:'context_missing'};
export interface IdentityEntryPoints {
 abandonRecipientContext(browserToken:string|null,challenge:string|null,csrf:string|null,expectedRequestId:string):Promise<RecipientAbandonment>;
 recipientContext(existingBrowserToken:string|null,challenge:string|null,csrf:string|null,expectedRequestId?:string,replaceAbandoned?:boolean,replacesRequestId?:string):Promise<{browserToken:string;requestId:string;expiresAt:number}>;
 recipientStatus(browserToken:string,csrf:string):Promise<RecipientSetupStatus>;
 recipientComplete(input:RecipientCompletionInput,browserToken:string,csrf:string):Promise<Exclude<RecipientSetupStatus,{state:'waiting'}>&{source:'committed'|'recovered'}>;
 createLoginContext(source:string):Promise<{csrfToken:string;token:string}>;
 passwordLogin(input:{loginId:string;password:string},proof:PasswordProof):Promise<{token:string}>;
 validateChallenge(challenge:string|null,csrf:string|null):Promise<void>;
 setupContext(setupRight:string,ownerBrowserToken:string|null):Promise<SetupContext>;
 setupComplete(setupRight:string,operationId:string,password:string,ownerBrowserToken:string|null):Promise<ChangeOutcome<PasswordSetupSnapshot>>;
 setupResult(setupRight:string,operationId:string,ownerBrowserToken:string|null):Promise<ResultOutcome<PasswordSetupSnapshot>>;
 browserContext(nonce:string,challenge:string|null,csrf:string|null):Promise<{browserToken:string;expiresAt:number}>;
 browserRedeem(ticket:string,nonce:string,browserToken:string,csrf:string):Promise<{sessionToken:string}>;
 ownerContext(existingBrowserToken:string|null,challenge:string|null,csrf:string|null,expectedOperationId?:string):Promise<{browserToken:string;expiresAt:number}>;
 ownerInitial(assertion:string,operationId:string,browserToken:string,csrf:string):Promise<OwnerSetupStatus>;
 ownerStatus(operationId:string,browserToken:string,csrf:string):Promise<OwnerSetupStatus>;
 ownerComplete(operationId:string,password:string,browserToken:string,csrf:string):Promise<OwnerSetupStatus & {source:'committed'|'recovered'}>;
}
export interface IdentityUseCases {
 current():Promise<Identity>;
 logout():Promise<void>;
 browserTicket(nonce:string):Promise<{ticket:string;expiresAt:number;principalId:string}>;
 managementContext():Promise<ReadOutcome<ManagementContext>>;
 managementList(query:ManagementQuery):Promise<ReadOutcome<ManagementPage>>;
 managementRecord(query:ManagementQuery & {targetId:string}):Promise<ReadOutcome<ManagementSnapshot>>;
 managementHistory(query:ManagementQuery & {targetId:string}):Promise<ReadOutcome<ManagementHistoryPage>>;
 managementExecute(command:ManagementCommand):Promise<ChangeOutcome<ManagementSnapshot>>;
 managementRegister(command:PrincipalRegistration):Promise<ChangeOutcome<PrincipalSnapshot>>;
 managementResult(operationId:string):Promise<ResultOutcome<ManagementSnapshot>>;
 displayPrincipal(projectId:string,principalId:string):Promise<ReadOutcome<PrincipalDisplay>>;
 setupState(target:string):Promise<ReadOutcome<SetupMetadata>>;
 setupManage(target:string,operationId:string,revision:number,purpose:SetupPurpose|null,recipientRequestId?:string):Promise<SetupManagementOutcome>;
 setupManagementResult(operationId:string):Promise<ResultOutcome<SetupMetadata>>;
}
export const SESSION_LIFETIME={idleSeconds:30*86400,absoluteSeconds:90*86400} as const;

export {RECIPIENT_CONTEXT_SECONDS,BROWSER_EXCHANGE,LOGIN_POLICY,PERMISSIONS,isPermission,parseManagementCommand,parsePrincipalRegistration} from './rules';
export type {ManagementCommand,PrincipalRegistration} from './rules';

export {IdentityError} from "./outcomes";
