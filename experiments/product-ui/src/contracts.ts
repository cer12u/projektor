/** UI ports, not a new wire schema. The product bootstrap owner must supply these
 * from an authenticated, validated response. No URL/local-storage identity. */
export interface Workspace { id:string; epoch:string; title:string; principal?:Principal }
export interface Principal { id:string; kind:'human'|'machine'; displayName:string }
export interface Bootstrap { principal:Principal|null; workspaces:Workspace[]; expiresAt:number }
export interface Route { view:'list'|'board'|'issue'|'create'|'wiki'|'wiki-page'|'wiki-create'; pageId:string|null; wikiProtectionScope:'project'|'workspace_shared'|null; workspaceId:string|null; issueId:string|null; projectId:string|null; status:'all'|'unresolved'; draftId:string|null; projectAtProtection:string|null }
export interface Selected { principal:Principal; workspace:Workspace }
export interface ProductPorts {
  evidence:'product'|'contract-fixture';
  bootstrap(options:{signal:AbortSignal}):Promise<Bootstrap>;
  /** Must freshly verify selected workspace and principal. Never select by email. */
  session(selected:Selected,options?:{signal?:AbortSignal}):Promise<any>;
  wikiAPI?(selected:Selected):any;
  wikiProtection?(options:any):any;
  contentAPI(selected:Selected):any;
  listTransport(selected:Selected):any;
  protection(options:{selected:Selected;api:any;issueId:string|null;projectId:string|null;draftId:string;projectAtProtection?:string;dirty:()=>boolean;onBinding:(binding:any)=>void}):any;
}
export type PrepareLeave = ()=>Promise<boolean>;
export const missingProductPorts:ProductPorts={
  evidence:'product',
  async bootstrap(){throw Object.assign(new Error('BOOTSTRAP_PORT_UNCONNECTED'),{code:'BOOTSTRAP_PORT_UNCONNECTED'});},
  async session(){throw new Error('SESSION_PORT_UNCONNECTED');},
  contentAPI(){throw new Error('CONTENT_PORT_UNCONNECTED');},
  listTransport(){throw new Error('LIST_PORT_UNCONNECTED');},
  protection(){throw new Error('DRAFT_KEY_PORT_UNCONNECTED');},
};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const isID=(v:unknown):v is string=>typeof v==='string'&&UUID.test(v);
export function checkBootstrap(value:Bootstrap,now=Date.now()):Bootstrap{
  const actor=(p:Principal|null|undefined)=>!!p&&isID(p.id)&&['human','machine'].includes(p.kind)&&typeof p.displayName==='string';
  if(!value||value.principal!==null&&!actor(value.principal)||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=now||!Array.isArray(value.workspaces)||value.workspaces.length>10||value.workspaces.some(w=>!isID(w.id)||!isID(w.epoch)||typeof w.title!=='string'||!actor(w.principal??value.principal))||new Set(value.workspaces.map(w=>w.id)).size!==value.workspaces.length)throw new Error('BOOTSTRAP_INVALID');
  return structuredClone(value);
}
export function chooseWorkspace(data:Bootstrap,requested:string|null):Workspace|null{
  if(requested){const match=data.workspaces.find(w=>w.id===requested);if(!match)throw new Error('WORKSPACE_UNAVAILABLE');return match;}
  return data.workspaces.length===1?data.workspaces[0]:null;
}
/** Preserve a locked view/controller across temporary absent membership.
 * This result is never used as authorization or current-selection metadata. */
export function retainViewSelection(previous:Selected|null,current:Selected|null):Selected|null{
  if(!current)return previous;
  if(previous&&previous.principal.id===current.principal.id&&previous.principal.kind===current.principal.kind&&previous.workspace.id===current.workspace.id&&previous.workspace.epoch===current.workspace.epoch)return previous;
  return current;
}
/** Presentation only: no-workspace and wrong-selection notices are exclusive.
 * This does not resolve a workspace or grant access to a retained view. */
export function workspaceAccessNotice(workspaceCount:number|null,selectionError:boolean):'none'|'no-workspaces'|'selection-unavailable'{
  if(workspaceCount===0)return 'no-workspaces';
  return workspaceCount!==null&&workspaceCount>0&&selectionError?'selection-unavailable':'none';
}

/** Imported current-state metadata stays distinct from canonical workflow rules. */
export interface IssueStatusOption { id:string; key:string; name:string; toStatus:string; isReviewStep:boolean }
export interface IssueCompatibilitySummary {
  statusId:string|null; statusKey:string|null; statusName:string|null; isReviewStep:boolean;
  typeId:string|null; typeName:string|null;
}
export interface IssueCompatibility extends IssueCompatibilitySummary {
  completionReportAt:number|null;
  dor:{ready:boolean|null; missingRaw:string|null; missing:unknown[]|null; evidenceState:'current'|'stale_after_edit'; evaluatedRevisionId:string|null};
  statuses:IssueStatusOption[];
}
