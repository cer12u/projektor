// @module work
// @role domain-rules
/** Work decisions over typed observations. Commit time and persistence are supplied by the adapter. */
import type {Permission} from '../identity/dto';
import type {IssueChange,IssueView,IssuePatch,ContentChange} from './public';
import {priorityKey,statusKey,workPermissions} from './rules';
export interface IssueChangeState {current:IssueView;statusDefinitions:{id:string;key:string}[]}
export type RelatedIssueRequirement=
 | {kind:'workspace_type';id:string}
 | {kind:'acyclic_parent';id:string}
 | {kind:'eligible_assignee';id:string};
export interface IssueChangePlan {
 permissions:Permission[];fields:(keyof IssuePatch)[];
 priorityKey?:string|null;
 related:RelatedIssueRequirement[];
 transition?:{
  expectedRevision:number;expectedState:IssueView['state'];expectedImported:boolean;
  nextState:IssueView['state'];resolution:'preserve'|'stamp'|'clear';
  status:{kind:'retain'}|{kind:'replace';id:string;key:string};
  resolutionEvent:'resolved'|'reopened'|null;
 };
}
export type IssueChangeDecision={kind:'commit';plan:IssueChangePlan}|{kind:'reject';reason:'revision_conflict'|'status_definition_unavailable'};
export function needsIssueState(command:IssueChange):command is Extract<IssueChange,{kind:'edit'}>{return command.kind==='edit'&&command.input.state!==undefined;}
export function decideIssueChange(command:IssueChange,state?:IssueChangeState):IssueChangeDecision {
 const input=command.input;
 const fields=Object.keys(input).filter(k=>k!=='revision'&&k!=='operationId').sort() as (keyof IssuePatch)[];
 const patch=command.input as IssuePatch;
 const related:RelatedIssueRequirement[]=[];
 if(patch.typeId!=null)related.push({kind:'workspace_type',id:patch.typeId});
 if(patch.parentId!=null)related.push({kind:'acyclic_parent',id:patch.parentId});
 if(patch.assigneeId!=null)related.push({kind:'eligible_assignee',id:patch.assigneeId});
 const plan:IssueChangePlan={permissions:workPermissions('issue.'+command.kind,input),fields,related,
  ...(patch.priority!==undefined?{priorityKey:patch.priority===null?'none':priorityKey(patch.priority)}:{})};
 if(!needsIssueState(command))return {kind:'commit',plan};
 if(!state)throw new Error('issue_planning_state_required');
 const current=state.current,next=command.input.state!;
 if(current.revision!==command.input.revision)return {kind:'reject',reason:'revision_conflict'};
 const imported=current.metadata!==null,key=statusKey(next),definitions=state.statusDefinitions.filter(d=>d.key===key);
 if(imported&&definitions.length!==1)return {kind:'reject',reason:'status_definition_unavailable'};
 plan.transition={expectedRevision:current.revision,expectedState:current.state,expectedImported:imported,nextState:next,
  resolution:next==='Done'?(current.state==='Done'?'preserve':'stamp'):'clear',
  status:imported?{kind:'replace',id:definitions[0].id,key}:{kind:'retain'},
  resolutionEvent:current.state!=='Done'&&next==='Done'?'resolved':current.state==='Done'&&next!=='Done'?'reopened':null};
 return {kind:'commit',plan};
}
export interface ContentChangePlan {permissions:Permission[]}
export function decideContentChange(command:ContentChange):ContentChangePlan {
 return {permissions:workPermissions(command.resource.kind+'.'+command.kind,command.input)};
}
