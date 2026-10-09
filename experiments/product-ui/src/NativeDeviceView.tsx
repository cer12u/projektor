import {useCallback,useEffect,useRef,useState} from 'react';
import {Notice} from './components.tsx';
import {actionEvidence,approvalDuration,calendarExpiry,checkReviewedAction,deviceApprovalInput,loadDeviceState,readPublicProposal} from './native-device.mjs';

type Action={kind:'pairing/approve'|'device/enable'|'device/revoke'|'revoke';input:any;principalId:string;scopes:string[];fingerprint?:string};
const errorText=(code:string)=>({
 PUBLIC_PROPOSAL_REQUIRED:'Paste only the public pairing proposal. Tokens, private secrets and extra fields are not accepted.',
 PROPOSAL_TARGET_MISMATCH:'This proposal targets a different application or machine principal.',
 PROPOSAL_SCOPE_UNAVAILABLE:'The requested scopes are not available for this machine principal.',
 PROPOSAL_EXPIRED:'The proposal has expired or exceeds the configured pairing duration.',
 PROPOSAL_GENERATION_CHANGED:'Pairing approvals changed. Ask the device for a current public proposal.',
 NATIVE_PAIRING_GENERATION_CHANGED:'Pairing approvals changed. Reload and review a current proposal.',
 DEVICE_APPROVAL_VERSION_CHANGED:'This device approval changed. Reload and review its current settings.',
 DEVICE_DURATION_INVALID:'Choose a future end date or a positive idle duration, or explicitly select until revoked.',
 DEVICE_UNAVAILABLE:'This device is unavailable or revoked.',
 DEVICE_METADATA_INVALID:'Device metadata could not be verified. Reload before approving changes.',
 NATIVE_MACHINE_OWNER_REQUIRED:'Only the authenticated owner can manage machine devices.',
 DEVICE_OWNER_REQUIRED:'Only the authenticated owner can manage machine devices.',
 NATIVE_MACHINE_CONFIG_INVALID:'Machine device management is not configured for this application.',
 DEVICE_SESSION_CONFIG_INVALID:'Device session management is not configured for this application.',
} as Record<string,string>)[code]??'The action could not be confirmed. Check current devices before taking another action.';

