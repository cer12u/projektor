// @module identity
// @role application-contracts
import type {Identity} from "./dto";
import type {Authenticated,PasswordRow} from './model';
import type {AccessTrust,IdentityEntryPoints,IdentityUseCases,OwnerSetupStatus,SetupContext} from './public';
import type {Configuration,ManagementCommand,PrincipalRegistration,ManagementRecordKind,BrowserIssuer,BrowserScope,BrowserScopeSource} from './rules';
export interface VerifiedAssertion extends AccessTrust {subject:string;expiresAt:number;notBefore:number}
export interface OwnerContext {expiresAt:number;operationId:string|null;ownerId:string|null}
export interface PasswordLoginCommit {absoluteSeconds:number;principal:PasswordRow;sessionHash:string;sessionCsrf:string;challengeHash:string;csrfHash:string}
export interface OwnerIssue {contextHash:string;csrfHash:string;operationId:string;configuration:Configuration;expectedConfiguration:string;expiresAt:number;assertionExpiresAt:number;rightId:string;rightHash:string;lifetimeSeconds:number}
export interface ManagementRecordQuery {kind:ManagementRecordKind;projectId:string;after?:string|null;targetId?:string}
export interface OwnerCompletion {contextHash:string;csrfHash:string;operationId:string;inputHash:string;encodedPassword:string}
export interface BrowserContextCommit {nonceHash:string;browserHash:string;csrfHash:string;challengeHash:string;lifetimeSeconds:number}
export interface BrowserTicketCommit {nonceHash:string;ticketHash:string;ticketId:string;scope:BrowserScope[];lifetimeSeconds:number}
export interface BrowserSessionCommit {ticketHash:string;nonceHash:string;browserHash:string;csrfHash:string;sessionHash:string;sessionCsrf:string;absoluteSeconds:number}
export interface LoginContextCommit {sourceHash:string;tokenHash:string;csrfHash:string;lifetimeSeconds:number;windowSeconds:number;maximum:number}
export interface LoginAttemptCommit {accountHash:string;sourceHash:string;windowSeconds:number;accountMaximum:number;sourceMaximum:number}
export interface OwnerContextCommit {contextHash:string;csrfHash:string;challengeHash:string;existing:boolean;expectedOperationId?:string;lifetimeSeconds:number}
export interface SetupManagementRequest {targetId:string;operationId:string;revision:number;purpose:import('./public').SetupPurpose|null;recipientRequestId?:string}
export interface SetupManagementObservation {snapshot:import('./public').SetupMetadata;pendingRightIds:string[];recipient?:{requestId:string;expiresAt:number}}
export type SetupManagementPlanningRead={kind:'observed';observation:SetupManagementObservation}|{kind:'outcome';outcome:import('../change-outcomes').ChangeOutcome<import('./public').SetupMetadata>};
export interface SetupManagementCommit {targetId:string;operationId:string;revision:number;expected:import('./public').SetupMetadata;revokeRightIds:string[];nextRightId:string|null;action:
 | {kind:'issue';purpose:'initial'|'reset';rightId:string;tokenHash:string;lifetimeSeconds:number;expectedPasswordCount:0|1;recipientRequestId:string;contextExpiresAt:number;expiresAt:number}
 | {kind:'revoke'}}
