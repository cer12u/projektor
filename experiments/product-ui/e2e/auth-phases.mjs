// Fixed future diagnostics only. Never pass user data or error details to output.
export const PREFIX='@@PROJEKTOR_AUTH_PHASE ';
export const IDS=Object.freeze(['H01','H02','H03']);
export const STATES=Object.freeze(['start','pass','fail','timeout']);
export const WITNESS_PHASES=Object.freeze([
 'witness_peer_signal_seen','witness_peer_signal_missing','witness_peer_signal_unknown','witness_visible','witness_hidden','witness_visibility_unknown',
 ...['auth','bootstrap','session','key','issue'].flatMap(kind=>['witness_'+kind+'_request_seen','witness_'+kind+'_request_missing','witness_'+kind+'_read_seen','witness_'+kind+'_read_missing']),
 ...['login','loading','connection_error','locked','ready','unknown'].map(kind=>'witness_root_'+kind),
 ...['draft_conflict','protection_failed','scope_expansion','identity_changed','key_session_changed','key_lease_invalid','key_lease_expired','lease_expired','checking_session','hidden','session_changed','auth_required','verify_bootstrap','draft_binding_mismatch','draft_invalid','forbidden','not_found','protocol_error','cancelled','stale_context','storage_unavailable','session_tombstoned','verify_session','other_locked','unavailable','visible','unknown'].map(kind=>'witness_editor_'+kind),
]);
export function firstTabWitnessPhases(value={}){
 const pick=(prefix,name,fallback)=>WITNESS_PHASES.includes(prefix+name)?prefix+name:prefix+fallback;
 return ['witness_peer_signal_'+(value.peerSignal===true?'seen':value.peerSignal===false?'missing':'unknown'),pick('witness_',value.visibility,'visibility_unknown'),...['auth','bootstrap','session','key','issue'].flatMap(kind=>['witness_'+kind+'_request_'+(value.requests?.[kind]===true?'seen':'missing'),'witness_'+kind+'_read_'+(value.reads?.[kind]===true?'seen':'missing')]),pick('witness_root_',value.root,'unknown'),pick('witness_editor_',value.editor,'unknown')];
}
export const PHASES=Object.freeze(['fixture_start','setup_open','pair_create','pair_approve','password_submit','receipt_confirm','signin','issue_open','issue_save','draft_protect','reload_restore','newtab_restore','newfamily_signin','firsttab_restore','firsttab_focus','firsttab_editor','firsttab_assert','firsttab_close','automatic_refresh','logout_restore','storage_audit','absolute_expire','absolute_restore','revoke_lock','storage_failure','logout_blocked','storage_restore','repeat_401','cleanup',...WITNESS_PHASES]);
export function authPhaseRecord(id,phase,state){
 if(!IDS.includes(id)||!PHASES.includes(phase)||!STATES.includes(state))throw Error('INVALID_AUTH_PHASE');
 return PREFIX+JSON.stringify({id,phase,state})+'\n';
}
export async function authPhase(id,phase,run,timeoutMs=20000){
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw Error('INVALID_AUTH_PHASE_TIMEOUT');
 process.stdout.write(authPhaseRecord(id,phase,'start'));let timer,timedOut=false;
 try{const value=await Promise.race([Promise.resolve().then(run),new Promise((_,reject)=>{timer=setTimeout(()=>{timedOut=true;process.stdout.write(authPhaseRecord(id,phase,'timeout'));const error=new Error('AUTH_PHASE_TIMEOUT');error.name='TimeoutError';reject(error);},timeoutMs);})]);process.stdout.write(authPhaseRecord(id,phase,'pass'));return value;}
 catch(error){if(!timedOut)process.stdout.write(authPhaseRecord(id,phase,'fail'));throw error;}
 finally{clearTimeout(timer);}
}
// Stable aliases for the publication reporter's initial integration.
export {PREFIX as AUTH_PHASE_PREFIX,IDS as AUTH_PHASE_CASES,PHASES as AUTH_PHASES,STATES as AUTH_PHASE_STATES};
