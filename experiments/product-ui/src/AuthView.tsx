import {useEffect,useRef,useState} from 'react';
import {createPairing,validPassword} from './app-auth.mjs';
import {Notice} from './components.tsx';
export function LoginView({auth,onLogin,reason}:{auth:any;onLogin:()=>Promise<void>;reason?:string|null}){
 const [busy,setBusy]=useState(false),[message,setMessage]=useState<string|null>(null),[pending,setPending]=useState(()=>!!auth.loginPending);
 return <section aria-label="Sign in"><h1 tabIndex={-1}>Sign in to Projektor</h1>
  <Notice>{reason==='AUTHORITY_CHANGED'?'Session authority changed. Sign in again to verify access.':'Sign in to continue. Protected drafts stay on this device and reopen only after access is verified.'}</Notice>
  {message&&<Notice error>{message}</Notice>}
  {!pending&&<form onSubmit={async event=>{event.preventDefault();if(busy)return;const field=event.currentTarget.elements.namedItem('password') as HTMLInputElement,password=field.value;field.value='';setBusy(true);setMessage(null);try{await auth.login(password);await onLogin();}catch(error:any){setPending(auth.loginPending);setMessage(auth.loginPending?'Sign-in result is unknown. Check the existing sign-in receipt.':error.code==='AUTH_RATE_LIMITED'?'Too many sign-in attempts. Wait before trying again.':'Sign-in could not be confirmed. Check your password and try again.');}finally{setBusy(false);}}}>
   <label>Password<input name="password" aria-label="Password" type="password" autoComplete="current-password" required disabled={busy}/></label>
   <button disabled={busy} type="submit">{busy?'Signing in…':'Sign in'}</button>
  </form>}
  {pending&&<><button disabled={busy} onClick={async()=>{setBusy(true);try{await auth.loginReceipt();setPending(false);await onLogin();}catch{setMessage('The sign-in receipt is still unavailable. Check again later, or return to normal sign-in.');}finally{setBusy(false);}}}>Check sign-in receipt</button><button disabled={busy} onClick={()=>{auth.discardLogin();setPending(false);setMessage(null);}}>Return to password sign-in</button></>}
  <p>First access or password recovery requires approval from the owner. Keep an editor with unprotected input open while completing setup in another tab.</p>
  <a href="/setup" target="_blank" rel="noopener">Open approved setup or recovery</a>
 </section>;
}
/** Setup owns no account identity. The owner separately binds the public
 * fingerprint to a fixed existing human account and a bounded management grant. */
