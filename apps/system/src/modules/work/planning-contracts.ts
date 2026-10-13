// @module work
// @role public-value-policy
import type {ContentReference} from "./reference-contracts";
export const ISSUE_STATES=['Backlog','Todo','In Progress','In Review','Done','Canceled'] as const;
export type IssueState=typeof ISSUE_STATES[number];
export type TimeValue={kind:'date';date:string}|{kind:'instant';at:string}|{kind:'unknown'};
export interface Schedule {start:TimeValue|null;end:TimeValue|null;due:TimeValue|null}
export interface PlannedIssue {id:string;projectId:string;body:string;title?:string;references?:ContentReference[];revision:number;createdAt:string;updatedAt:string;priority:number|null;assigneeId:string|null;assignee:{id:string;kind:'human'|'agent';displayName:string;active:boolean}|null;state:IssueState;resolvedAt:string|null;resolution:TimeValue|null;schedule:Schedule}
export function validDate(value:string):boolean {return /^\d{4}-\d{2}-\d{2}$/.test(value)&&value>='0001-01-01'&&value<='9999-12-31'&&Number.isFinite(Date.parse(value+'T00:00:00.000Z'))&&new Date(value+'T00:00:00.000Z').toISOString().slice(0,10)===value;}
export function parseTime(value:unknown):TimeValue|null {
 if(value===null)return null;
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('time_invalid');
 const v=value as Record<string,unknown>;
 if(v.kind==='unknown'&&Object.keys(v).length===1)return{kind:'unknown'};
 if(v.kind==='date'&&Object.keys(v).length===2&&typeof v.date==='string'&&validDate(v.date))return{kind:'date',date:v.date};
 if(v.kind==='instant'&&Object.keys(v).length===2&&typeof v.at==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(v.at)&&Number(v.at.slice(11,13))<24&&Number(v.at.slice(14,16))<60&&Number(v.at.slice(17,19))<60&&validDate(v.at.slice(0,10))&&Number.isFinite(Date.parse(v.at))){const at=new Date(v.at).toISOString();if(!/^\d{4}-/.test(at))throw new Error('time_invalid');return{kind:'instant',at};}
 throw new Error('time_invalid');
}
export function parseSchedule(value:unknown):Schedule {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='due,end,start')throw new Error('schedule_invalid');
 const v=value as Record<string,unknown>,result={start:parseTime(v.start),end:parseTime(v.end),due:parseTime(v.due)};
 if(result.start&&result.end&&result.start.kind===result.end.kind){if(result.start.kind==='date'&&result.end.kind==='date'&&result.start.date>result.end.date)throw new Error('schedule_order');if(result.start.kind==='instant'&&result.end.kind==='instant'&&result.start.at>result.end.at)throw new Error('schedule_order');}return result;
}
