// Test-only allowlisted diagnostics. No error/body/header/URL is emitted.
export const CASES=[
  "zero and multi bootstrap send no workspace-scoped query before valid selection",
  "create, detail, comment, priority and shared list/board keyboard routes",
  "protected latest text survives reload and old commit acknowledgement cannot erase newer input",
  "principal change and resource revocation never restore former plaintext",
  "320px layout has no document overflow and controls have names",
  "human done/reopen and unassignment agree with the board query",
  "storage failure blocks internal navigation and keeps the latest in-memory text",
  "IME Enter never triggers an implicit save",
  "delayed project titles cannot reappear after same-principal grant revocation and resume",
  "canceling workspace selection preserves route, latest draft and keyboard focus",
  "temporary missing membership keeps unpersisted input locked in memory until exact access revalidation",
  "native Back is canceled when protection fails, then Back/Forward restores the same protected draft"
];
export const PHASES=['suite_import','fixture_build','browser_launch','fixture_start','context_open','fixture_login','fixture_seed','page_open','scenario_body','create_navigate','create_project','create_fields','create_save','create_open','gate_command','gate_projects','context_close','fixture_close','browser_close','draft_protect','draft_reload','draft_verify','late_send','late_edit','late_verify','revoke_access','revoke_lock','other_identity','other_identity_verify','storage_fault','membership_remove','membership_locked','membership_restore','membership_verify'];
export const STATES=['start','pass','fail','timeout'];
export const PREFIX='@@PROJEKTOR_UI_PHASE ';
export function caseID(name){const i=CASES.indexOf(name);return i<0?'S00':'C'+String(i+1).padStart(2,'0');}
export function trace(id,phase,state){
  if(!/^C(?:0[1-9]|1[0-2])$|^S00$/.test(id)||!PHASES.includes(phase)||!STATES.includes(state))throw Error('INVALID_TEST_DIAGNOSTIC');
  process.stdout.write(PREFIX+JSON.stringify({id,phase,state})+'\n');
}
export async function phase(t,name,run,timeoutMs=15000){
  const id=caseID(t?.name);let timer,timedOut=false;trace(id,name,'start');
  try{
    const value=await Promise.race([Promise.resolve().then(run),new Promise((_,reject)=>{timer=setTimeout(()=>{timedOut=true;trace(id,name,'timeout');reject(Error('UI_TEST_PHASE_TIMEOUT '+id+' '+name));},timeoutMs);})]);
    trace(id,name,'pass');return value;
  }catch(error){if(!timedOut)trace(id,name,'fail');throw error;}
  finally{clearTimeout(timer);}
}
/** Resource acquisition may complete after its deadline. Such a late value is
 * never handed to the ended scenario; its own bounded cleanup is still run. */
export async function resourcePhase(t,name,create,cleanupName,cleanup,timeoutMs=15000){
  let settled=false;
  const pending=Promise.resolve().then(create).then(async value=>{
    if(settled||t?.signal?.aborted){
      await phase(t,cleanupName,()=>cleanup(value),10000);
      throw Error('UI_TEST_LATE_RESOURCE_CLOSED '+caseID(t?.name)+' '+name);
    }
    return value;
  });
  try{return await phase(t,name,()=>pending,timeoutMs);}
  finally{settled=true;}
}