export function SetupView({auth,onLogin}:{auth:any;onLogin:()=>void}){
 const pair=useRef<any>(null),operation=useRef<string|null>(null);
 const [purpose,setPurpose]=useState('enroll'),[publicPair,setPublicPair]=useState<any>(null),[approval,setApproval]=useState<any>(null),[state,setState]=useState('new'),[busy,setBusy]=useState(false),[message,setMessage]=useState<string|null>(null),[confirmed,setConfirmed]=useState(false);
 useEffect(()=>{const before=(event:BeforeUnloadEvent)=>{if(pair.current&&!['done','consumed'].includes(state)){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',before);return()=>window.removeEventListener('beforeunload',before);},[state]);
 const status=async()=>{
  setBusy(true);setMessage(null);
  try{
   if(operation.current){const receipt=await auth.grantReceipt(pair.current,operation.current);if(receipt.state==='pending'&&receipt.operationId===operation.current){setMessage('No completion receipt is available yet. Keep this tab open and check again; the password submission will not be repeated.');return;}if(receipt.ok!==true||receipt.operationId!==operation.current||receipt.purpose!==pair.current.purpose||receipt.loginRequired!==true||!Number.isSafeInteger(receipt.completedAt))throw Error('RECEIPT_MISMATCH');pair.current=null;setState('done');setMessage('Password setup confirmed. Continue with normal sign-in.');return;}
   const value=await auth.grantStatus(pair.current);
   if(value.state==='approved'&&value.purpose!==pair.current.purpose||value.state==='consumed'&&value.receipt?.purpose!==pair.current.purpose)throw Error('PURPOSE_MISMATCH');
   if(value.grantId&&value.grantId!==pair.current.grantId)throw Error('GRANT_MISMATCH');
   if(value.state==='consumed'){setState('consumed');setApproval(null);pair.current=null;setMessage('This approval has been used. Continue with normal sign-in.');}
   else if(value.state==='approved'&&Number.isSafeInteger(value.expiresAt)&&value.expiresAt>Date.now()){setApproval(value);setState(operation.current?'uncertain':'approved');if(operation.current)setMessage('Completion is still unconfirmed. Check the receipt again; the password submission will not be repeated.');}
   else if(value.state==='unavailable'){setApproval(null);setState('unavailable');setMessage('This approval is unavailable or expired. Return to normal sign-in; ask the owner for a new pairing if setup is still needed.');}
   else{setApproval(null);setState(operation.current?'uncertain':'pending');setMessage('Owner approval is not available yet. Confirm the fingerprint and purpose with the owner.');}
  }catch{setMessage('Approval could not be checked. Keep this tab open and try the receipt check again.');}finally{setBusy(false);}
 };
 const reset=()=>{pair.current=null;operation.current=null;setPublicPair(null);onLogin();};
 return <main className="auth-page"><h1>Approved setup or password recovery</h1><Notice>Only the existing human account can be activated or recovered. The owner must approve this browser’s fingerprint, purpose and target account before a password can be set.</Notice>
  {message&&<Notice error={state==='uncertain'}>{message}</Notice>}
  {!publicPair&&<><label>Purpose<select aria-label="Setup purpose" value={purpose} disabled={busy} onChange={event=>setPurpose(event.target.value)}><option value="enroll">Activate existing account</option><option value="reset">Recover password</option></select></label><button disabled={busy} onClick={async()=>{setBusy(true);setMessage(null);try{const value=await createPairing(purpose);pair.current=value;setPublicPair({grantId:value.grantId,purpose:value.purpose,fingerprint:value.fingerprint});setState('pending');}catch{setMessage('This browser could not create a secure setup request.');}finally{setBusy(false);}}}>Create browser pairing</button></>}
  {publicPair&&<section aria-label="Public pairing details"><p>Request: <span data-pairing-id>{publicPair.grantId}</span></p><p>Purpose: {publicPair.purpose}</p><p>SHA-256 fingerprint: <span data-pairing-fingerprint>{publicPair.fingerprint}</span></p><p>Share these public details with the owner. The private pairing secret stays in this tab and is sent only to this application.</p></section>}
  {pair.current&&<button disabled={busy} onClick={()=>void status()}>{operation.current?'Check setup receipt':'Check owner approval'}</button>}
  {state==='approved'&&approval&&<form onSubmit={async event=>{
   event.preventDefault();if(busy||!confirmed||!pair.current||operation.current)return;
   const fields=event.currentTarget.elements,password=(fields.namedItem('newPassword') as HTMLInputElement).value,confirm=(fields.namedItem('confirmPassword') as HTMLInputElement).value;
   (fields.namedItem('newPassword') as HTMLInputElement).value='';(fields.namedItem('confirmPassword') as HTMLInputElement).value='';
   if(password!==confirm||!validPassword(password)){setMessage('Use matching passwords with at least 15 characters and no more than 1024 UTF-8 bytes.');return;}
   if(approval.expiresAt<=Date.now()){setApproval(null);setState('pending');setMessage('Approval expired. Request a new owner approval.');return;}
   operation.current=crypto.randomUUID();setBusy(true);setMessage(null);
   try{const receipt=await auth.completeGrant(pair.current,password,operation.current);if(receipt.ok!==true||receipt.operationId!==operation.current||receipt.purpose!==pair.current.purpose||receipt.loginRequired!==true||!Number.isSafeInteger(receipt.completedAt))throw Error('RECEIPT_MISMATCH');pair.current=null;setState('done');setMessage('Password setup confirmed. Continue with normal sign-in.');}
   catch(error:any){if(error.code==='PASSWORD_POLICY'){operation.current=null;setState('approved');setMessage('The password did not meet the policy. Enter a different password with at least 15 characters and at most 1024 UTF-8 bytes.');}else{setState('uncertain');setMessage('Setup result is unknown. Check its receipt; do not submit the password again.');}}finally{setBusy(false);}
  }}>
   <p>Approval expires: {new Date(approval.expiresAt).toLocaleString()}</p>
   <label><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/>I confirmed this fingerprint, purpose and existing target account with the owner</label>
   <label>New password<input name="newPassword" aria-label="New password" type="password" autoComplete="new-password" required disabled={busy}/></label>
   <label>Confirm new password<input name="confirmPassword" aria-label="Confirm new password" type="password" autoComplete="new-password" required disabled={busy}/></label>
   <button type="submit" disabled={busy||!confirmed}>Set password once</button>
  </form>}
  <p><button disabled={busy} onClick={reset}>{['done','consumed'].includes(state)?'Continue to sign in':'Discard this pairing and return to sign in'}</button></p>
 </main>;
}
