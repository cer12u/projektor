// @module work
// @role domain-rules
import {InputError} from "../change-outcomes";
import {validContentId,blankBodyAllowed,bodyLimit} from "./content-contracts";
import {parseContentReferences,type ContentReference} from "./reference-contracts";
import {ISSUE_STATES,parseSchedule,type PlannedIssue,type Schedule} from "./planning-contracts";
import type {Permission} from "../identity/dto";
import type {IssueChange,ContentChange,ContentResource,IssueListQuery,ImportedSourceQuery,LegacyReference} from './public';
export interface IssueInput {operationId:string;body?:string;title?:string;references?:ContentReference[];parentId?:string|null;typeId?:string|null;revision?:number;priority?:number|null;assigneeId?:string|null;state?:PlannedIssue['state'];schedule?:Schedule}
const identifier=/^[A-Za-z0-9_-]{1,128}$/;
export function validateIssueRoute(projectId:string,issueId?:string):void {
  const fields:Record<string,string>={};
  if(typeof projectId!=='string'||!identifier.test(projectId))fields.projectId='1–128 ASCII identifier';
  if(issueId!==undefined&&(typeof issueId!=='string'||!validContentId({kind:'issue'},issueId)))fields.issueId='fixed Issue ID or preserved UUID';
  if(Object.keys(fields).length)throw new InputError('invalid_input',fields);
}
export function parseIssueInput(value:unknown,edit:boolean,policy:{blank:boolean;bytes:number}={blank:false,bytes:8192}):IssueInput {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new InputError('invalid_input',{body:'object required'});
 const v=value as Record<string,unknown>,fields:Record<string,string>={},allowed=['operationId','body','title','references',...(edit?['revision','priority','assigneeId','state','schedule','parentId','typeId']:[])];
 for(const key of Object.keys(v))if(!allowed.includes(key))Object.defineProperty(fields,key,{value:'unknown field',enumerable:true});
 if(typeof v.operationId!=='string'||!identifier.test(v.operationId))fields.operationId='ASCII identifier required';
 if(!edit||Object.hasOwn(v,'body'))if(typeof v.body!=='string'||(!policy.blank&&!v.body.trim())||/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(v.body)||new TextEncoder().encode(v.body).length>policy.bytes||new TextEncoder().encode(JSON.stringify(v.body)).length>policy.bytes*1.5)fields.body=`valid Unicode <=${policy.bytes} UTF-8 bytes; JSON string <=${policy.bytes*1.5} bytes`;
 if(Object.hasOwn(v,'title')&&(typeof v.title!=='string'||/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(v.title)||new TextEncoder().encode(v.title).length>4096||new TextEncoder().encode(JSON.stringify(v.title)).length>6144))fields.title='valid Unicode <=4096 UTF-8 bytes';
 if(edit&&(typeof v.revision!=='number'||!Number.isSafeInteger(v.revision)||v.revision<1||v.revision>=Number.MAX_SAFE_INTEGER))fields.revision='positive safe integer';
 if(edit&&!['body','title','references','priority','assigneeId','state','schedule','parentId','typeId'].some(k=>Object.hasOwn(v,k)))fields.body='change required';
 if(Object.hasOwn(v,'priority')&&v.priority!==null&&(!Number.isInteger(v.priority)||typeof v.priority!=='number'||v.priority<1||v.priority>5))fields.priority='null or integer 1–5';
 if(Object.hasOwn(v,'assigneeId')&&v.assigneeId!==null&&(typeof v.assigneeId!=='string'||!identifier.test(v.assigneeId)))fields.assigneeId='null or principal ID';
 for(const k of['parentId','typeId'])if(Object.hasOwn(v,k)&&v[k]!==null&&(typeof v[k]!=='string'||!identifier.test(v[k])))fields[k]='null or fixed identifier';
 if(Object.hasOwn(v,'state')&&!ISSUE_STATES.some(state=>state===v.state))fields.state='defined Issue state required';
 let schedule:Schedule|undefined;if(Object.hasOwn(v,'schedule'))try{schedule=parseSchedule(v.schedule);}catch{fields.schedule='typed date/instant/unknown or null; valid start/end order';}
 let references:ContentReference[]|undefined;if(Object.hasOwn(v,'references'))try{references=parseContentReferences(v.references);}catch(error){fields.references=error instanceof Error?error.message:'invalid references';}
 if(Object.keys(fields).length)throw new InputError('invalid_input',fields);
 return {operationId:v.operationId as string,...(references?{references}:{}),...(edit?{revision:v.revision as number}:{}),...(Object.hasOwn(v,'body')?{body:v.body as string}:{}),...(Object.hasOwn(v,'title')?{title:v.title as string}:{}),...(Object.hasOwn(v,'priority')?{priority:v.priority as number|null}:{}),...(Object.hasOwn(v,'assigneeId')?{assigneeId:v.assigneeId as string|null}:{}),...(Object.hasOwn(v,'state')?{state:v.state as PlannedIssue['state']}:{}),...(Object.hasOwn(v,'parentId')?{parentId:v.parentId as string|null}:{}),...(Object.hasOwn(v,'typeId')?{typeId:v.typeId as string|null}:{}),...(schedule?{schedule}:{})};
}
export function validateContentRoute(project:string,resource:ContentResource,id?:string){
 if(typeof project!=='string'||!resource||typeof resource!=='object'||!['wiki','comment'].includes(resource.kind)||(resource.kind==='comment'&&(!['issue','wiki'].includes(resource.parentKind)||typeof resource.parentId!=='string'))||(id!==undefined&&typeof id!=='string'))throw new InputError('invalid_input',{route:'typed content route required'});
 if(Object.keys(resource).some(k=>!['kind',...(resource.kind==='comment'?['parentKind','parentId']:[])].includes(k)))throw new InputError('invalid_input',{route:'closed content resource required'});
 validateIssueRoute(project.startsWith('workspace:')?project.slice(10):project);
 if(resource.kind==='comment'){
  if(!validContentId({kind:resource.parentKind},resource.parentId))throw new InputError('invalid_input',{parentId:'fixed parent ID required'});
 }
 if(id!==undefined&&!validContentId(resource,id))throw new InputError('invalid_input',{id:'fixed content ID required'});
}
export function parseContentInput(value:unknown,edit:boolean,r:ContentResource={kind:'wiki'}):IssueInput {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new InputError('invalid_input',{body:'object required'});
 const v=value as Record<string,unknown>;
 if(Object.keys(v).some(k=>!['operationId','body',...(r.kind==='wiki'?['title','references']:[]),...(edit?['revision']:[])].includes(k))||(!edit&&typeof v.body!=='string'))throw new InputError('invalid_input',{body:'body/operationId and edit revision only'});
 return parseIssueInput(v,edit,{blank:blankBodyAllowed(r),bytes:bodyLimit(r)});
}
export const WORK_KINDS={issue:['issue.create','issue.edit'],wiki:['wiki.create','wiki.edit'],comment:['comment.create','comment.edit']} as const;
/** This rule set is interpreted for both direct commands and current durable disclosure. */
export const WORK_PERMISSION_RULES:readonly {permission:Permission;kinds:readonly string[];fields?:readonly string[]}[]=[
 {permission:'edit',kinds:['issue.create','wiki.create','wiki.edit','comment.create','comment.edit']},
 {permission:'edit',kinds:['issue.edit'],fields:['body','title','references','priority','schedule','parentId','typeId']},
 {permission:'assign',kinds:['issue.edit'],fields:['assigneeId']},
 {permission:'transition',kinds:['issue.edit'],fields:['state']}
];
export function workPermissions(kind:string,input:object):Permission[]{return [...new Set(WORK_PERMISSION_RULES.filter(r=>r.kinds.includes(kind)&&(!r.fields||r.fields.some(f=>Object.hasOwn(input,f)))).map(r=>r.permission))];}

