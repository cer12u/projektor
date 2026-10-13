// @module identity
// @role domain-rules
import type {Permission} from "./dto";
import {InputError} from "../change-outcomes";
import {IdentityError} from './outcomes';
import type {Authenticated} from './model';
export const PERMISSIONS: readonly Permission[] = ['view','edit','assign','transition','execute','manage'];
export function isPermission(value:unknown):value is Permission{return typeof value==='string'&&PERMISSIONS.some(p=>p===value);}
type Command<T>={operationId:string;kind:string;projectId:string;targetId:string;input:T};
type PermissionsInput = {revision:number;permissions:Permission[]};
type PrincipalInput = {revision:number;displayName:string|null;active:boolean|null};
type RevokeInput = {revision:number};
export type ManagementCommand =
  | Command<PermissionsInput> & {kind:'management.membership.set'|'management.credential.scope'}
  | Command<PrincipalInput> & {kind:'management.principal.update'}
  | Command<RevokeInput> & {kind:'management.credential.revoke'};
export const managementKinds = ['management.membership.set','management.credential.scope','management.principal.update','management.credential.revoke'] as const;
function object(value: unknown): Record<string,unknown> {
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new InputError('invalid_management_input');
  return value as Record<string,unknown>;
}
function keys(value: Record<string,unknown>, allowed: readonly string[]): void {
  if(Object.keys(value).some(k=>!allowed.includes(k))) throw new InputError('unknown_management_field');
}
/** A strict normalization boundary; actor, secret/token values and arbitrary SQL cannot be supplied. */
export function parseManagementCommand(value: unknown): ManagementCommand {
  const v=object(value);keys(v,['operationId','kind','targetId','projectId','input']);
  const kind=v.kind;
  if(typeof kind!=='string'||!managementKinds.some(k=>k===kind)) throw new InputError('invalid_management_kind');
  const ids: Record<string,string>={};
  for(const key of ['operationId','targetId','projectId']){
    const item=v[key];if(typeof item!=='string'||!(/^[A-Za-z0-9_-]{1,128}$/).test(item)) throw new InputError('invalid_management_identifier');
    ids[key]=item;
  }
  const input=object(v.input), revision=input.revision;
  if(typeof revision!=='number'||!Number.isSafeInteger(revision)||revision<1||revision>=Number.MAX_SAFE_INTEGER)
    throw new InputError('invalid_management_revision');
  const common={operationId:ids.operationId,targetId:ids.targetId,projectId:ids.projectId};
  if(kind==='management.membership.set'||kind==='management.credential.scope'){
    keys(input,['revision','permissions']);
    if(!Array.isArray(input.permissions)||!input.permissions.every(isPermission)) throw new InputError('invalid_management_permissions');
    return {...common,kind,input:{revision,permissions:[...new Set(input.permissions)].sort()}};
  }
  if(kind==='management.principal.update'){
    if(ids.projectId!=='GLOBAL')throw new InputError('invalid_global_context');
    keys(input,['revision','displayName','active']);
    const displayName=input.displayName??null,active=input.active??null;
    if(displayName!==null&&(typeof displayName!=='string'||displayName.trim().length===0||new TextEncoder().encode(displayName).byteLength>256))
      throw new InputError('invalid_display_name');
    if(active!==null&&typeof active!=='boolean')throw new InputError('invalid_principal_state');
    if(displayName===null&&active===null)throw new InputError('empty_management_change');
    return {...common,kind,input:{revision,displayName,active}};
  }
  if(ids.projectId!=='GLOBAL')throw new InputError('invalid_global_context');
  keys(input,['revision']);return {...common,kind:'management.credential.revoke',input:{revision}};
}

/** Provider-independent bootstrap binding, supplied by the trusted configuration adapter. */
export interface Configuration {ownerId:string;issuer:string;audience:string;subject:string;closesAt:number}
export function requireOwnerBinding(configuration:Configuration,verified:{issuer:string;audience:string;subject:string;expiresAt:number;notBefore:number},now:number):void {
 if(verified.issuer!==configuration.issuer||verified.audience!==configuration.audience||verified.subject!==configuration.subject||verified.expiresAt<=now||verified.notBefore>now)throw new IdentityError('forbidden','owner_initial_rejected');
}

