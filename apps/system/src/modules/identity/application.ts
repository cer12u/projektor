// @module identity
// @role application
import {IdentityError} from "./outcomes";
import type {Authenticated} from './model';
import type {AccessTrust,IdentityEntryPoints,IdentityUseCases,ManagementQuery} from './public';
import type {IdentityPersistence,IdentityEffects,AssertionVerifier} from "./ports";
import {requireOwnerBinding,passwordInput,ownerSetupExpiry,managementRecordKind,managementProject,managementIdentifier,managementScopeIdentifier,BROWSER_EXCHANGE,LOGIN_POLICY,OWNER_CONTEXT_SECONDS,SETUP_SECONDS,RECIPIENT_CONTEXT_SECONDS,confirmRecipientSetup,setupPasswordCount,planSetupManagement,planManagement,browserIssuer,browserProof,browserScope,parseManagementCommand,normalizePrincipalRegistration} from './rules';
import {SESSION_LIFETIME} from './public';
const tokenPattern=/^[A-Za-z0-9_-]{43}$/;
function token(value:string|null):string {if(!value||!tokenPattern.test(value))throw new IdentityError('forbidden','owner_setup_unavailable');return value;}
function operation(value:string):string {if(!/^[A-Za-z0-9_-]{1,128}$/.test(value))throw new IdentityError('invalid','invalid_input');return value;}
export function createIdentityApplication(store:IdentityPersistence,crypto:IdentityEffects,verifier:AssertionVerifier,now:number){
 async function validateChallenge(challenge:string|null,csrf:string|null){if(!challenge||!csrf||!await store.challengeValid(await crypto.digest(challenge),await crypto.digest(csrf),now))throw new IdentityError('forbidden','csrf_rejected');}
 async function ownerBinding(right:string,browser:string|null){if(!tokenPattern.test(right))throw new IdentityError('forbidden','setup_right_unavailable');const hash=await crypto.digest(right),binding=await store.readOwnerBrowserBinding(hash);if(binding&&(!browser||await crypto.digest(browser)!==binding))throw new IdentityError('forbidden','setup_right_unavailable');return hash;}
 async function ownerProof(browser:string,csrf:string){return{contextHash:await crypto.digest(token(browser)),csrfHash:await crypto.digest(token(csrf))};}
 const entry:IdentityEntryPoints={
  async abandonRecipientContext(browser,challenge,csrf,expectedRequestId){browserProof(expectedRequestId);await validateChallenge(challenge,csrf);if(browser===null)return{abandoned:false,reason:'context_missing'};const abandoned=await store.abandonRecipientContext({expectedRequestId,contextHash:await crypto.digest(token(browser)),challengeHash:await crypto.digest(challenge!),csrfHash:await crypto.digest(token(csrf))});return abandoned?{abandoned:true}:{abandoned:false,reason:'context_missing'};},
  async recipientContext(existing,challenge,csrf,expectedRequestId,replaceAbandoned=false,replacesRequestId){
   if(replaceAbandoned)browserProof(replacesRequestId!);else if(replacesRequestId!==undefined)throw new IdentityError('invalid','invalid_input');
   if(replaceAbandoned&&expectedRequestId!==undefined)throw new IdentityError('invalid','invalid_input');
   if(expectedRequestId!==undefined){browserProof(expectedRequestId);if(existing===null)throw new IdentityError('forbidden','recipient_setup_unavailable');}
   await validateChallenge(challenge,csrf);const fresh=existing===null||replaceAbandoned,browserToken=fresh?crypto.randomToken():token(existing);
   const reserved=await store.reserveRecipientContext({replacesRequestId,...(replaceAbandoned&&existing!==null?{replacesContextHash:await crypto.digest(token(existing))}:{}),expectedRequestId,contextHash:await crypto.digest(browserToken),csrfHash:await crypto.digest(token(csrf)),challengeHash:await crypto.digest(challenge!),requestId:fresh?crypto.randomToken():null,existing:!fresh,lifetimeSeconds:RECIPIENT_CONTEXT_SECONDS});
   return{browserToken,...reserved};
  },
  async recipientStatus(browser,csrf){const proof=await ownerProof(browser,csrf);return store.readRecipientSetup(proof.contextHash,proof.csrfHash);},
  async recipientComplete(input,browser,csrf){
   operation(input.operationId);managementIdentifier(input.principalId);managementIdentifier(input.issuerId);const text=passwordInput(input.password),proof=await ownerProof(browser,csrf),state=await store.readRecipientSetup(proof.contextHash,proof.csrfHash);
   confirmRecipientSetup(state,input);
   return store.commitRecipientPassword({...proof,requestId:state.requestId,operationId:state.operationId,principalId:state.principalId,issuerId:state.issuerId,purpose:state.purpose,inputHash:await crypto.setupInputHash(browser,text),encodedPassword:state.state==='ready'?await crypto.hashPassword(text):''});
  },
  async createLoginContext(source){const token=crypto.randomToken(),csrfToken=crypto.randomToken();if(!await store.reserveLoginContext({sourceHash:await crypto.digest(`context-source:${source}`),tokenHash:await crypto.digest(token),csrfHash:await crypto.digest(csrfToken),lifetimeSeconds:LOGIN_POLICY.challengeSeconds,windowSeconds:LOGIN_POLICY.windowSeconds,maximum:LOGIN_POLICY.contextPerSource}))throw new IdentityError('rate_limited','login_limited');return{token,csrfToken};},
  async passwordLogin(input,proof){
   const {challenge,csrf,source}=proof;if(!challenge||!csrf||!tokenPattern.test(csrf))throw new IdentityError('forbidden','csrf_rejected');
   const challengeHash=await crypto.digest(challenge),csrfHash=await crypto.digest(csrf);
   if(!await store.challengeValid(challengeHash,csrfHash,now))throw new IdentityError('forbidden','csrf_rejected');
   if(!await store.countAttempts({accountHash:await crypto.digest(`account:${input.loginId}`),sourceHash:await crypto.digest(`source:${source}`),windowSeconds:LOGIN_POLICY.windowSeconds,accountMaximum:LOGIN_POLICY.accountAttempts,sourceMaximum:LOGIN_POLICY.sourceAttempts}))throw new IdentityError('rate_limited','login_limited');
   const {principal,dummyHash}=await store.passwordCandidate(input.loginId);if(!dummyHash)throw new IdentityError('unavailable','authentication_unavailable');
   const matches=await crypto.verifyPassword(input.password,principal?.encoded_hash??dummyHash);if(!principal||!principal.active||!matches)throw new IdentityError('unauthenticated','invalid_credentials');
   const token=crypto.randomToken(),sessionCsrf=crypto.randomToken();await store.commitPasswordLogin({absoluteSeconds:SESSION_LIFETIME.absoluteSeconds,principal,sessionHash:await crypto.digest(token),sessionCsrf,challengeHash,csrfHash});return{token};
  },validateChallenge,
  async setupContext(right,browser){return store.setupContext(await ownerBinding(right,browser));},
  async setupComplete(right,id,password,browser){operation(id);await ownerBinding(right,browser);const text=passwordInput(password),rightHash=await crypto.digest(right),inputHash=await crypto.setupInputHash(right,text),phase=await store.setupCompletionPhase(rightHash,id,inputHash);return store.commitSetupPassword({rightHash,operationId:id,inputHash,encodedPassword:phase==='ready'?await crypto.hashPassword(text):''});},
  async setupResult(right,id,browser){operation(id);return store.setupResult(await ownerBinding(right,browser),id);},
  async browserContext(nonce,challenge,csrf){
   browserProof(nonce);await validateChallenge(challenge,csrf);browserProof(csrf!);const browserToken=crypto.randomToken();
   const context=await store.reserveBrowserContext({nonceHash:await crypto.digest(nonce),browserHash:await crypto.digest(browserToken),csrfHash:await crypto.digest(csrf!),challengeHash:await crypto.digest(challenge!),lifetimeSeconds:BROWSER_EXCHANGE.contextSeconds});
   return{browserToken,expiresAt:context.expiresAt};
  },
  async browserRedeem(ticket,nonce,browser,csrf){
   [ticket,nonce,browser,csrf].forEach(browserProof);const sessionToken=crypto.randomToken(),sessionCsrf=crypto.randomToken();
   await store.redeemBrowserOnce({ticketHash:await crypto.digest(ticket),nonceHash:await crypto.digest(nonce),browserHash:await crypto.digest(browser),csrfHash:await crypto.digest(csrf),sessionHash:await crypto.digest(sessionToken),sessionCsrf,absoluteSeconds:SESSION_LIFETIME.absoluteSeconds});
   return{sessionToken};
  },
  async ownerContext(existing,challenge,csrf,expectedOperationId){
   if(expectedOperationId!==undefined){operation(expectedOperationId);if(existing===null)throw new IdentityError('forbidden','owner_setup_unavailable');}
   await validateChallenge(challenge,csrf);const browserToken=existing===null?crypto.randomToken():token(existing);
   const c=await store.reserveOwnerContext({contextHash:await crypto.digest(browserToken),csrfHash:await crypto.digest(token(csrf)),challengeHash:await crypto.digest(challenge!),existing:existing!==null,expectedOperationId,lifetimeSeconds:OWNER_CONTEXT_SECONDS});return{browserToken,expiresAt:c.expiresAt};
  },
  async ownerInitial(assertion,id,browser,csrf){
   operation(id);const proof=await ownerProof(browser,csrf),context=await store.readOwnerContext(proof.contextHash,proof.csrfHash);
   if(context.operationId!==null){if(context.operationId!==id)throw new IdentityError('conflict','owner_setup_conflict');return store.ownerSetupStatus(proof.contextHash,proof.csrfHash,id);}
   const raw=await store.readOwnerConfiguration();if(!raw)throw new IdentityError('forbidden','owner_initial_rejected');
   let configuration;try{configuration=verifier.ownerConfiguration(raw);}catch{throw new IdentityError('forbidden','owner_initial_rejected');}
   if(configuration.closesAt<=now||!assertion)throw new IdentityError('forbidden','owner_initial_rejected');
   const verified=await verifier.owner(assertion,configuration);requireOwnerBinding(configuration,verified,now);
   const expiresAt=ownerSetupExpiry(context.expiresAt,configuration.closesAt,verified.expiresAt,now);
   if(expiresAt<=now)throw new IdentityError('forbidden','owner_initial_rejected');
   return store.issueOwnerSetup({...proof,operationId:id,configuration,expectedConfiguration:raw,expiresAt,assertionExpiresAt:verified.expiresAt,rightId:'PS_'+await crypto.digest(JSON.stringify(['deployment',configuration.ownerId,id])),rightHash:await crypto.digest(crypto.randomToken()),lifetimeSeconds:SETUP_SECONDS});
  },
  async ownerStatus(id,browser,csrf){operation(id);const proof=await ownerProof(browser,csrf);return store.ownerSetupStatus(proof.contextHash,proof.csrfHash,id);},
  async ownerComplete(id,password,browser,csrf){
   operation(id);const text=passwordInput(password),proof=await ownerProof(browser,csrf),state=await store.ownerSetupStatus(proof.contextHash,proof.csrfHash,id);
   return store.completeOwnerSetup({...proof,operationId:id,inputHash:await crypto.setupInputHash(browser,text),encodedPassword:state.state==='ready'?await crypto.hashPassword(text):''});
  }
 };
 function query(q:ManagementQuery){const kind=managementRecordKind(q.kind);return{...q,kind,projectId:managementProject(kind,q.projectId)};}
 function bind(auth:Authenticated):IdentityUseCases {return{
  current:()=>store.readIdentity(auth,now),async logout(){if(auth.authentication!=='session')throw new IdentityError('forbidden','session_required');await store.revokeSession(auth.token_hash,now);},
  async browserTicket(nonce){
   const issuer=browserIssuer(auth);browserProof(nonce);const scope=browserScope(await store.readBrowserScope(issuer));
   const ticket=crypto.randomToken(),ticketHash=await crypto.digest(ticket);
   const result=await store.commitBrowserTicket(issuer,{nonceHash:await crypto.digest(nonce),ticketHash,ticketId:'BT_'+ticketHash,scope,lifetimeSeconds:BROWSER_EXCHANGE.ticketSeconds});
   return{ticket,...result};
  },
  managementContext:()=>store.readManagementContext(auth),managementList:q=>store.listManagement(auth,query(q)),
  managementRecord:q=>store.readManagement(auth,{...query(q),targetId:managementIdentifier(q.targetId)}),
  managementHistory:q=>store.readManagementHistory(auth,{...query(q),targetId:managementIdentifier(q.targetId)}),
  async managementExecute(command){const normalized=parseManagementCommand(command),read=await store.readManagementForChange(auth,normalized);return read.kind==='outcome'?read.outcome:store.commitManagement(auth,planManagement(normalized,read.snapshot));},managementRegister:command=>store.registerPrincipal(auth,normalizePrincipalRegistration(command)),managementResult:id=>store.managementResult(auth,managementIdentifier(id)),
  displayPrincipal:(projectId,principalId)=>store.displayPrincipal(auth,managementScopeIdentifier(projectId),managementIdentifier(principalId)),
  setupState:target=>store.setupState(auth,managementIdentifier(target)),
  async setupManage(target,id,revision,purpose,recipientRequestId){
   if((purpose!==null&&!['initial','reset'].includes(purpose))||!Number.isSafeInteger(revision)||revision<1||revision>=Number.MAX_SAFE_INTEGER)throw new IdentityError('invalid','invalid_revision');
   const targetId=managementIdentifier(target),operationId=operation(id);
   if(purpose)browserProof(recipientRequestId!);
   const read=await store.readSetupManagement(auth,{targetId,operationId,revision,purpose,...(purpose?{recipientRequestId}: {})});
   if(read.kind==='outcome')return read.outcome;
   const observed=read.observation;
   if(purpose&&(!observed.recipient||observed.recipient.expiresAt<=now))throw new IdentityError('forbidden','recipient_setup_unavailable');
   const action=purpose?{kind:'issue' as const,purpose,rightId:'PS_'+await crypto.digest(JSON.stringify([auth.id,operationId])),tokenHash:await crypto.digest(crypto.randomToken()),lifetimeSeconds:SETUP_SECONDS,expectedPasswordCount:setupPasswordCount(purpose),recipientRequestId:recipientRequestId!,contextExpiresAt:observed.recipient!.expiresAt,expiresAt:Math.min(observed.recipient!.expiresAt,now+SETUP_SECONDS)}:{kind:'revoke' as const};
   return store.commitSetupManagement(auth,planSetupManagement(observed,{targetId,operationId,revision,action}));
  },setupManagementResult:id=>store.setupManagementResult(auth,operation(id)),
 };}
 const authenticated=(proof:Authenticated)=>({proof,facts:{id:proof.id,kind:proof.kind,authentication:proof.authentication,csrf_token:proof.csrf_token,...(proof.authentication==='federated'?{assertion_expires_at:proof.assertion_expires_at}:{})},api:bind(proof)});
 return{entry,
  async authenticate(evidence:{kind:'session'|'api';token:string}){const hash=await crypto.digest(evidence.token),proof=evidence.kind==='session'?await store.authenticateSessionAndTouch(hash,now):await store.authenticateApi(hash,now);if(!proof)throw new IdentityError('unauthenticated','unauthenticated');return authenticated(proof);},
  async authenticateFederated(assertion:string,trust:AccessTrust){return authenticated(await store.resolveFederated(await verifier.agent(assertion,trust,now),now));}
 };
}
