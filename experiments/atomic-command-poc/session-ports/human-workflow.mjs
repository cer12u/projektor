// Human editor lane. Reuses I1's protected journal, CAS, receipt reconciliation,
// late-edit handling and bounded retry budgets. No machine claims or lease API.
import {IssueContentController} from '../client/issue-content.mjs';
const extra=new Set(['title','progress','transition']);
const id=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x);
const terminal=j=>j&&['committed','rejected'].includes(j.state);
const text=x=>typeof x==='string'&&x.isWellFormed()&&new TextEncoder().encode(x).length<=256*1024;
export class HumanWorkflowController extends IssueContentController{
 initial(mode,commentId){
  if(mode==='title')return {value:{title:this.issue.title},baseVersion:this.issue.version};
  if(mode==='progress')return {value:{bodyMarkdown:''},baseVersion:this.issue.version};
  if(mode==='transition')return {value:{toStatus:this.issue.status,reason:'',waitingFor:'',nextStep:'',resultSummary:''},baseVersion:this.issue.version};
  return super.initial(mode,commentId);
 }
 select(mode,commentId){
  if(!extra.has(mode))return super.select(mode,commentId);
  if(this.locked||this.projectId||!this.issue)return {kind:'stopped'};
  const key=this.draftKey(mode,commentId);if(!this.record.drafts[key])this.record.drafts[key]={mode,...this.initial(mode),revision:0,ack:0};
  this.record.active=key;this.touch();this.emit();this.scheduleFlush();return {kind:'selected'};
 }
 validateDraft(draft){
  if(!extra.has(draft.mode))return super.validateDraft(draft);
  const p=draft.value;
  if(draft.mode==='title')return text(p.title)&&p.title.trim()&&new TextEncoder().encode(p.title).length<=4096?null:'VALIDATION';
  if(draft.mode==='progress')return text(p.bodyMarkdown)&&p.bodyMarkdown.trim()?null:'PROGRESS_EMPTY';
  if(!['backlog','ready','in_progress','blocked','done','canceled'].includes(p.toStatus)||![p.reason,p.waitingFor,p.nextStep,p.resultSummary].every(text)||new TextEncoder().encode(p.reason+p.waitingFor+p.nextStep+p.resultSummary).length>256*1024)return 'VALIDATION';
  return null;
 }
 async save(){
  const draft=this.record?.drafts[this.record.active];
  if(!draft||!extra.has(draft.mode))return super.save();
  if(this.locked||this.busy||this.session?.actorKind!=='human')return {kind:'stopped'};
  if(this.record.journal&&!terminal(this.record.journal))return {kind:'pending',code:'CHECK_EXISTING_OPERATION'};
  const code=this.validateDraft(draft);if(code){this.code=code;this.emit();return {kind:'invalid',code};}
  let commandType,payload;const v=structuredClone(draft.value);
  if(draft.mode==='title'){commandType='Issue.UpdateTitle';payload=v;}
  else if(draft.mode==='progress'){commandType='Issue.AppendProgress';payload={payloadVersion:2,entryId:this.uuid(),bodyMarkdown:v.bodyMarkdown};}
  else {commandType='Issue.Transition';payload={payloadVersion:2,entryId:this.uuid(),toStatus:v.toStatus,...(v.reason.trim()?{reason:{text:v.reason}}:{}),...(v.waitingFor?{waitingFor:v.waitingFor}:{}),...(v.nextStep?{nextStep:v.nextStep}:{}),...(v.resultSummary.trim()?{result:{summary:v.resultSummary,artifactIds:[]}}:{})};}
  this.record.journal={state:'prepared',key:this.record.active,revision:draft.revision,attempts:0,checks:0,firstSubmittedAt:null,nextAllowedAt:0,command:{schemaVersion:1,workspaceId:this.session.workspaceId,workspaceEpoch:this.session.workspaceEpoch,operationId:this.uuid(),commandType,entityId:this.issueId,expectedVersion:draft.baseVersion,payload}};
  this.touch();return this.dispatch();
 }
 apply(result){
  const journal=this.record.journal,c=journal.command,d=result.body?.data;
  if(result.kind==='committed'&&['Issue.UpdateTitle','Issue.AppendProgress','Issue.Transition'].includes(c.commandType)&&d?.effectApplied===false&&(c.commandType!=='Issue.Transition'||d.committedVersion!==c.expectedVersion)){journal.state='unknown';this.touch();return {kind:'ambiguous',code:'RECEIPT_BINDING_MISMATCH'};}
  if(result.kind==='committed'&&['Issue.AppendProgress','Issue.Transition'].includes(c.commandType)&&d?.effectApplied===true&&(d.entryId!==c.payload.entryId||!id(d.revisionId)||c.commandType==='Issue.Transition'&&['done','canceled'].includes(c.payload.toStatus)&&!id(d.resolutionRecordId))){journal.state='unknown';this.touch();return {kind:'ambiguous',code:'RECEIPT_BINDING_MISMATCH'};}
  return super.apply(result);
 }
}
