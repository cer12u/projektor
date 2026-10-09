// Test-only synchronization. Diagnostics contain route metadata, never a body,
// cookie, credential, raw URL query or HTTP response.
export function safePageLocation(input){
  try{
    const url=new URL(input),safe=new URL(url.origin+url.pathname);
    for(const key of ['view','status']){const value=url.searchParams.get(key);if(value&&/^[a-z_]+$/.test(value))safe.searchParams.set(key,value);}
    return safe.href;
  }catch{return '<unavailable>';}
}
export class BarrierTimeoutError extends Error{
  constructor(label,phase,context){super('BARRIER_TIMEOUT '+label+' '+phase+' '+JSON.stringify(context));this.name='BarrierTimeoutError';}
}
export function gateFailureMessage(error){return error instanceof BarrierTimeoutError?error.message:'GATE_REQUEST_FAILED: expected synthetic request/response was unavailable';}
export function createBarrier({label,diagnostics=()=>({}),timeoutMs=10000,onTimeout=()=>{}}){
  let enter,release,entered=false,released=false;
  const request=new Promise(resolve=>enter=resolve),response=new Promise(resolve=>release=resolve);
  async function bounded(promise,phase){
    let timer;
    try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>{
      let context;try{context=diagnostics();}catch{context={diagnostic:'unavailable'};}
      try{onTimeout(label,phase);}catch{/* Reporting must not alter the failing outcome. */}
      reject(new BarrierTimeoutError(label,phase,context));
    },timeoutMs);})]);}finally{clearTimeout(timer);}
  }
  return {
    enter(){if(!entered){entered=true;enter();}},
    release(){if(!released){released=true;release();}},
    waitForRequest(){return bounded(request,'expected-request');},
    holdResponse(){return bounded(response,'response-release');},
  };
}
