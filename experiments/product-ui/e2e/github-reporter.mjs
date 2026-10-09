import {CASES,PHASES,STATES,PREFIX,caseID} from './trace.mjs';
// Custom reporter output is not TAP-prefixed. Unknown/raw diagnostics are dropped.
// The test runner's exit status and failures remain unchanged.
export function failureCategory(error){
 const names=new Set(['ReferenceError','TypeError','RangeError','SyntaxError','TimeoutError','AssertionError','AbortError','BarrierTimeoutError']);
 const types=new Set(['testCodeFailure','cancelledByParent','hookFailed','uncaughtException','unhandledRejection','testTimeoutFailure','subtestsFailed']);
 let errorClass='Other',failureType='other',value=error;const seen=new Set();
 for(let depth=0;depth<4&&value&&typeof value==='object'&&!seen.has(value);depth++){seen.add(value);try{const name=value.name,code=value.code,type=value.failureType,cause=value.cause;if(names.has(name))errorClass=name;if(code==='ERR_ASSERTION')errorClass='AssertionError';if(types.has(type))failureType=type;value=cause;}catch{break;}}
 return {errorClass,failureType};
}
export default async function* reporter(source){
  const selection=process.env.PROJEKTOR_UI_E2E_CASES??'';
  if(!['','C22,C23','C24,C25,C26,C27'].includes(selection))throw Error('INVALID_UI_E2E_SELECTION');
  const expectedIDs=new Set(selection?selection.split(','):CASES.map(caseID));
  let buffer='';const last=new Map(),failed=new Map(),results=new Map(),annotated=new Set(),categoryAnnotated=new Set(),suiteAnnotated=new Set(),lastStep=new Map(),bodyContext=new Map();let runnerFailed=false;const github=process.env.GITHUB_ACTIONS==='true';
  function line(id,phase,state,annotate=false){
    const text='UI E2E '+id+' '+phase+' '+state;
    const level=annotate?'error':id==='S00'&&phase==='suite_import'&&state==='start'?'notice':null;
    return (github&&level?'::'+level+' title=UI E2E diagnostic::':'')+text+'\n';
  }
  for await(const event of source){
    if(['test:stdout','test:stderr'].includes(event.type)){
      buffer+=typeof event.data?.message==='string'?event.data.message:'';
      if(buffer.length>65536)buffer=buffer.slice(-65536);
      for(;;){
        const index=buffer.indexOf('\n');if(index<0)break;
        const raw=buffer.slice(0,index);buffer=buffer.slice(index+1);
        if(!raw.startsWith(PREFIX))continue;
        let value;try{value=JSON.parse(raw.slice(PREFIX.length));}catch{continue;}
        if(!value||Object.keys(value).sort().join(',')!=='id,phase,state'||!/^C(?:0[1-9]|1[0-9]|2[0-7])$|^S00$/.test(value.id)||!PHASES.includes(value.phase)||!STATES.includes(value.state))continue;
        if(value.phase!=='scenario_body')lastStep.set(value.id,value.phase);else if(['fail','timeout'].includes(value.state)&&!bodyContext.has(value.id))bodyContext.set(value.id,lastStep.get(value.id)??'none');
        last.set(value.id,value.phase);if(value.id==='S00'&&['fail','timeout'].includes(value.state))runnerFailed=true;if(['fail','timeout'].includes(value.state)&&(!failed.has(value.id)||failed.get(value.id)==='scenario_body'))failed.set(value.id,value.phase);const suiteFailure=value.id==='S00'&&['fail','timeout'].includes(value.state)&&!suiteAnnotated.has(value.phase);if(suiteFailure){suiteAnnotated.add(value.phase);annotated.add(value.id);}yield line(value.id,value.phase,value.state,suiteFailure);
      }
    }else if(event.type==='test:fail'){
      const id=caseID(event.data?.name);if(expectedIDs.has(id))results.set(id,'fail');else runnerFailed=true;
      yield line(id,failed.get(id)??last.get(id)??'scenario_body','fail',!annotated.has(id));annotated.add(id);
      if(!categoryAnnotated.has(id)){const {errorClass,failureType}=failureCategory(event.data?.details?.error);const context=bodyContext.get(id)??lastStep.get(id)??'none';yield (github?'::error title=UI E2E failure category::':'')+'UI E2E failure id='+id+' class='+errorClass+' type='+failureType+' last_step='+context+'\n';categoryAnnotated.add(id);}
    }else if(event.type==='test:pass'&&CASES.includes(event.data?.name)){
      const id=caseID(event.data.name);
      if(!expectedIDs.has(id)||event.data?.skip){runnerFailed=true;continue;}
      if(results.get(id)!=='fail')results.set(id,'pass');yield line(id,'scenario_body','pass');
    }
  }
  const failedIDs=[...results].filter(([,state])=>state==='fail').map(([id])=>id).sort();
  const passed=[...results.values()].filter(state=>state==='pass').length,incomplete=expectedIDs.size-results.size;
  const summary='UI E2E summary passed='+passed+' failed='+failedIDs.length+' incomplete='+incomplete+' runner_failed='+runnerFailed+' failed_ids='+(failedIDs.join(',')||'none');
  const level=failedIDs.length||incomplete||runnerFailed?'error':'notice';
  yield (github?'::'+level+' title=UI E2E summary::':'')+summary+'\n';
}
