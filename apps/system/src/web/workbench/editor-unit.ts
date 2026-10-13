// @module workbench
// @role adapter
import {store} from './editor-store';
export async function acquireUnit(owner:string,project:string,target:string){
  const k=JSON.stringify([owner,project,target]);let candidate=new URL(location.href).searchParams.get('unit');
  try{candidate??=sessionStorage.getItem(k);}catch{/* Download remains available. */}
  if(!candidate||!/^[a-f0-9-]{36}$/.test(candidate))candidate=crypto.randomUUID();
  const original=candidate;let channel:BroadcastChannel|null=null,claimedTarget=target;
  if(typeof BroadcastChannel!=='undefined'){
    channel=new BroadcastChannel('projektor-edit-units');let occupied=false;
    channel.onmessage=e=>{const v=e.data as{kind?:string;owner?:string;target?:string;unit?:string};if(v.kind==='occupied'&&v.owner===owner&&v.target===target&&v.unit===candidate)occupied=true;};
    channel.postMessage({kind:'probe',owner,target,unit:candidate});await new Promise(r=>setTimeout(r,120));
    if(occupied){candidate=crypto.randomUUID();try{const previous=await store.load(owner,target,original);if(previous)await store.put({...previous,unitId:candidate});}catch{/* The editor reports storage failure. */}}
    channel.onmessage=e=>{const v=e.data as{kind?:string;owner?:string;target?:string;unit?:string};if(v.kind==='probe'&&v.owner===owner&&v.target===claimedTarget&&v.unit===candidate)channel?.postMessage({kind:'occupied',owner,target:claimedTarget,unit:candidate});};
  }
  try{sessionStorage.setItem(k,candidate);}catch{/* Memory and download remain available. */}
  return{unit:candidate,release:()=>channel?.close(),setTarget:(id:string)=>{claimedTarget=id;try{sessionStorage.setItem(JSON.stringify([owner,project,id]),candidate);}catch{/* Download remains available. */}}};
}
