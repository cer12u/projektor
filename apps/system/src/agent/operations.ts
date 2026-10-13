// @module agent-sdk
// @role private-operations
/** Thin durable-operation transport. Domain parsing, permissions and receipt-first execution stay on the server. */
import {validContentId} from "../modules/work/content-contracts";
import {operationRequestHash} from "../modules/operation-protocol";
import type {DurableOperation,OperationPreparation,OperationReceipt,OperationRoute,OperationSummary,OperationSummaryPage} from "../modules/prepared-operations";
export type AgentWire=<T>(path:string,method?:string,body?:unknown)=>Promise<T>;
const root='/api/agent/operations',identifier=/^[A-Za-z0-9_-]{1,128}$/;
const executionActions=['acquire','renew','end','interrupt'];
const reportActions=['progress','failed','completed','reconcile','restart'];
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const validId=(value:unknown):value is string=>typeof value==='string'&&identifier.test(value);
const keys=(value:Record<string,unknown>,names:string[])=>Object.keys(value).every(key=>names.includes(key));
function invalid():never {throw new Error('operation_response_invalid');}
function same(a:unknown,b:unknown):boolean {
 if(a===b)return true;
 if(Array.isArray(a)&&Array.isArray(b))return a.length===b.length&&a.every((v,n)=>same(v,b[n]));
 if(object(a)&&object(b)){const names=Object.keys(a);return names.length===Object.keys(b).length&&names.every(k=>Object.hasOwn(b,k)&&same(a[k],b[k]));}
 return false;
}
/** Capture caller input before any await; never keep a mutable caller-owned operation. */
function copy(value:unknown):unknown {return JSON.parse(JSON.stringify(value));}
export function businessOperationRoute(path:string,method:string):OperationRoute|undefined {
 if(!['POST','PATCH'].includes(method)||path.includes('?'))return;
 const s=path.split('/');
 if(s[1]!=='api'||!['projects','workspaces'].includes(s[2])||!validId(s[3]))return;
 const workspace=s[2]==='workspaces',projectId=(workspace?'workspace:':'')+s[3];
 const kind=s[4]==='issues'?'issue':s[4]==='wikis'?'wiki':undefined;
 if(!kind||(workspace&&kind!=='wiki'))return;
 if(s.length===5&&method==='POST')return {kind,projectId};
 if(!validContentId({kind},s[5]??''))return;
 if(s.length===6&&method==='PATCH')return {kind,projectId,id:s[5]};
 if(s[6]==='comments'){
  const parent:Extract<OperationRoute,{kind:'comment'}>={kind:'comment',projectId,parentKind:kind,parentId:s[5]};
  if(s.length===7&&method==='POST')return parent;
  if(s.length===8&&method==='PATCH'&&validContentId({kind:'comment'},s[7]))return {...parent,id:s[7]};
 }
 if(!workspace&&kind==='issue'&&s.length===8&&method==='POST'){
  if(s[6]==='execution'&&executionActions.includes(s[7]))return {kind:'execution',projectId,issueId:s[5],action:s[7] as Extract<OperationRoute,{kind:'execution'}>['action']};
  if(s[6]==='execution-reports'&&reportActions.includes(s[7]))return {kind:'report',projectId,issueId:s[5],action:s[7] as Extract<OperationRoute,{kind:'report'}>['action']};
 }
}
function routeValid(value:unknown):value is OperationRoute {
 if(!object(value)||typeof value.projectId!=='string')return false;
 const workspace=value.projectId.startsWith('workspace:'),id=workspace?value.projectId.slice(10):value.projectId;
 if(!validId(id))return false;
 if(value.kind==='execution'||value.kind==='report')return !workspace&&keys(value,['kind','projectId','issueId','action'])&&typeof value.issueId==='string'&&validContentId({kind:'issue'},value.issueId)&&typeof value.action==='string'&&(value.kind==='execution'?executionActions:reportActions).includes(value.action);
 if(!['issue','wiki','comment'].includes(value.kind as string)||!keys(value,['kind','projectId','id',...(value.kind==='comment'?['parentKind','parentId']:[])]))return false;
 if(workspace&&value.kind==='issue')return false;
 if(value.kind==='comment'&&(!['issue','wiki'].includes(value.parentKind as string)||(workspace&&value.parentKind!=='wiki')||typeof value.parentId!=='string'||!validContentId({kind:value.parentKind as 'issue'|'wiki'},value.parentId)))return false;
 return !Object.hasOwn(value,'id')||(typeof value.id==='string'&&validContentId({kind:value.kind as 'issue'|'wiki'|'comment'},value.id));
}
type CheckedSummary=OperationSummary&Record<string,unknown>&{result:OperationSummary['result']&Record<string,unknown>};
function summaryValid(value:unknown):value is CheckedSummary {
 if(!object(value)||!Number.isSafeInteger(value.sequence)||(value.sequence as number)<1||!validId(value.operationId)||(!Number.isSafeInteger(value.formatVersion)||(value.formatVersion as number)<1)||typeof value.inputHash!=='string'||!/^[a-f0-9]{64}$/.test(value.inputHash)||!Number.isSafeInteger(value.preparedAt)||(value.preparedAt as number)<0||!object(value.target)||!keys(value.target,['kind','targetId','projectId'])||typeof value.target.kind!=='string'||typeof value.target.targetId!=='string'||typeof value.target.projectId!=='string'||!object(value.result)||!['unknown','confirmed'].includes(value.result.status as string))return false;
 return true;
}
function durable(value:unknown,operationId?:string):DurableOperation {
 if(!summaryValid(value)||!object(value)||value.recorded!==true||!routeValid(value.route)||!object(value.input)||value.input.operationId!==value.operationId||!Array.isArray(value.requiredPermissions)||!value.requiredPermissions.every(p=>['view','edit','assign','transition','execute'].includes(p as string))||!value.requiredPermissions.includes('view')||!object(value.result)||!keys(value.result,value.result.status==='confirmed'?['status','snapshot']:['status'])||(value.result.status==='confirmed'&&!object(value.result.snapshot)))invalid();
 if(operationId!==undefined&&value.operationId!==operationId)throw new Error('operation_response_mismatch');
 const route=value.route,target=value.target,kind=route.kind==='report'?'execution-report.'+route.action:route.kind==='execution'?'execution.'+route.action:route.kind+('id' in route?'.edit':'.create');
 if(target.kind!==kind||target.projectId!==route.projectId)throw new Error('operation_response_mismatch');
 if(route.kind==='execution'||route.kind==='report'){if(target.targetId!==route.issueId)throw new Error('operation_response_mismatch');}
 else if(!validContentId({kind:route.kind},target.targetId)||('id' in route&&target.targetId!==route.id))throw new Error('operation_response_mismatch');
 return value as unknown as DurableOperation;
}
/** Correlate a mutation receipt with the preparation already acknowledged in this call. */
export function verifyPreparedReceipt(saved:DurableOperation,receipt:OperationReceipt<unknown>,principalId:string):void {
 const mismatch=():never=>{throw new Error('operation_response_mismatch');};
 const {route,target}=saved,snapshot=receipt.snapshot;
 if(!object(snapshot))invalid();
 if(receipt.operationId!==saved.operationId)mismatch();
 if(route.kind==='issue'){
  if(snapshot.id!==target.targetId||snapshot.projectId!==target.projectId)mismatch();
 }else if(route.kind==='wiki'||route.kind==='comment'){
  if(snapshot.id!==target.targetId||snapshot.scopeId!==target.projectId)mismatch();
 }else{
  const matchesScope=(value:unknown)=>object(value)&&value.issueId===target.targetId&&value.projectId===target.projectId;
  const matchesTarget=(value:unknown)=>matchesScope(value)&&object(value)&&value.principalId===principalId;
  if(route.kind==='report'&&route.action==='reconcile'){
   // A reassigned current actor confirms the historical owner's attempt. Only the new evidence belongs to this actor.
   const input=saved.input;
   if(!object(input)||!matchesTarget(snapshot.confirmation)||!object(snapshot.confirmation)||snapshot.confirmation.operationId!==saved.operationId||snapshot.confirmation.attemptId!==input.attemptId||!matchesScope(snapshot.execution)||!object(snapshot.execution)||snapshot.execution.attemptId!==input.attemptId||(snapshot.importedReport!==null&&(!matchesTarget(snapshot.importedReport)||!object(snapshot.importedReport)||snapshot.importedReport.attemptId!==input.attemptId||snapshot.importedReport.operationId!==saved.operationId)))mismatch();
  }else if(route.kind==='report'&&route.action==='restart'){
   const input=saved.input;
   if(!object(input)||!matchesTarget(snapshot.attempt)||!object(snapshot.attempt)||!matchesTarget(snapshot.confirmation)||!object(snapshot.confirmation)||snapshot.confirmation.operationId!==input.confirmationOperationId||snapshot.confirmation.attemptId!==input.attemptId||snapshot.confirmation.leaseVersion!==input.leaseVersion||snapshot.attempt.startOperationId!==saved.operationId||snapshot.confirmation.newAttemptId!==snapshot.attempt.attemptId||snapshot.attempt.attemptId===input.attemptId)mismatch();
  }else {
   if(!matchesTarget(snapshot))mismatch();
   const input=saved.input;if(!object(input))throw new Error('operation_response_mismatch');
   if(route.kind==='report'&&(snapshot.attemptId!==input.attemptId||snapshot.operationId!==saved.operationId))mismatch();
   if(route.kind==='execution'&&(route.action==='acquire'?snapshot.startOperationId!==saved.operationId:snapshot.attemptId!==input.attemptId))mismatch();
  }
 }
}
export function operationListOptions(options:{after?:number;limit?:number}={}) {
 if(!object(options)||!keys(options,['after','limit']))throw new Error('client_route_rejected');
 const after=options.after??0,limit=options.limit??20;
 if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>50)throw new Error('client_route_rejected');
 return {after,limit};
}
export function operationRouteAllowed(path:string,method:string,query:string):boolean {
 if(path===root){
  if(method==='POST')return !query;
  if(method!=='GET')return false;
  const params=new URLSearchParams(query);
  for(const [key,value] of params)if(!['after','limit'].includes(key)||params.getAll(key).length!==1||!/^(0|[1-9][0-9]*)$/.test(value))return false;
  try{operationListOptions({after:Number(params.get('after')??0),limit:Number(params.get('limit')??20)});return true;}catch{return false;}
 }
 const match=path.match(/^\/api\/agent\/operations\/([A-Za-z0-9_-]{1,128})(\/execute)?$/);
 return !!match&&!query&&method===(match[2]?'POST':'GET');
}
export function agentOperationClient(wire:AgentWire) {
 return {
  async prepare(value:OperationPreparation):Promise<DurableOperation> {
   const preparation=copy(value) as OperationPreparation;
   if(!object(preparation)||!keys(preparation,['route','input'])||!routeValid(preparation.route)||!object(preparation.input)||!validId(preparation.input.operationId))throw new Error('operation_input_invalid');
   const operationId=preparation.input.operationId,requestHash=await operationRequestHash(preparation);
   const response=await wire<unknown>(root,'POST',preparation);
   if(!object(response)||!keys(response,['operation','requestHash'])||typeof response.requestHash!=='string')invalid();
   if(response.requestHash!==requestHash)throw new Error('operation_response_mismatch');
   const saved=durable(response.operation,operationId);
   if(saved.formatVersion!==1)invalid(); // New preparations use only this client's supported encoding.
   if(!same(saved.route,preparation.route))throw new Error('operation_response_mismatch');
   return saved;
  },
  async list(options:{after?:number;limit?:number}={}):Promise<OperationSummaryPage> {
   const {after,limit}=operationListOptions(options),value=await wire<unknown>(root+`?after=${after}&limit=${limit}`);
   if(!object(value)||!keys(value,['operations','nextAfter'])||!Array.isArray(value.operations)||value.operations.length>limit)invalid();
   let previous=after;const seen=new Set<string>();
   for(const row of value.operations){if(!summaryValid(row)||!object(row)||!keys(row,['sequence','operationId','formatVersion','inputHash','target','preparedAt','result'])||!object(row.result)||!keys(row.result,['status'])||row.sequence<=previous||seen.has(row.operationId))invalid();previous=row.sequence;seen.add(row.operationId);}
   if(value.nextAfter!==null&&(value.operations.length!==limit||value.nextAfter!==previous))invalid();
   return value as unknown as OperationSummaryPage;
  },
  async get(operationId:string):Promise<DurableOperation> {
   if(!validId(operationId))throw new Error('client_route_rejected');
   return durable(await wire(root+'/'+operationId),operationId);
  },
  async execute<T=unknown>(operationId:string):Promise<OperationReceipt<T>> {
   if(!validId(operationId))throw new Error('client_route_rejected');
   const value=await wire<unknown>(root+'/'+operationId+'/execute','POST',{});
   if(!object(value)||!keys(value,['operationId','snapshot','source'])||!validId(value.operationId)||!object(value.snapshot)||!['committed','recovered'].includes(value.source as string))invalid();
   if(value.operationId!==operationId)throw new Error('operation_response_mismatch');
   return value as unknown as OperationReceipt<T>;
  }
 };
}
