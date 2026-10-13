// @module verification
// @role fixture-reference-admin
let states=[],cursor=0,pending=[],dirty=false;
const equal=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
export function reset(){for(const s of states)s?.cleanup?.();states=[];cursor=0;pending=[];dirty=true;}
export function begin(){cursor=0;dirty=false;}
export function changed(){return dirty;}
export function useState(initial){const i=cursor++;if(!(i in states))states[i]={value:typeof initial==='function'?initial():initial};return[states[i].value,value=>{const next=typeof value==='function'?value(states[i].value):value;if(!Object.is(states[i].value,next)){states[i].value=next;dirty=true;}}];}
export function useRef(initial){const i=cursor++;if(!(i in states))states[i]={current:initial};return states[i];}
export function useMemo(fn,deps){const i=cursor++;if(!states[i]||!equal(states[i].deps,deps))states[i]={deps,value:fn()};return states[i].value;}
export function useCallback(fn,deps){return useMemo(()=>fn,deps);}
export function useEffect(effect,deps){const i=cursor++;if(!states[i]||!equal(states[i].deps,deps)){const old=states[i];states[i]={deps,cleanup:old?.cleanup};pending.push(()=>{old?.cleanup?.();states[i].cleanup=effect();});}}
export function flush(){for(const effect of pending.splice(0))effect();}
