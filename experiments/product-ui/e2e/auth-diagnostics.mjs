// Future synthetic browser diagnostics only. Raw output, error messages,
// assertions, cookies, passwords, response bodies and unknown names are dropped.
import {appendFileSync} from 'node:fs';
import {failureCategory} from './github-reporter.mjs';
import {AUTH_PHASE_PREFIX,AUTH_PHASE_CASES,AUTH_PHASE_STATES,AUTH_PHASES} from './auth-phases.mjs';
export const CASES=Object.freeze({
 human:[
  'enroll → password login → Issue record → reload/new tab → refresh → sign out/login keeps protected draft',
  'lost enrollment response stays receipt-only and expired authority requests login without draft loss',
  'latest unprotected input blocks sign-out; repeated 401 does not loop refresh or resend',
 ],
 owner:['320px owner approves a public pairing, explicitly enables until revoked, and revokes the same device'],
});
function location(data){
 // Use runner-owned source metadata only. Never parse error messages/stacks,
 // whose text may contain credentials or a location-shaped assertion value.
 const match=typeof data.file==='string'&&data.file.match(/(?:^|\/)(e2e\/(?:app-auth|native-device)\.test\.mjs)$/);
 const bounded=value=>Number.isSafeInteger(value)&&value>0&&value<=9999999;
 return match&&bounded(data.line)&&bounded(data.column)?{file:'experiments/product-ui/'+match[1],line:data.line,column:data.column}:null;
}
export default async function* reporter(source){
 const group=process.env.PROJEKTOR_AUTH_CASES,expected=CASES[group];
 if(!expected)throw Error('INVALID_AUTH_BROWSER_SELECTION');
 const results=new Map(),lastPhase=new Map(),failedPhase=new Map();let runnerFailed=false,phaseBuffer='';const summaries=[];
 yield 'TAP version 13\n';
 for await(const event of source){
  if(event.type==='test:stdout'){
   phaseBuffer+=typeof event.data?.message==='string'?event.data.message:'';
   if(phaseBuffer.length>32768)phaseBuffer=phaseBuffer.slice(-32768);
   for(;;){
    const end=phaseBuffer.indexOf('\n');if(end<0)break;
    const line=phaseBuffer.slice(0,end);phaseBuffer=phaseBuffer.slice(end+1);
    if(!line.startsWith(AUTH_PHASE_PREFIX))continue;
    let value;try{value=JSON.parse(line.slice(AUTH_PHASE_PREFIX.length));}catch{continue;}
    if(group!=='human'||!value||Object.keys(value).sort().join(',')!=='id,phase,state'||!AUTH_PHASE_CASES.includes(value.id)||!AUTH_PHASES.includes(value.phase)||!AUTH_PHASE_STATES.includes(value.state))continue;
    lastPhase.set(value.id,value.phase);
    if(['fail','timeout'].includes(value.state)&&!failedPhase.has(value.id))failedPhase.set(value.id,value.phase);
   }
   continue;
  }
  if(event.type!=='test:pass'&&event.type!=='test:fail')continue;
  const data=event.data??{},index=expected.indexOf(data.name),known=index!==-1;
  const id=known?(group==='human'?'H':'O')+String(index+1).padStart(2,'0'):'RUNNER';
  const {errorClass,failureType}=failureCategory(data.details?.error);
  const cancelled=failureType==='cancelledByParent';
  const state=data.skip?'skipped':data.todo?'todo':event.type==='test:fail'?(cancelled?'cancelled':'failed'):'passed';
  if(known){if(!results.has(index)||results.get(index)==='passed')results.set(index,state);}
  else runnerFailed=true;
  if(event.type==='test:fail'){
   const at=location(data),where=at?`${at.file}:${at.line}:${at.column}`:'unavailable';
   const phase=failedPhase.get(id)??lastPhase.get(id)??'unavailable';
   const diagnostic=`Auth browser ${id}: phase=${phase}; category=${errorClass}/${failureType}; location=${where}`;
   summaries.push(diagnostic);
   if(process.env.GITHUB_ACTIONS==='true')yield `::error ${at?`file=${at.file},line=${at.line},col=${at.column},`:''}title=Auth browser ${id}::${diagnostic}\n`;
   yield '# '+diagnostic+'\n';
  }
 }
 for(const [index,state] of [...results].sort((a,b)=>a[0]-b[0]))yield `${state==='passed'?'ok':'not ok'} ${index+1} - ${group==='human'?'H':'O'}${String(index+1).padStart(2,'0')}${state==='skipped'?' # SKIP':state==='todo'?' # TODO':''}\n`;
 const count=state=>[...results.values()].filter(value=>value===state).length;
 const values={tests:results.size,pass:count('passed'),fail:count('failed'),cancelled:count('cancelled'),skipped:count('skipped'),todo:count('todo'),incomplete:expected.length-results.size,runner_failed:runnerFailed};
 yield `1..${results.size}\n`;
 for(const [name,value] of Object.entries(values))yield `# ${name} ${value}\n`;
 const summary=`Auth browser ${group}: expected=${expected.length} passed=${values.pass} failed=${values.fail} cancelled=${values.cancelled} skipped=${values.skipped} todo=${values.todo} incomplete=${values.incomplete} runner_failed=${runnerFailed}`;
 yield '# '+summary+'\n';
 if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,[summary,...summaries].join('\n\n')+'\n');
}