export function decodeIssueChange(projectId:string,issueId:string|undefined,value:unknown):IssueChange {
 validateIssueRoute(projectId,issueId);const input=parseIssueInput(value,issueId!==undefined);
 return issueId===undefined?{kind:'create',projectId,input} as IssueChange:{kind:'edit',projectId,issueId,input} as IssueChange;
}
export function decodeContentChange(projectId:string,resource:ContentResource,id:string|undefined,value:unknown):ContentChange {
 validateContentRoute(projectId,resource,id);const input=parseContentInput(value,id!==undefined,resource);
 return id===undefined?{kind:'create',projectId,resource,input} as ContentChange:{kind:'edit',projectId,resource,id,input} as ContentChange;
}
export function normalizeIssueChange(command:IssueChange):IssueChange {
 if(!command||!['create','edit'].includes(command.kind)||Object.keys(command).some(k=>!['kind','projectId','input',...(command.kind==='edit'?['issueId']:[])].includes(k)))throw new InputError('invalid_input',{command:'closed Issue command required'});
 if(command.kind==='edit'&&typeof command.issueId!=='string')throw new InputError('invalid_input',{issueId:'Issue ID required'});
 return decodeIssueChange(command.projectId,command.kind==='edit'?command.issueId:undefined,command.input);
}
export function normalizeContentChange(command:ContentChange):ContentChange {
 if(!command||!['create','edit'].includes(command.kind)||Object.keys(command).some(k=>!['kind','projectId','resource','input',...(command.kind==='edit'?['id']:[])].includes(k)))throw new InputError('invalid_input',{command:'closed Content command required'});
 if(command.kind==='edit'&&typeof command.id!=='string')throw new InputError('invalid_input',{id:'content ID required'});
 return decodeContentChange(command.projectId,command.resource,command.kind==='edit'?command.id:undefined,command.input);
}
export function validateIssueListQuery(query:IssueListQuery):void {
 if(!query||typeof query.q!=='string'||[...query.q].length>128||typeof query.state!=='string'||(query.state&&!ISSUE_STATES.some(s=>s===query.state))||typeof query.mine!=='boolean'||!Number.isSafeInteger(query.page)||query.page<1||query.page>999999||!Number.isSafeInteger(query.pageSize)||query.pageSize<1||query.pageSize>50||query.order!=='priority')throw new InputError('invalid_input');
}
export function validateContentPage(page:number,pageSize:number):void {
 if(!Number.isSafeInteger(page)||page<1||page>999999||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>50)throw new InputError('invalid_input',{query:'page 1–999999; pageSize 1–50'});
}
export function validateHistoryPage(after:number,limit:number):void {
 if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>50)throw new InputError('invalid_input',{query:'afterRevision >=0 safe integer; limit 1–50'});
}
export function validateOperationId(operationId:string):void {
 if(typeof operationId!=='string'||!identifier.test(operationId))throw new InputError('invalid_input',{operationId:'1–128 ASCII identifier'});
}
export function validateImportedSource(query:ImportedSourceQuery):void {
 const {scopeId:scope,kind,id,page=1}=query;
 if(typeof scope!=='string'||typeof id!=='string'||!/^(?:workspace:)?[A-Za-z0-9_-]{1,128}$/.test(scope)||!/^[A-Za-z0-9_-]{1,128}$/.test(id)||!['issues','wiki_pages','issue_comments','projects'].includes(kind)||!Number.isSafeInteger(page)||page<1||page>100000)throw new InputError('invalid_query');
}