export function NativeDeviceView({auth,locked,accessRevision,accessReady}:{auth:any;locked:boolean;accessRevision:number;accessReady:()=>void}){
 const [data,setData]=useState<any>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState<string|null>(null),[failed,setFailed]=useState(false),[review,setReview]=useState<Action|null>(null),[confirmed,setConfirmed]=useState(false),[editing,setEditing]=useState<string|null>(null),[mode,setMode]=useState('expires');
 const flight=useRef(false),generation=useRef(0),pending=useRef<Action|null>(null),alive=useRef(true);
 useEffect(()=>()=>{alive.current=false;generation.current++;},[]);
 const read=useCallback(async(signal?:AbortSignal)=>{
  const ticket=generation.current,value=await loadDeviceState(auth,{signal});if(signal?.aborted||!alive.current||ticket!==generation.current)return null;
  setData(value);accessReady();return value;
 },[auth,accessReady]);
 useEffect(()=>{
  const abort=new AbortController(),ticket=++generation.current;setData(null);setReview(null);setConfirmed(false);setEditing(null);
  if(!locked){setBusy(true);void read(abort.signal).then(value=>{if(value&&ticket===generation.current){setFailed(false);setMessage(pending.current?actionEvidence(pending.current,value)??'A previous action is still unconfirmed. Only the current recorded state is shown.':null);if(pending.current&&actionEvidence(pending.current,value))pending.current=null;}}).catch(error=>{if(!abort.signal.aborted&&ticket===generation.current){setFailed(true);setMessage(errorText(error.code));}}).finally(()=>{if(ticket===generation.current)setBusy(false);});}
  return()=>abort.abort();
 },[locked,accessRevision,read]);
 const refresh=async()=>{
  if(flight.current||locked)return;flight.current=true;setBusy(true);setMessage(null);const ticket=generation.current;
  try{const value=await read();if(value&&ticket===generation.current){const evidence=actionEvidence(pending.current,value);setMessage(evidence??(pending.current?'The previous action is not confirmed by current metadata. Nothing was resubmitted.':null));setFailed(false);if(evidence)pending.current=null;setReview(null);setConfirmed(false);}}
  catch(error:any){if(ticket===generation.current){setFailed(true);setData(null);setMessage(errorText(error.code));}}
  finally{flight.current=false;if(alive.current&&ticket===generation.current)setBusy(false);}
 };
 const prepare=(action:Action)=>{setReview(action);setConfirmed(false);setMessage(null);setEditing(null);};
 const submit=async()=>{
  if(!review||!confirmed||busy||locked||flight.current||pending.current)return;
  const action=review,ticket=generation.current;flight.current=true;pending.current=action;setBusy(true);setMessage(null);setConfirmed(false);
  try{
   const input=checkReviewedAction(action,data,window.location.origin);
   await auth.nativeOwner(action.kind,input);
   const value=await read();if(ticket!==generation.current||!value)return;
   const evidence=actionEvidence(action,value);setMessage(evidence??'The response arrived, but the current recorded state does not confirm this action. Check current devices.');setFailed(!evidence);if(evidence){pending.current=null;setReview(null);}
  }catch(error:any){if(ticket===generation.current){setFailed(true);setData(null);setMessage(errorText(error.code));setReview(null);if(['PROPOSAL_TARGET_MISMATCH','PROPOSAL_EXPIRED','PROPOSAL_GENERATION_CHANGED','DEVICE_UNAVAILABLE','DEVICE_DURATION_INVALID','NATIVE_MACHINE_INPUT_INVALID','NATIVE_MACHINE_SCOPE_DENIED','NATIVE_MACHINE_EXPIRY_INVALID','NATIVE_PAIRING_GENERATION_CHANGED','NATIVE_MACHINE_OPERATION_REUSED','DEVICE_APPROVAL_INPUT_INVALID','DEVICE_APPROVAL_VERSION_CHANGED','DEVICE_APPROVAL_OPERATION_REUSED','NATIVE_MACHINE_OWNER_REQUIRED','DEVICE_OWNER_REQUIRED'].includes(error.code))pending.current=null;}}
  finally{flight.current=false;if(alive.current&&ticket===generation.current)setBusy(false);}
 };
 if(locked)return <Notice>Machine device controls are locked until owner access is verified</Notice>;
 const blocked=busy||!!pending.current;
 return <section className="native-devices" aria-busy={busy}><div className="heading"><h1 tabIndex={-1}>Machine devices</h1><button disabled={busy} onClick={()=>void refresh()}>Check current devices</button></div>
  <p>Owner controls for {window.location.origin}. Pairing approval and longer device access are separate, explicit actions.</p>
  {message&&<Notice error={failed}>{message}</Notice>}
  {busy&&!data&&<Notice>Checking owner access and current device approvals…</Notice>}
  {pending.current&&!busy&&<Notice>The last action will not be submitted again automatically. Check its recorded state before making another change.{data&&<button onClick={()=>{const action=pending.current;pending.current=null;if(action)prepare(action);}}>Review the same action again</button>}</Notice>}
  {data&&<>
   <p>Fixed machine principal: <span className="public-id">{data.principalId}</span></p>
   <section aria-label="Approve a pairing"><h2>Approve a device pairing</h2>
    <p>Paste the public proposal from the device. Never paste a bearer token or private pairing secret.</p>
    <form onSubmit={event=>{event.preventDefault();if(blocked)return;const field=event.currentTarget.elements.namedItem('proposal') as HTMLTextAreaElement;try{const input=readPublicProposal(field.value,data,window.location.origin);field.value='';prepare({kind:'pairing/approve',input,principalId:data.principalId,scopes:input.scopes,fingerprint:input.secretDigest});}catch(error:any){field.value='';setFailed(true);setMessage(errorText(error.code));}}}>
     <label>Public pairing proposal<textarea name="proposal" aria-label="Public pairing proposal" rows={7} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} disabled={blocked}/></label>
     <button type="submit" disabled={blocked}>Review pairing approval</button>
    </form>
   </section>
   {review&&<section aria-label="Review owner action" className="owner-review"><h2>{review.kind==='pairing/approve'?'Review pairing approval':review.kind==='device/enable'?'Review device access':'Review revocation'}</h2>
    <p>Application: {window.location.origin}</p><p>Machine principal: <span className="public-id">{review.principalId}</span></p><p>Credential: <span className="public-id">{review.input.credentialId}</span></p>
    <p>Scopes: {review.scopes.join(', ')}</p><p>SHA-256 fingerprint: {review.fingerprint?<span className="public-id">{review.fingerprint}</span>:'Not recorded for this earlier credential'}</p>
    {review.kind==='pairing/approve'&&<><p>Credential ends: {calendarExpiry(review.input.expiresAt)}</p><p>Device must complete pairing by: {calendarExpiry(review.input.redeemExpiresAt)}</p><Notice>Approving this request replaces any earlier unredeemed pairing approval. The device keeps its private secret.</Notice></>}
    {review.kind==='device/enable'&&<><p>{approvalDuration(review.input)}</p><Notice>This approval may extend device access beyond its pairing expiry. Scopes and the fixed machine principal stay as shown above.</Notice></>}
    {['revoke','device/revoke'].includes(review.kind)&&<Notice>Revocation stops this credential or pending pairing. Restoring access requires a new approval.</Notice>}
    <label className="owner-confirm"><input type="checkbox" checked={confirmed} disabled={blocked} onChange={event=>setConfirmed(event.target.checked)}/>{review.kind==='device/enable'&&review.input.untilRevoked?'I approve this device until I revoke it':'I approve this exact principal, scopes and action'}</label>
    <div className="actions"><button disabled={blocked||!confirmed} onClick={()=>void submit()}>{review.kind==='pairing/approve'?'Approve pairing':review.kind==='device/enable'?'Apply device approval':'Revoke access'}</button><button disabled={busy} onClick={()=>{setReview(null);setConfirmed(false);}}>Cancel review</button></div>
   </section>}
   <section aria-label="Pairing requests"><h2>Pairing requests</h2>{data.pairingGrants.length===0?<p>No pairing requests recorded</p>:data.pairingGrants.map((grant:any)=><article className="device-card" key={grant.grantId}><h3>{grant.revoked?'Revoked pairing':grant.consumed?'Pairing completed':'Awaiting device pairing'}</h3><p>Credential: <span className="public-id">{grant.credentialId}</span></p><p>SHA-256 fingerprint: <span className="public-id">{grant.fingerprint}</span></p><p>Scopes: {grant.scopes.join(', ')}</p><p>Initial pairing expiry: {calendarExpiry(grant.expiresAt)}</p><p>Pair by: {calendarExpiry(grant.redeemExpiresAt)}</p>{!grant.revoked&&!grant.consumed&&<button disabled={blocked} onClick={()=>prepare({kind:'revoke',input:{credentialId:grant.credentialId},principalId:data.principalId,scopes:grant.scopes,fingerprint:grant.fingerprint})}>Review pairing revocation</button>}</article>)}</section>
   <section aria-label="Current devices"><h2>Current devices</h2>{data.credentials.length===0?<p>No machine credentials recorded</p>:data.credentials.map((credential:any)=>{
    const device=data.devices.find((value:any)=>value.credentialId===credential.credentialId),grant=data.pairingGrants.find((value:any)=>value.credentialId===credential.credentialId),revoked=credential.revoked||device?.revoked;
    return <article className="device-card" key={credential.credentialId}><h3>{revoked?'Revoked device':device?'Approved device':'Paired credential'}</h3><p>Credential: <span className="public-id">{credential.credentialId}</span></p><p>Scopes: {credential.scopes.join(', ')}</p>{grant&&<p>SHA-256 fingerprint: <span className="public-id">{grant.fingerprint}</span></p>}<p>{device?approvalDuration(device):'Pairing credential ends: '+calendarExpiry(credential.expiresAt)}</p>{device&&<p>Approval version: {device.version} · Last refresh: {calendarExpiry(device.lastRefreshAt)}</p>}
     {!revoked&&<div className="actions"><button disabled={blocked} onClick={()=>{setEditing(credential.credentialId);setMode('expires');setReview(null);setConfirmed(false);}}>Review device duration</button><button disabled={blocked} onClick={()=>prepare({kind:device?'device/revoke':'revoke',input:{credentialId:credential.credentialId},principalId:data.principalId,scopes:credential.scopes,fingerprint:grant?.fingerprint})}>Review device revocation</button></div>}
     {editing===credential.credentialId&&<form onSubmit={event=>{event.preventDefault();if(blocked)return;const fields=event.currentTarget.elements;try{const input=deviceApprovalInput(data,credential.credentialId,{mode,idleMinutes:(fields.namedItem('idleMinutes') as HTMLInputElement)?.value??'',absoluteDate:(fields.namedItem('absoluteDate') as HTMLInputElement)?.value??''});prepare({kind:'device/enable',input,principalId:data.principalId,scopes:credential.scopes,fingerprint:grant?.fingerprint});}catch(error:any){setFailed(true);setMessage(errorText(error.code));}}}>
      <label>Access duration<select aria-label="Access duration" value={mode} onChange={event=>setMode(event.target.value)} disabled={blocked}><option value="expires">Choose an end date</option><option value="idle">End after an idle period</option><option value="until-revoked">Until I revoke this device</option></select></label>
      {mode==='expires'&&<label>Approval end date (your device’s time zone)<input name="absoluteDate" aria-label="Approval end date" type="datetime-local" required disabled={blocked}/></label>}
      {mode!=='until-revoked'&&<label>Idle limit in minutes {mode==='expires'?'(optional)':''}<input name="idleMinutes" aria-label="Idle limit in minutes" type="number" min="0.02" step="any" inputMode="decimal" required={mode==='idle'} disabled={blocked}/></label>}
      {mode==='until-revoked'&&<Notice>No idle or fixed expiry will apply. A separate explicit approval is required on the next screen.</Notice>}
      <button type="submit" disabled={blocked}>Review exact device approval</button>
     </form>}
    </article>;
   })}</section>
  </>}
 </section>;
}
