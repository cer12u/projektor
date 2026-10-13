// @module verification
// @role execution-contract
// Spec defects: accidental provider dependency, invalid command dispatch, fabricated nonapplication, and hidden retries.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
const dir=resolve('.local/evidence/execution-contract');await mkdir(dir,{recursive:true});
const built=await build({stdin:{contents:`export * from './src/modules/execution/public';export {createExecution} from './src/modules/execution/application';export {recoveryBranch,observeExecutionAttempt,planExecution,planReport,EXECUTION_LEASE_SECONDS,EXECUTION_RENEW_SECONDS} from './src/modules/execution/rules';export {InputError} from './src/modules/change-outcomes';`,resolveDir:process.cwd()},outfile:dir+'/pure.mjs',bundle:true,platform:'browser',format:'esm',metafile:true});
const m=await import(dir+'/pure.mjs?'+Date.now()),checks=[];
const test=async(name,fn)=>{await fn();checks.push({name,passed:true});};
const query={projectId:'P',issueId:'I_'+'1'.repeat(64)},attemptId='A_'+'2'.repeat(64);
await test('live reports require the submitted lease version and reject stale planning',()=>{
 for(const action of ['progress','failed','completed']){
  const base={operationId:'versioned-'+action,attemptId,message:'result',...(action==='failed'?{failureReason:'failure'}:{})};
  assert.throws(()=>m.decodeReportCommand(query,action,base),m.InputError,'missing version must not be upgraded to the current lease');
  for(const leaseVersion of [0,-1,1.5,Number.MAX_SAFE_INTEGER])assert.throws(()=>m.decodeReportCommand(query,action,{...base,leaseVersion}),m.InputError);
  const command=m.decodeReportCommand(query,action,{...base,leaseVersion:1});
  const head={attemptId,principalId:'A',leaseVersion:2,storedState:'running',expiresAt:400,updatedAt:160};
  const state={actorId:'A',observedAt:200,assignedToActor:true,head,finalReportExists:false,latestConfirmation:null};
  assert.equal(m.planReport(command,state).reason,'live_attempt_conflict');
  const current=m.decodeReportCommand(query,action,{...base,leaseVersion:2});
  assert.equal(m.planReport(current,state).plan.expectedHead.leaseVersion,2);
 }
});
await test('application and rules have no D1, SQL, provider, Node or clock implementation dependency',()=>{
 const files=Object.keys(built.metafile.inputs);assert(files.every(f=>!(/node_modules|\/identity\/|\/operations\/|platform\/d1|issue-execution|execution-reports|\/execution\/d1|\/execution\/assembly/.test(f))));
});
await test('closed inputs normalize once without admitting actor or lease substitution',()=>{
 assert.deepEqual(m.decodeExecutionCommand(query,'acquire',{operationId:'start'}),{...query,action:'acquire',input:{operationId:'start'}});
 for(const value of [{operationId:'x',principalId:'other'},{operationId:'x',attemptId},{operationId:'x',leaseVersion:1}])assert.throws(()=>m.decodeExecutionCommand(query,'acquire',value),m.InputError);
 for(const version of [0,-1,1.2,Number.MAX_SAFE_INTEGER])assert.throws(()=>m.decodeExecutionCommand(query,'renew',{operationId:'x',attemptId,leaseVersion:version}),m.InputError);
 const report=m.decodeReportCommand(query,'progress',{operationId:'p',attemptId,leaseVersion:1,message:' original '});assert.deepEqual(report.input.references,[]);assert.equal(report.input.message,' original ');
});
await test('reconcile evidence and report finality inputs have explicit semantic rules',()=>{
 const base={operationId:'r',attemptId,leaseVersion:2,message:'checked',outcome:'applied'};
 assert.throws(()=>m.decodeReportCommand(query,'reconcile',{...base,externalOperationId:'remote'}),m.InputError);
 const value=m.decodeReportCommand(query,'reconcile',{...base,references:[{kind:'link',url:'https://example.invalid/result'}]});assert.equal(value.input.references.length,1);
 assert.throws(()=>m.decodeReportCommand(query,'failed',{operationId:'f',attemptId,leaseVersion:1,message:'blocked'}),m.InputError);
 assert.throws(()=>m.decodeReportCommand(query,'restart',{operationId:'again',attemptId,leaseVersion:2,confirmationOperationId:'r',message:'extra'}),m.InputError);
});
await test('lease observation is pure and expiration is inclusive; planning is not authority',()=>{
 const a={attemptId,storedState:'running',state:'running',expiresAt:500,endedAt:null,endReason:null};
 assert.equal(m.observeExecutionAttempt(a,499),a);assert.deepEqual(m.observeExecutionAttempt(a,500),{...a,state:'interrupted',endedAt:500,endReason:'expired'});assert.equal(a.state,'running');
 assert.deepEqual(m.recoveryBranch('running'),{expectedStoredState:'running',markExpired:true});assert.deepEqual(m.recoveryBranch(undefined),{expectedStoredState:'interrupted',markExpired:false});assert.equal(m.EXECUTION_LEASE_SECONDS,300);assert.equal(m.EXECUTION_RENEW_SECONDS,60);
});
const head={attemptId,issueId:query.issueId,projectId:'P',principalId:'A',startOperationId:'start',startedAt:100,updatedAt:100,expiresAt:400,leaseVersion:1,storedState:'running',state:'running',endedAt:null,endReason:null,renewIntervalSeconds:60,leaseSeconds:300};
const state={actorId:'A',observedAt:200,assignedToActor:true,head,finalReportExists:false,latestConfirmation:null};
const calls=[],unknown={application:'unknown',disclosure:'denied',operationId:'p',failure:{kind:'forbidden',code:'forbidden'}};
const missing={status:'missing',operationId:'p',application:'unknown',failure:{kind:'not_found',code:'operation_not_found'}};
const port={inspectExecution:async c=>{calls.push(['inspectExecution',c]);return {status:'state',state};},inspectReport:async c=>{calls.push(['inspectReport',c]);return {status:'state',state};},rejectExecution:async(c,reason)=>{calls.push(['rejectExecution',reason]);return unknown;},rejectReport:async(c,reason)=>{calls.push(['rejectReport',reason]);return unknown;},readCurrent:async q=>{calls.push(['current',q]);return {status:'denied',failure:{kind:'unauthenticated',code:'unauthenticated'}};},readReports:async()=>({status:'value',value:{execution:null,reports:[],confirmations:[]}}),readHistory:async()=>({status:'value',value:{events:[],nextAfter:null}}),readExecutionResult:async()=>missing,readReportResult:async()=>missing,commitExecution:async c=>{calls.push(['commitExecution',c]);return unknown;},commitReport:async c=>{calls.push(['commitReport',c]);return unknown;}};
const api=m.createExecution(port);
await test('invalid application input never reaches commit and never fabricates nonapplication',async()=>{
 assert.equal((await api.current({projectId:'P'})).status,'invalid');
 const before=calls.length,result=await api.change({...query,action:'renew',input:{operationId:'bad',attemptId,leaseVersion:0}});assert.equal(calls.length,before);assert.equal(result.application,'unknown');assert.equal(result.disclosure,'withheld');assert.equal(result.failure.kind,'invalid');assert(!('certificate' in result));
});
await test('one authorized planning observation then one commit preserves unknown denial and operation ID without retry',async()=>{
 const before=calls.length,result=await api.report(m.decodeReportCommand(query,'progress',{operationId:'p',attemptId,leaseVersion:1,message:'original'}));assert.equal(result,unknown);assert.equal(calls.length,before+2);assert.equal(calls[before][0],'inspectReport');assert.equal(calls.at(-1)[0],'commitReport');assert.equal(calls.at(-1)[1].input.operationId,'p');assert.deepEqual(calls.at(-1)[1].input.references,[]);
 const receipt=await api.reportResult({projectId:'P',operationId:'p'});assert.equal(receipt,missing);assert.equal(receipt.application,'unknown');
});
await test('current denial and historical receipt remain separate; invalid history cursor performs no read',async()=>{
 const result=await api.current(query);assert.equal(result.status,'denied');assert(!('value' in result));assert.equal((await api.reportHistory({...query,after:-1})).status,'invalid');
});
await test('lifecycle rules decide assignment, head, owner, lease boundary and renewal interval',()=>{
 const cmd=action=>m.decodeExecutionCommand(query,action,{operationId:'x',attemptId,leaseVersion:1});
 assert.equal(m.planExecution(cmd('renew'),state).status,'planned');
 assert.equal(m.planExecution(cmd('renew'),{...state,observedAt:159}).reason,'renew_too_early');
 assert.equal(m.planExecution(cmd('end'),{...state,observedAt:400}).reason,'lease_expired');
 assert.equal(m.planExecution(cmd('interrupt'),{...state,observedAt:400}).plan.timing,'expired');
 assert.equal(m.planExecution(cmd('interrupt'),state).plan.timing,'live');
 assert.equal(m.planExecution(cmd('end'),{...state,actorId:'B'}).reason,'attempt_conflict');
 assert.equal(m.planExecution(cmd('end'),{...state,assignedToActor:false}).reason,'assignment_conflict');
 const acquire=m.decodeExecutionCommand(query,'acquire',{operationId:'a'});
 assert.equal(m.planExecution(acquire,{...state,observedAt:500}).reason,'execution_unavailable');
 assert.equal(m.planExecution(acquire,{...state,head:null}).plan.expectedHead,null);
 assert.equal(m.planExecution(acquire,{...state,head:{...head,storedState:'ended'}}).plan.expectedHead.leaseVersion,1);
});
await test('reconcile and restart belong to current assignee while historical owner remains unchanged',()=>{
 const interrupted={...state,actorId:'B',head:{...head,storedState:'interrupted',state:'interrupted',leaseVersion:2}};
 const reconcile=m.decodeReportCommand(query,'reconcile',{operationId:'reconcile',attemptId,leaseVersion:2,message:'checked',outcome:'not_performed',externalOperationId:'external'});
 const p=m.planReport(reconcile,interrupted);assert.equal(p.status,'planned');assert.equal(p.plan.expectedHead.principalId,'A');assert.equal(p.plan.nextAction,'restart');assert.equal(p.plan.markExpired,false);
 const restart=m.decodeReportCommand(query,'restart',{operationId:'restart',attemptId,leaseVersion:2,confirmationOperationId:'reconcile'});
 const confirmation={sequence:1,principalId:'B',operationId:'reconcile',attemptId,leaseVersion:2,outcome:'not_performed',used:false};
 const ready={...interrupted,latestConfirmation:confirmation};assert.equal(m.planReport(restart,ready).status,'planned');
 for(const delta of [{used:true},{principalId:'A'},{outcome:'unknown'},{operationId:'other'},{leaseVersion:1}])assert.equal(m.planReport(restart,{...ready,latestConfirmation:{...confirmation,...delta}}).reason,'confirmation_conflict');
 assert.equal(m.planReport(restart,{...ready,finalReportExists:true}).reason,'confirmation_conflict');
 assert.equal(m.planReport(reconcile,{...state,actorId:'B',observedAt:399,head:{...head,leaseVersion:2}}).reason,'interrupted_attempt_conflict');
 assert.equal(m.planReport(reconcile,{...state,actorId:'B',observedAt:400,head:{...head,leaseVersion:2}}).plan.markExpired,true);
});
await test('application recovers receipt before state rules, and planning conflict never dispatches',async()=>{
 const recovered={application:'confirmed',disclosure:'allowed',source:'recovered',receipt:{operationId:'again',snapshot:head}};
 let commit=0,reject=0;
 const api=m.createExecution({...port,inspectExecution:async()=>({status:'outcome',outcome:recovered}),commitExecution:async()=>{commit++;return unknown;}});
 assert.equal(await api.change(m.decodeExecutionCommand(query,'acquire',{operationId:'again'})),recovered);assert.equal(commit,0);
 const conflict=m.createExecution({...port,inspectExecution:async()=>({status:'state',state:{...state,assignedToActor:false}}),rejectExecution:async(c,reason)=>{reject++;assert.equal(reason,'assignment_conflict');return unknown;},commitExecution:async()=>{commit++;return unknown;}});
 assert.equal(await conflict.change(m.decodeExecutionCommand(query,'acquire',{operationId:'again'})),unknown);assert.equal(commit,0);assert.equal(reject,1);
});
await test('stored fence and selected expected-state plan cross only the typed atomic commit boundary',async()=>{
 const fence={operationId:'p',formatVersion:1};let seen;
 const api=m.createExecution({...port,commitReport:async(c,p,f)=>{seen={c,p,f};return unknown;}});
 await api.report(m.decodeReportCommand(query,'progress',{operationId:'p',attemptId,leaseVersion:1,message:'original'}),fence);
 assert.equal(seen.f,fence);assert.equal(seen.p.expectedHead.leaseVersion,1);assert.equal(seen.p.timing,'live');assert.equal(seen.c.input.operationId,'p');
});
const hashes=Object.fromEntries(await Promise.all(Object.keys(built.metafile.inputs).filter(x=>!x.startsWith('<')).map(async path=>[path,createHash('sha256').update(await readFile(path)).digest('hex')])));
const report={spec:'docs/architecture-spec.md sections 2–5',runtime:'pure browser-compatible bundle, concrete fake feature port; no Cloudflare mock',checks,sourceHashes:hashes,passed:true};await writeFile(dir+'/results.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:true,checks:checks.map(x=>x.name)}));
