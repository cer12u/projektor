import {useEffect,useState} from 'react';
import type {IssueCompatibility,IssueCompatibilitySummary} from './contracts.ts';
export function Notice({children,error=false}:{children:React.ReactNode;error?:boolean}){return <p className={error?'notice error':'notice'} role={error?'alert':'status'}>{children}</p>;}
export function ConnectionNotice({fixture}:{fixture:boolean}){return fixture?<aside className="fixture" role="note">Contract fixture only · Product connection incomplete. Synthetic data and fixture key service; no production authentication claim.</aside>:null;}
export const states=['backlog','ready','in_progress','blocked','done','canceled'];
export function listMessage(s:any):string{
  if(s.locked)return 'List locked · '+s.code;
  if(s.phase==='loading')return 'Loading your issues…';
  if(s.phase==='empty')return 'No issues match this filter';
  if(s.phase==='error')return 'Could not load issues · '+s.code;
  if(s.phase==='stale')return 'Issues or access changed. Refresh required';
  if(s.phase==='partial')return `${s.items.length} of ${s.total} loaded · ${s.code?'Next page failed · '+s.code:'More issues available'}`;
  return `${s.total??0} issues loaded`;
}
export function IssueRows({state,board,onOpen}:{state:any;board:boolean;onOpen:(id:string)=>void}){
  if(state.locked||['loading','error','stale'].includes(state.phase))return null;
  const rows=(items:any[])=>items.map(item=><li key={item.id}><button className="issue-link" data-focus-key={"issue-"+item.id} onClick={()=>onOpen(item.id)}>{item.title}</button><p className="meta">{item.priority===null?'No priority':'P'+item.priority} · {item.compatibility?compatibilityStatus(item.compatibility):item.status_category.replaceAll('_',' ')}{item.compatibility?.typeName?' · Type: '+item.compatibility.typeName:''} · {item.assignee_kind==='machine'?'Agent':'Human'}</p></li>);
  return board?<div className="board" aria-label="My issues board">{states.map(status=><section key={status} aria-label={status.replaceAll('_',' ')}><h2>{status.replaceAll('_',' ')}</h2><ul>{rows(state.items.filter((i:any)=>i.status_category===status))}</ul></section>)}</div>:<ul className="issue-list">{rows(state.items)}</ul>;
}
export function compatibilityStatus(value:IssueCompatibilitySummary):string{
  return (value.statusName??value.statusKey??'Unknown status')+(value.isReviewStep?' · Review step':'');
}
export function IssueCompatibilityDetails({value}:{value:IssueCompatibility}){
  const dor=value.dor;
  return <section aria-label="Imported issue state">
    <p className="meta">Status: {compatibilityStatus(value)} · Type: {value.typeName??'Unknown'}</p>
    <p>Completion report time: {value.completionReportAt??'Not recorded'}</p>
    <p>Recorded DoR readiness: {dor.ready===null?'Unknown':dor.ready?'Ready':'Not ready'}</p>
    <p>{dor.evidenceState==='stale_after_edit'?'DoR evidence is stale after a body edit. Readiness has not been re-evaluated.':'DoR evidence is retained for the current body; no new evaluation has been run.'}</p>
    {dor.missing!==null?<><p>Recorded missing DoR items: {dor.missing.length===0?'None recorded':''}</p>{dor.missing.length>0&&<ul>{dor.missing.map((item,index)=><li key={index}>{typeof item==='string'?item:JSON.stringify(item)}</li>)}</ul>}</>:<p>Recorded missing DoR items: Unknown</p>}
    {dor.missingRaw!==null&&<details><summary>Recorded DoR evidence</summary><pre>{dor.missingRaw}</pre></details>}
    <p className="meta">Workflow status and recorded DoR are separate. A Ready queue label does not certify DoR readiness.</p>
  </section>;
}
export function Author({value}:{value:any}){
  const sourceName=typeof value?.sourceDisplayNameRaw==='string'?value.sourceDisplayNameRaw:null;
  const label=sourceName!==null?(sourceName||'Unnamed source author'):value?.displayName??value?.principalId??value?.sourceAuthorId??'Unknown author';
  const resolution=['linked','unlinked','deleted','unknown'].includes(value?.resolution)?value.resolution:'unknown';
  return <span>{label}{sourceName!==null&&value?.sourceAuthorId?' · Source ID '+value.sourceAuthorId:''} · {resolution}{value?.actorKind==='machine'||value?.kind==='machine'?' · Agent':''}</span>;
}
export function EntryList({entries,onEdit}:{entries:any[];onEdit:(id:string)=>void}){
  return <ul>{entries.map(e=><li key={e.id}><p>{e.kind} · Original author <Author value={e.authorRef}/> · v{e.version} · {e.createdAt==null?'Time unknown':'Original time '+String(e.createdAt)}</p>{e.bodyMarkdown!==undefined&&<pre>{e.bodyMarkdown}</pre>}{e.workflow&&<pre>{JSON.stringify(e.workflow,null,2)}</pre>}{e.kind==='comment'&&<button onClick={()=>onEdit(e.id)}>Edit comment</button>}</li>)}</ul>;
}
export function History({state}:{state:any}){
  return <><p className="meta">Only authorized retained revisions are shown. Completeness and missing historical revisions are not established by this list.</p>{state.historyCode&&<Notice error>History unavailable · {state.historyCode}</Notice>}{state.history.map((r:any)=><details key={r.id}><summary>{r.contentKind} · v{r.resourceVersionAtCommit} · Original author <Author value={r.originalAuthorRef}/> · {r.occurredAtRaw??'Time unknown'}</summary><p className="meta">Time quality: {['exact','estimated','unknown'].includes(r.timeQuality)?r.timeQuality:'unknown'} · Origin: {r.origin??'unknown'}{r.sourceEditedAtRaw!=null?' · Source edited time: '+r.sourceEditedAtRaw:''}{r.recordedBy!=null?' · Recorded by: '+r.recordedBy:''}{r.recordedAt!=null?' · Recorded time: '+r.recordedAt:''}</p><pre>{r.contentMarkdown}</pre></details>)}</>;
}
export function editorMessage(s:any):string{
  if(s.locked)return 'Editor locked · '+s.code;
  if(s.phase==='committed')return s.record?.journal?.effectApplied===false?'No change needed. Current data checked':'Saved snapshot confirmed. Newer input, if any, remains a draft';
  if(s.phase==='conflict')return 'Version conflict. Your draft is retained; compare before using the current version';
  if(s.phase==='refresh-required')return 'Save confirmed; current data refresh failed';
  if(['unknown','ambiguous'].includes(s.phase))return 'Save outcome unknown. Check the existing operation';
  if(s.phase==='rejected')return 'Save rejected · '+s.code+' · Your draft is retained';
  return (s.busy?'Checking…':s.phase==='editing'?'Unsaved changes':'Ready')+' · '+s.protection+(s.code?' · '+s.code:'');
}
export function Expiry({expiresAt}:{expiresAt:number}){const[now,setNow]=useState(Date.now());useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),10000);return()=>clearInterval(t);},[]);return expiresAt-now<=60000?<Notice>Session expires soon. Input protection and product renewal must be verified before leaving this page</Notice>:null;}
export function actionResultText(result:any):string|null{
  if(result?.kind==='budget-exhausted')return 'Automatic resend budget exhausted. Use Check existing operation for a receipt-only lookup';
  if(result?.kind==='manual-budget-exhausted')return 'Manual receipt-check limit reached. Wait before checking again; no resend was performed';
  if(result?.kind==='retry-floor')return 'Retry must wait for the backoff window. No new operation was sent';
  if(result?.kind==='protection-failed')return 'Latest revision protection failed. Keep this page open and check the existing operation before retrying';
  if(result?.kind==='pending')return 'An earlier save is unresolved. Check that operation before creating another';
  if(result?.kind==='stopped')return 'Action stopped. Verify current access; your draft has not been discarded';
  return null;
}