export function passwordInput(value:unknown):string{
 if(typeof value!=='string'||Array.from(value).length<12||new TextEncoder().encode(value).length>1024||value.includes('\0')||/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value))throw new InputError('invalid_input',{password:'12文字以上、1024 UTF-8 bytes以内。'});return value;
}

export interface ProjectRights {projectId:string;permissions:Permission[]}
export interface PrincipalProvision {principalId:string;kind:'human'|'agent';displayName:string;loginId:string|null;globalAdministrator:boolean;projects:ProjectRights[]}
export function normalizePrincipalProvision(raw:PrincipalProvision){
 const principalId=raw.principalId;
 if(typeof principalId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(principalId)||Object.keys(raw).some(k=>!['principalId','kind','displayName','loginId','globalAdministrator','projects'].includes(k)))throw new InputError('invalid_deployment_input');
 if(!['human','agent'].includes(raw.kind)||typeof raw.displayName!=='string'||!raw.displayName.trim()||[...raw.displayName].length>128||typeof raw.globalAdministrator!=='boolean'||(raw.kind==='agent'&&(raw.loginId!==null||raw.globalAdministrator))||(raw.kind==='human'&&(typeof raw.loginId!=='string'||!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(raw.loginId))))throw new InputError('invalid_deployment_principal');
 if(!Array.isArray(raw.projects)||raw.projects.length>64)throw new InputError('invalid_deployment_rights');
 const seen=new Set<string>(),projects=raw.projects.map(p=>{
  if(!p||typeof p.projectId!=='string'||Object.keys(p).some(k=>!['projectId','permissions'].includes(k))||!(/^[A-Za-z0-9_-]{1,128}$/.test(p.projectId)||/^workspace:[a-fA-F0-9-]{36}$/.test(p.projectId))||seen.has(p.projectId)||!Array.isArray(p.permissions)||p.permissions.length>6||p.permissions.some(v=>!isPermission(v))||new Set(p.permissions).size!==p.permissions.length||(p.permissions.length&&!p.permissions.includes('view')))throw new InputError('invalid_deployment_rights');
  seen.add(p.projectId);return{projectId:p.projectId,permissions:[...p.permissions].sort()};
 }).sort((a,b)=>a.projectId.localeCompare(b.projectId));
 return {...raw,principalId,projects};
}

export interface PrincipalRegistration {operationId:string;principal:PrincipalProvision&{globalAdministrator:false}}
export function parsePrincipalRegistration(value:unknown):PrincipalRegistration {
 const body=object(value);
 if(Object.keys(body).some(k=>!['operationId','principalId','kind','displayName','loginId','projects'].includes(k)))throw new InputError('invalid_input',{body:'unknown fields'});
 const {operationId:rawOperationId,...raw}=body;
 if(typeof rawOperationId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(rawOperationId))throw new InputError('invalid_management_identifier');
 const principal=normalizePrincipalProvision({...raw,globalAdministrator:false} as unknown as PrincipalProvision);
 if(principal.projects.some(p=>!/^[A-Za-z0-9_-]{1,128}$/.test(p.projectId)))throw new InputError('invalid_management_identifier');
 if(new TextEncoder().encode(principal.displayName).byteLength>256)throw new InputError('invalid_display_name');
 return{operationId:rawOperationId,principal:{...principal,globalAdministrator:false}};
}
export function ownerSetupExpiry(contextExpiry:number,bootstrapDeadline:number,assertionExpiry:number,now:number):number {
 const expiresAt=Math.min(contextExpiry,bootstrapDeadline,assertionExpiry,now+SETUP_SECONDS);
 if(expiresAt<=now)throw new InputError('owner_initial_rejected');return expiresAt;
}

export type ManagementRecordKind='principal'|'membership'|'credential'|'scope';
export function managementRecordKind(value:string|null):ManagementRecordKind{
 if(!value||!['principal','membership','credential','scope'].includes(value))throw new InputError('invalid_management_kind');return value as ManagementRecordKind;
}
export function managementIdentifier(value:unknown):string{
 if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(value))throw new InputError('invalid_management_identifier');return value;
}
export function managementProject(kind:ManagementRecordKind,value:string|null):string{
 if(kind==='principal'||kind==='credential'){if(value!==null&&value!==''&&value!=='GLOBAL')throw new InputError('invalid_global_context');return 'GLOBAL';}
 return managementIdentifier(value);
}