export interface BootstrapSetupCommit {targetId:string;operationId:string;rightId:string;rightHash:string;expiresAt:number|null;lifetimeSeconds:number}
export interface ManagementPlan {command:ManagementCommand;expected:import('./public').ManagementSnapshot;principal?:{displayName:string;active:number;authVersion:number}}
export type ManagementPlanningRead={kind:'observed';snapshot:import('./public').ManagementSnapshot}|{kind:'outcome';outcome:import('../change-outcomes').ChangeOutcome<import('./public').ManagementSnapshot>};
export interface RecipientContextCommit {replacesContextHash?:string;replacesRequestId?:string;expectedRequestId?:string;contextHash:string;requestId:string|null;csrfHash:string;challengeHash:string;existing:boolean;lifetimeSeconds:number}
export interface RecipientPasswordCommit {contextHash:string;csrfHash:string;requestId:string;operationId:string;principalId:string;issuerId:string;purpose:import('./public').SetupPurpose;inputHash:string;encodedPassword:string}
/** Specific state effects. No SQL, callbacks, or database handles cross this contract. */
export interface IdentityPersistence {
 abandonRecipientContext(command:{expectedRequestId:string;contextHash:string;challengeHash:string;csrfHash:string}):Promise<boolean>;
 reserveRecipientContext(command:RecipientContextCommit):Promise<{requestId:string;expiresAt:number}>;
 readRecipientSetup(contextHash:string,csrfHash:string):Promise<import('./public').RecipientSetupStatus>;
 commitRecipientPassword(command:RecipientPasswordCommit):ReturnType<IdentityEntryPoints['recipientComplete']>;
 authenticateSessionAndTouch(hash:string,now:number):Promise<Authenticated|null>;
 authenticateApi(hash:string,now:number):Promise<Authenticated|null>;
 resolveFederated(assertion:VerifiedAssertion,now:number):Promise<Authenticated>;
 reserveLoginContext(command:LoginContextCommit):Promise<boolean>;
 challengeValid(hash:string,csrfHash:string,now:number):Promise<boolean>;
 countAttempts(command:LoginAttemptCommit):Promise<boolean>;
 passwordCandidate(login:string):Promise<{principal:PasswordRow|null;dummyHash:string|null}>;
 commitPasswordLogin(command:PasswordLoginCommit):Promise<void>;
 readIdentity(auth:Authenticated,now:number):Promise<Identity>;
 revokeSession(hash:string,now:number):Promise<void>;
 readOwnerConfiguration():Promise<string|null>;
 reserveOwnerContext(command:OwnerContextCommit):Promise<OwnerContext>;
 readOwnerContext(hash:string,csrfHash:string):Promise<OwnerContext>;
 issueOwnerSetup(command:OwnerIssue):Promise<OwnerSetupStatus>;
 ownerSetupStatus(hash:string,csrfHash:string,operationId:string):Promise<OwnerSetupStatus>;
 completeOwnerSetup(command:OwnerCompletion):ReturnType<IdentityEntryPoints['ownerComplete']>;
 readOwnerBrowserBinding(rightHash:string):Promise<string|null>;
 setupContext(rightHash:string):Promise<SetupContext>;
 setupCompletionPhase(rightHash:string,operationId:string,inputHash:string):Promise<'ready'|'completed'>;
 commitSetupPassword(command:{rightHash:string;operationId:string;inputHash:string;encodedPassword:string}):ReturnType<IdentityEntryPoints['setupComplete']>;
 setupResult(rightHash:string,operationId:string):ReturnType<IdentityEntryPoints['setupResult']>;
 reserveBrowserContext(command:BrowserContextCommit):Promise<{expiresAt:number}>;
 readBrowserScope(auth:BrowserIssuer):Promise<BrowserScopeSource>;
 commitBrowserTicket(auth:BrowserIssuer,command:BrowserTicketCommit):Promise<{expiresAt:number;principalId:string}>;
 redeemBrowserOnce(command:BrowserSessionCommit):Promise<void>;
 readManagementContext(auth:Authenticated):ReturnType<IdentityUseCases['managementContext']>;
 listManagement(auth:Authenticated,query:ManagementRecordQuery):ReturnType<IdentityUseCases['managementList']>;
 readManagement(auth:Authenticated,query:ManagementRecordQuery&{targetId:string}):ReturnType<IdentityUseCases['managementRecord']>;
 readManagementHistory(auth:Authenticated,query:ManagementRecordQuery&{targetId:string}):ReturnType<IdentityUseCases['managementHistory']>;
 readManagementForChange(auth:Authenticated,command:ManagementCommand):Promise<ManagementPlanningRead>;
 commitManagement(auth:Authenticated,plan:ManagementPlan):ReturnType<IdentityUseCases['managementExecute']>;
 registerPrincipal(auth:Authenticated,command:PrincipalRegistration):ReturnType<IdentityUseCases['managementRegister']>;
 managementResult(auth:Authenticated,operationId:string):ReturnType<IdentityUseCases['managementResult']>;
 displayPrincipal(auth:Authenticated,projectId:string,principalId:string):ReturnType<IdentityUseCases['displayPrincipal']>;
 setupState(auth:Authenticated,target:string):ReturnType<IdentityUseCases['setupState']>;
 readSetupManagement(auth:Authenticated,request:SetupManagementRequest):Promise<SetupManagementPlanningRead>;
 commitSetupManagement(auth:Authenticated,command:SetupManagementCommit):Promise<import('../change-outcomes').ChangeOutcome<import('./public').SetupMetadata>>;
 setupManagementResult(auth:Authenticated,id:string):ReturnType<IdentityUseCases['setupManagementResult']>;
}
export interface IdentityEffects {
 digest(value:string):Promise<string>;
 randomToken():string;
 verifyPassword(password:string,encodedHash:string):Promise<boolean>;
 hashPassword(password:string):Promise<string>;
 setupInputHash(capability:string,password:string):Promise<string>;
}
export interface AssertionVerifier {
 ownerConfiguration(raw:string):Configuration;
 owner(assertion:string,configuration:Configuration):Promise<VerifiedAssertion>;
 agent(assertion:string,trust:AccessTrust,now:number):Promise<VerifiedAssertion>;
}
