// Fixed future diagnostics only. Never pass user data or error details to output.
export const PREFIX='@@PROJEKTOR_AUTH_PHASE ';
export const IDS=Object.freeze(['H01','H02','H03']);
export const STATES=Object.freeze(['start','pass','fail','timeout']);
export const PHASES=Object.freeze(['fixture_start','setup_open','pair_create','pair_approve','password_submit','receipt_confirm','signin','issue_open','issue_save','draft_protect','reload_restore','newtab_restore','newfamily_signin','firsttab_restore','automatic_refresh','logout_restore','storage_audit','absolute_expire','absolute_restore','revoke_lock','storage_failure','logout_blocked','storage_restore','repeat_401','cleanup']);
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
