// @module identity
// @role private-d1
import type {AuthDB} from "../primitives";
import type {ManagementSnapshot,PrincipalSnapshot,ManagementPage,ManagementHistoryPage,PasswordSetupSnapshot,SetupMetadata} from "../../../modules/identity/public";
import type {IdentityPersistence} from "../../../modules/identity/ports";
import {IdentityError} from "../../../modules/identity/outcomes";
import {ApiError} from "../../protocol-errors";
import {observeChange,observeRead,observeResult,failureOf} from "../persistence/outcomes";
import {apiCredential,session,revokeSession,passwordRow,createSession} from "./credential-store";
import {challengeValid,reserveLoginContext,countAttempts} from "./auth-challenges";
import {identity} from "./identity-service";
import {resolveFederatedCredential} from "./federated-credential";
import {setupCompletionResultByHash,setupRightContext,passwordSetupPhase,preparePasswordSetupValue,commitPasswordSetup} from "./password-setup-completion";
import {setupManagementState,readSetupManagement,executeSetupManagement,setupManagementResult} from "./password-setup-management";
import {commitBrowserTicket,readBrowserScope,redeemBrowserOnce,reserveBrowserContext} from "./browser-exchange-service";
import {readOwnerBrowserBinding,readOwnerSetupConfiguration} from "./owner-setup-service";
import {managementContext,listManagementRecords,readManagementRecord,readManagementHistory} from "./management-read";
import {executeManagement,readManagementResult,readManagementForChange} from "./management";
import {registerManagementPrincipal} from "./management-registration";
import {displayPrincipal} from "./permissions";
import {recipientContextStore} from "./recipient-context";
import {ownerContextStore} from "./setup-context";
import {unavailableScopeProjection,type IdentityScopeProjection} from './scope-projection';
async function effect<T>(run:()=>Promise<T>):Promise<T>{try{return await run();}catch(error){if(error instanceof IdentityError)throw error;const f=failureOf(error);throw new IdentityError(f.kind,f.code??'identity_unavailable',f.fields);}}
export function createIdentityPersistence(db:AuthDB,scopes:IdentityScopeProjection=unavailableScopeProjection):IdentityPersistence {
 const owner=ownerContextStore(db),recipient=recipientContextStore(db);
 return {
  abandonRecipientContext:c=>effect(()=>recipient.abandon(c)),
  reserveRecipientContext:c=>effect(()=>recipient.reserve(c)),readRecipientSetup:(hash,csrf)=>effect(()=>recipient.status(hash,csrf)),commitRecipientPassword:c=>effect(()=>recipient.complete(c)),
  authenticateSessionAndTouch:(hash,time)=>effect(()=>session(db,hash,time)),authenticateApi:(hash,time)=>effect(()=>apiCredential(db,hash,time)),resolveFederated:(assertion,time)=>effect(()=>resolveFederatedCredential(db,assertion,time)),
  reserveLoginContext:c=>effect(()=>reserveLoginContext(db,c)),challengeValid:(hash,csrf,time)=>effect(()=>challengeValid(db,hash,csrf,time)),countAttempts:keys=>effect(()=>countAttempts(db,keys)),
  passwordCandidate:login=>effect(async()=>{const principal=await passwordRow(db,login),dummy=await db.prepare("SELECT value FROM auth_settings WHERE key='dummy_password_hash'").first<{value:string}>();return{principal,dummyHash:dummy?.value??null};}),
  commitPasswordLogin:c=>effect(async()=>{try{await createSession(db,c);}catch(error){if(error instanceof Error&&/CHECK constraint failed|NOT NULL constraint failed/.test(error.message))throw new ApiError(401,'invalid_credentials');throw new ApiError(503,'authentication_unavailable');}}),
  readIdentity:(auth,time)=>effect(()=>identity(db,auth,time)),revokeSession:(hash,time)=>effect(()=>revokeSession(db,hash,time)),
  readOwnerConfiguration:()=>effect(()=>readOwnerSetupConfiguration(db)),reserveOwnerContext:(...args)=>effect(()=>owner.reserve(...args)),readOwnerContext:(...args)=>effect(()=>owner.read(...args)),issueOwnerSetup:c=>effect(()=>owner.issue(c)),ownerSetupStatus:(...args)=>effect(()=>owner.status(...args)),
  completeOwnerSetup:c=>effect(()=>owner.complete(c)),
  readOwnerBrowserBinding:hash=>effect(()=>readOwnerBrowserBinding(db,hash)),setupContext:right=>effect(()=>setupRightContext(db,right)),setupCompletionPhase:(...args)=>effect(()=>passwordSetupPhase(db,...args)),
  commitSetupPassword:c=>observeChange<PasswordSetupSnapshot>(c.operationId,async()=>{const result=await commitPasswordSetup(db,await preparePasswordSetupValue(db,c.rightHash,c.operationId,c.inputHash,c.encodedPassword));return {...result,snapshot:result.snapshot as unknown as PasswordSetupSnapshot};}),
  setupResult:(right,id)=>observeResult<PasswordSetupSnapshot>(id,async()=>{const result=await setupCompletionResultByHash(db,right,id);return {...result,snapshot:result.snapshot as unknown as PasswordSetupSnapshot};}),
  reserveBrowserContext:c=>effect(()=>reserveBrowserContext(db,c)),
  readBrowserScope:auth=>effect(()=>readBrowserScope(db,auth)),
  redeemBrowserOnce:c=>effect(()=>redeemBrowserOnce(db,c)),
  commitBrowserTicket:(auth,c)=>effect(()=>commitBrowserTicket(db,auth,c)),
  readManagementContext:auth=>observeRead(()=>managementContext(db,auth)),
  listManagement:(auth,q)=>observeRead(async()=>await listManagementRecords(db,auth,q.kind,q.projectId,q.after??null,scopes) as unknown as ManagementPage),
  readManagement:(auth,q)=>observeRead(async()=>await readManagementRecord(db,auth,q.kind,q.projectId,q.targetId,scopes) as unknown as ManagementSnapshot),
  readManagementHistory:(auth,q)=>observeRead(async()=>await readManagementHistory(db,auth,q.kind,q.projectId,q.targetId,q.after??null,scopes) as unknown as ManagementHistoryPage),
  readManagementForChange:(auth,c)=>readManagementForChange(db,auth,c,scopes),
  commitManagement:(auth,c)=>observeChange<ManagementSnapshot>(c.command.operationId,async()=>{const result=await executeManagement(db,auth,c,scopes);return{...result,operationId:c.command.operationId,snapshot:result.snapshot as unknown as ManagementSnapshot};}),
  registerPrincipal:(auth,c)=>observeChange<PrincipalSnapshot>(c.operationId,async()=>{const result=await registerManagementPrincipal(db,auth,c);return{...result,operationId:c.operationId,snapshot:result.snapshot as unknown as PrincipalSnapshot};}),
  managementResult:(auth,id)=>observeResult(id,async()=>({operationId:id,snapshot:await readManagementResult(db,auth,id) as unknown as ManagementSnapshot})),
  displayPrincipal:(auth,project,id)=>observeRead(()=>displayPrincipal(db,auth,project,id)),
  setupState:(auth,target)=>observeRead(()=>setupManagementState(db,auth,target)),
  readSetupManagement:(auth,request)=>readSetupManagement(db,auth,request),
  commitSetupManagement:(auth,c)=>observeChange<SetupMetadata>(c.operationId,async()=>{const result=await executeSetupManagement(db,auth,c);return{...result,snapshot:result.snapshot as unknown as SetupMetadata};}),
  setupManagementResult:(auth,id)=>observeResult<SetupMetadata>(id,async()=>{const result=await setupManagementResult(db,auth,id);return{...result,snapshot:result.snapshot as unknown as SetupMetadata};}),
 };
}
