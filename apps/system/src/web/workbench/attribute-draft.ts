// @module workbench
// @role model
import{parseSchedule,type Schedule,type TimeValue}from"../../modules/work/planning-contracts";
import type{Permission}from"../../modules/identity/dto";
import {type Issue, type IssueChanges} from './editor-contracts';
import{localInput,localInstant}from'./planning-time';
export type TimeDraft={kind:'none'|'date'|'instant'|'unknown';value:string};
export interface AttributeDraft{priority?:string;assigneeId?:string;state?:string;parentId?:string;typeId?:string;schedule?:{zone:string;times:Record<keyof Schedule,TimeDraft>}}
const timeDraft=(v:TimeValue|null,zone:string):TimeDraft=>({kind:v?.kind??'none',value:localInput(v,zone)});
export const scheduleDraft=(schedule:Schedule,zone:string)=>({zone,times:{start:timeDraft(schedule.start,zone),end:timeDraft(schedule.end,zone),due:timeDraft(schedule.due,zone)}});
function parsedSchedule(draft:NonNullable<AttributeDraft['schedule']>):Schedule{const schedule:Schedule={start:null,end:null,due:null};for(const k of['start','end','due']as const){const v=draft.times[k];schedule[k]=v.kind==='none'?null:v.kind==='unknown'?{kind:'unknown'}:v.kind==='date'?{kind:'date',date:v.value}:localInstant(v.value,draft.zone);}return parseSchedule(schedule);}
export function pruneAttributes(draft:AttributeDraft,issue:Issue):AttributeDraft{const next={...draft};for(const k of['priority','assigneeId','state','parentId','typeId']as const)if(next[k]!==undefined&&next[k]===String((issue as Issue&{parentId?:string|null;typeId?:string|null})[k]??''))delete next[k];if(next.schedule)try{if(JSON.stringify(parsedSchedule(next.schedule))===JSON.stringify(issue.schedule))delete next.schedule;}catch{/* Retain incomplete input for this owner. */}return next;}
export function attributeChanges(draft:AttributeDraft,issue:Issue,rights:readonly Permission[]):IssueChanges{const d=pruneAttributes(draft,issue),changes:IssueChanges={};if(!rights.includes('view'))return changes;
 if(rights.includes('edit')){if(d.priority!==undefined)changes.priority=d.priority?Number(d.priority):null;if(d.parentId!==undefined)changes.parentId=d.parentId||null;if(d.typeId!==undefined)changes.typeId=d.typeId||null;if(d.schedule)changes.schedule=parsedSchedule(d.schedule);}
 if(rights.includes('assign')&&d.assigneeId!==undefined)changes.assigneeId=d.assigneeId||null;
 if(rights.includes('transition')&&d.state!==undefined)changes.state=d.state as Issue['state'];return changes;
}
