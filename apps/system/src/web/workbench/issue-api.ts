// @module workbench
// @role transport
import {request} from '../session/access';
import {HttpError} from '../platform/index';
import {CreationNotApplied} from './creation-not-applied';
import {validContentResponse} from './content-response-validation';
import {ContentAuthority} from './content-authority';
import type {IssueListQuery} from './issue-list-query';
export type {IssueListQuery} from './issue-list-query';
import type {Issue,IssueChanges,Receipt,IssueHistory} from './editor-contracts';
import type {ContentReference} from "../../modules/work/reference-contracts";
import {resourceKey,idPrefix,validContentId,scopeOf,type EditingResource,type BodyDocument} from "../../modules/work/content-contracts";
import type {Identity} from "../../modules/identity/dto";
export {CreationNotApplied} from './creation-not-applied';
export {isIssue} from './content-response-validation';
export class IssueApi{
  private readonly authority:ContentAuthority;
  constructor(readonly owner:string,identityChanged:(identity:Identity)=>void,readonly resource:EditingResource={kind:'issue'}){this.authority=new ContentAuthority(owner,identityChanged);}
  get resourceKey(){return resourceKey(this.resource);}
  get prefix(){return idPrefix(this.resource);}
  storageTarget(id:string){return this.resource.kind==='issue'?id:this.resourceKey+':'+id;}
  documentId(target:string){if(validContentId(this.resource,target))return target;const stem=this.resourceKey+':';return target.startsWith(stem)&&validContentId(this.resource,target.slice(stem.length))?target.slice(stem.length):null;}
  valid(value:unknown):value is BodyDocument{return validContentResponse(this.resource,value);}
  assertCurrent(value:object){this.authority.assertCurrent(value);}
  onReadDenied(listener:(project:string,target:string)=>void){return this.authority.onReadDenied(listener);}
  directory<T>():Promise<T>{return this.authority.observe(undefined,()=>request<T>('/api/directory'));}
  resolve(path:string):Promise<{url:string}>{return this.authority.observe(undefined,()=>request('/api/resolve?path='+encodeURIComponent(path)));}
  source<T>(project:string,target:string,page:number):Promise<T>{return this.authority.observe(project,()=>{const kind=this.resource.kind==='issue'?'issues':this.resource.kind==='wiki'?'wiki_pages':'issue_comments';const root=project.startsWith('workspace:')?'/api/workspaces/'+project.slice(10):'/api/projects/'+project;return request<T>(root+'/source/'+kind+'/'+target+'?page='+page);},target);}
  private root(project:string){const p=project.startsWith('workspace:')?`/api/workspaces/${encodeURIComponent(project.slice(10))}`:`/api/projects/${encodeURIComponent(project)}`;return this.resource.kind==='comment'?`${p}/${this.resource.parentKind==='issue'?'issues':'wikis'}/${encodeURIComponent(this.resource.parentId)}`:p;}
  private path(project:string,id?:string){return this.root(project)+`/${this.resource.kind==='issue'?'issues':this.resource.kind==='wiki'?'wikis':'comments'}`+(id?'/'+encodeURIComponent(id):'');}
  get(project:string,target:string):Promise<BodyDocument>{return this.authority.observe(project,async()=>{const id=this.documentId(target);if(!id)throw new Error('invalid_content_target');const r=await request<{issue?:Issue;document?:BodyDocument}>(this.path(project,id));const value=this.resource.kind==='issue'?r.issue:r.document;if(!this.valid(value)||value.id!==id||scopeOf(value)!==project)throw new Error('invalid_content_response');return value;},this.documentId(target)??target);}
  async send(project:string,operationId:string,body:string,id?:string,revision?:number,changes?:IssueChanges,title?:string,references?:ContentReference[]):Promise<Receipt>{
    if(!navigator.locks)throw new HttpError(400,'browser_coordination_unavailable',{browser:'このブラウザでは保存できません。入力をダウンロードし、対応ブラウザで作業を続けてください。'});
    return await this.authority.observe(project,async(i)=>{try{return await request<Receipt>(this.path(project,id),{method:id?'PATCH':'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':i.csrfToken??''},
      body:JSON.stringify({operationId,...(changes??{body,...(title!==undefined?{title}:{}),...(references!==undefined?{references}:{})}),...(id?{revision}:{})})});}catch(error){
      if(!id&&this.resource.kind==='issue'&&error instanceof HttpError&&error.status===403){const proof=error.mutationOutcome as {operationId?:unknown;status?:unknown;phase?:unknown}|undefined;
        if(proof&&proof.operationId===operationId&&proof.status==='not_applied'&&proof.phase==='pre_dispatch')throw new CreationNotApplied(operationId,error);
      }throw error;
    }});
  }
  checkCreationPermission(project:string):Promise<void>{return this.authority.checkCreationPermission(project);}
  result(project:string,operationId:string):Promise<Receipt>{return this.authority.observe(project,async()=>{const r=await request<Receipt>(this.root(project)+`/${this.resource.kind}-operations/${encodeURIComponent(operationId)}`);return r;});}
  list(project:string,query:IssueListQuery){return this.authority.observe(project,async()=>{const r=await request<{issues:Issue[];total:number;page:number;pageSize:number;order:string}>(this.path(project)+'?'+new URLSearchParams({q:query.q,state:query.state,mine:query.mine,page:query.page,pageSize:query.pageSize,order:query.order}).toString());return r;});}
  documents(project:string,page=1,pageSize=20){return this.authority.observe(project,async()=>{const r=await request<{documents:BodyDocument[];total:number;page:number;pageSize:number}>(this.path(project)+`?page=${page}&pageSize=${pageSize}`);if(!r.documents.every(v=>this.valid(v)&&scopeOf(v)===project))throw new Error('invalid_content_list');return r;});}
  assignees(project:string){return this.authority.observe(project,async()=>{const r=await request<{principals:{id:string;kind:'human'|'agent';displayName:string}[]}>(`/api/projects/${encodeURIComponent(project)}/assignees`);return r;});}
  history(project:string,id:string,afterRevision=0){return this.authority.observe(project,async()=>{const r=await request<{history:IssueHistory[];resolutionEvents:{revision:number;kind:string;time:import("../../modules/work/planning-contracts").TimeValue;recordedAt:string}[];nextAfterRevision:number|null;nextResolutionAfterRevision:number|null}>(this.path(project,this.documentId(id)??id)+'/history?limit=50&afterRevision='+afterRevision);return r;},this.documentId(id)??id);}
}
