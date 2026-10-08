import {CASES,PHASES,STATES,PREFIX,caseID} from './trace.mjs';
// Custom reporter output is not TAP-prefixed. Unknown/raw diagnostics are dropped.
// The test runner's exit status and failures remain unchanged.
export default async function* reporter(source){
  let buffer='';const last=new Map(),failed=new Map();const github=process.env.GITHUB_ACTIONS==='true';
  function line(id,phase,state){
    const text='UI E2E '+id+' '+phase+' '+state;
    const level=['fail','timeout'].includes(state)?'error':'notice';
    return (github?'::'+level+' title=UI E2E diagnostic::':'')+text+'\n';
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
        if(!value||Object.keys(value).sort().join(',')!=='id,phase,state'||!/^C(?:0[1-9]|1[0-2])$|^S00$/.test(value.id)||!PHASES.includes(value.phase)||!STATES.includes(value.state))continue;
        last.set(value.id,value.phase);if(['fail','timeout'].includes(value.state)&&(!failed.has(value.id)||failed.get(value.id)==='scenario_body'))failed.set(value.id,value.phase);yield line(value.id,value.phase,value.state);
      }
    }else if(event.type==='test:fail'){
      const id=caseID(event.data?.name);
      yield line(id,failed.get(id)??last.get(id)??'scenario_body','fail');
    }else if(event.type==='test:pass'&&CASES.includes(event.data?.name)){
      yield line(caseID(event.data.name),'scenario_body','pass');
    }
  }
}