export const SETUP_SECONDS=1800;
export const OWNER_CONTEXT_SECONDS=1800;
export const RECIPIENT_CONTEXT_SECONDS=1800;
export const BROWSER_EXCHANGE={contextSeconds:120,ticketSeconds:60} as const;
export const LOGIN_POLICY={challengeSeconds:600,windowSeconds:900,contextPerSource:60,accountAttempts:5,sourceAttempts:30} as const;
export interface BrowserScope {projectId:string;permission:Permission}
export interface BrowserScopeSource {memberships:BrowserScope[];grants:BrowserScope[]}
export type BrowserIssuer=Authenticated & {authentication:'api';kind:'agent';credential_id:string};
export function browserIssuer(auth:Authenticated):BrowserIssuer {
 if(auth.authentication!=='api'||auth.kind!=='agent'||!auth.credential_id)throw new IdentityError('forbidden','api_credential_required');
 return auth as BrowserIssuer;
}
export function browserProof(value:string):string {
 if(typeof value!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value))throw new IdentityError('invalid','invalid_input');return value;
}
/** The derived session can never gain rights absent from either source authority. */
export function browserScope(source:BrowserScopeSource):BrowserScope[] {
 const key=(r:BrowserScope)=>JSON.stringify([r.projectId,r.permission]),grants=new Set(source.grants.map(key));
 const selected=new Map(source.memberships.filter(r=>grants.has(key(r))).map(r=>[key(r),{projectId:r.projectId,permission:r.permission}]));
 return [...selected.values()].sort((a,b)=>a.projectId===b.projectId?(a.permission<b.permission?-1:a.permission>b.permission?1:0):(a.projectId<b.projectId?-1:1));
}
export const managementAuthority=(kind:string):'global-administrator'|'project'=>['management.principal.update','management.credential.revoke','management.principal.create'].includes(kind)?'global-administrator':'project';

export function normalizePrincipalRegistration(command:PrincipalRegistration):PrincipalRegistration {
 if(command.principal.globalAdministrator!==false)throw new InputError('invalid_registration_authority');
 const {globalAdministrator:ignored,...principal}=command.principal;void ignored;
 return parsePrincipalRegistration({operationId:command.operationId,...principal});
}

export function setupPasswordCount(purpose:'initial'|'reset'):0|1{return purpose==='initial'?0:1;}

/** Replacement/revocation is planned from an authorized snapshot; storage must recheck it. */
export function planSetupManagement(observed:import('./ports').SetupManagementObservation,request:Omit<import('./ports').SetupManagementCommit,'expected'|'revokeRightIds'|'nextRightId'>):import('./ports').SetupManagementCommit {
 return{...request,expected:observed.snapshot,revokeRightIds:[...observed.pendingRightIds],nextRightId:request.action.kind==='issue'?request.action.rightId:observed.snapshot.rightId};
}

/** Principal activation changes invalidate credentials exactly when active state changes. */
export function planManagement(command:ManagementCommand,expected:import('./public').ManagementSnapshot):import('./ports').ManagementPlan {
 if(command.kind!=='management.principal.update')return{command,expected};
 if(!('authVersion' in expected))throw new IdentityError('internal','invalid_principal_observation');
 const active=command.input.active===null?expected.active:Number(command.input.active);
 return{command,expected,principal:{displayName:command.input.displayName??expected.displayName,active,authVersion:expected.authVersion+Number(active!==expected.active)}};
}

export function confirmRecipientSetup(state:import('./public').RecipientSetupStatus,input:Omit<import('./public').RecipientCompletionInput,'password'>):asserts state is Exclude<import('./public').RecipientSetupStatus,{state:'waiting'}> {
 if(state.state==='waiting'||state.principalId!==input.principalId||state.operationId!==input.operationId||state.purpose!==input.purpose||state.issuerId!==input.issuerId)throw new IdentityError('forbidden','recipient_setup_unavailable');
}