/** Canonical imported catalogue keys are Work rules, independent of storage. */
export function priorityKey(priority:number):string|null {return ({1:'low',2:'medium',3:'high',4:'urgent'} as Record<number,string>)[priority]??null;}
export function statusKey(state:PlannedIssue['state']):string {return {Backlog:'backlog',Todo:'todo','In Progress':'in_progress','In Review':'in_review',Done:'done',Canceled:'cancelled'}[state];}
export function decodeLegacyReference(path:string):LegacyReference {
 if(typeof path!=='string')throw new InputError('invalid_input');
 const issue=path.match(/^\/projects\/([A-Za-z0-9_-]{1,128})\/issues\/([1-9][0-9]*)\/[^/?#]+\/?$/),project=path.match(/^\/projects\/view\/([A-Za-z0-9_-]{1,128})\/?$/),wiki=path.match(/^\/wiki\/([^/?#]+)\/?$/);
 if(issue){const number=Number(issue[2]);if(!Number.isSafeInteger(number))throw new InputError('invalid_input');return {kind:'issue-number',projectKey:issue[1],number};}
 if(project)return {kind:'project-slug',slug:project[1]};
 if(wiki){try{return {kind:'wiki-slug',slug:decodeURIComponent(wiki[1])};}catch{throw new InputError('invalid_input');}}
 throw new InputError('invalid_input');
}
export function validateLegacyReference(query:LegacyReference):void {
 if(!query||typeof query!=='object')throw new InputError('invalid_input');
 if(query.kind==='issue-number'){if(typeof query.projectKey!=='string'||!identifier.test(query.projectKey)||!Number.isSafeInteger(query.number)||query.number<1)throw new InputError('invalid_input');return;}
 if(!['project-slug','wiki-slug'].includes(query.kind)||typeof query.slug!=='string'||!query.slug)throw new InputError('invalid_input');
}

export const WORK_INPUT_LIMITS={issue:20480,wiki:57344,comment:16384} as const;
