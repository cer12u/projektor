// @module workbench
// @role model
import type{TimeValue}from"../../modules/work/planning-contracts";
function parts(at:string,zone:string){const p=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(at));return Object.fromEntries(p.map(v=>[v.type,v.value]));}
export function dateInZone(value:TimeValue|null,zone:string):string|null {if(!value||value.kind==='unknown')return null;if(value.kind==='date')return value.date;const p=parts(value.at,zone);return `${p.year}-${p.month}-${p.day}`;}
export function displayTime(value:TimeValue|null,zone:string):string {if(!value)return'未設定';if(value.kind==='unknown')return'時刻不明（過去記録）';if(value.kind==='date')return value.date+'（日付のみ）';return new Intl.DateTimeFormat('ja-JP',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',timeZoneName:'shortOffset',hourCycle:'h23'}).format(new Date(value.at))+` (${zone})`;}
export function localInput(value:TimeValue|null,zone:string):string {if(!value||value.kind==='unknown')return'';if(value.kind==='date')return value.date;const p=parts(value.at,zone);return`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;}
export function localInstant(local:string,zone:string):TimeValue {
 if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(local))throw new Error('日時を入力してください。');
 const desired=local.length===16?local+':00':local,base=Date.parse(desired+'Z'),candidates=new Set<string>();
 for(const shift of[-36,0,36]){const probe=base+shift*3600000,p=parts(new Date(probe).toISOString(),zone),offset=Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`)-probe,at=new Date(base-offset).toISOString();const a=parts(at,zone);if(`${a.year}-${a.month}-${a.day}T${a.hour}:${a.minute}:${a.second}`===desired)candidates.add(at);}
 if(candidates.size!==1)throw new Error('このタイムゾーンでは存在しないか重複する時刻です。UTCで明確な時刻を入力してください。');return{kind:'instant',at:[...candidates][0]};
}
