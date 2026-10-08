import {CASES,PHASES,STATES,PREFIX,caseID} from './trace.mjs';
// Custom reporter output is not TAP-prefixed. Unknown/raw diagnostics are dropped.
// The test runner's exit status and failures remain unchanged.
export default async function* reporter(source){
  let buffer='';const last=new Map(),failed=new Map(),results=new Map(),annotated=new Set();let runnerFailed=false;const github=process.env.GITHUB_ACTIONS==='true';
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
        if(!value||Object.keys(value).sort().join(',')!=='id,phase,state'||!/^C(?:0[1-9]|1[0-7])$|^S00$/.test(value.id)||!PHASES.includes(value.phase)||!STATES.includes(value.state))continue;
        last.set(value.id,value.phase);if(value.id==='S00'&&['fail','timeout'].includes(value.state))runnerFailed=true;if(['fail','timeout'].includes(value.state)&&(!failed.has(value.id)||failed.get(value.id)==='scenario_body'))failed.set(value.id,value.phase);yield line(value.id,value.phase,value.state);
      }
    }else if(event.type==='test:fail'){
      const id=caseID(event.data?.name);if(CASES.includes(event.data?.name))results.set(id,'fail');else runnerFailed=true;
      yield line(id,failed.get(id)??last.get(id)??'scenario_body','fail',!annotated.has(id));annotated.add(id);
    }else if(event.type==='test:pass'&&CASES.includes(event.data?.name)){
      if(results.get(caseID(event.data.name))!=='fail')results.set(caseID(event.data.name),'pass');yield line(caseID(event.data.name),'scenario_body','pass');
    }
  }
  const failedIDs=[...results].filter(([,state])=>state==='fail').map(([id])=>id).sort();
  const passed=[...results.values()].filter(state=>state==='pass').length,incomplete=CASES.length-results.size;
  const summary='UI E2E summary passed='+passed+' failed='+failedIDs.length+' incomplete='+incomplete+' runner_failed='+runnerFailed+' failed_ids='+(failedIDs.join(',')||'none');
  const level=failedIDs.length||incomplete||runnerFailed?'error':'notice';
  yield (github?'::'+level+' title=UI E2E summary::':'')+summary+'\n';
}
