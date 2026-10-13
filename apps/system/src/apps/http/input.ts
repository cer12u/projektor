// @module delivery
// @role protocol-input
import { ApiError } from "../../adapters/protocol-errors";
export async function jsonInput(request:Request,maxBytes=32768):Promise<unknown> {
  if(request.headers.get('Content-Type')?.split(';')[0].trim()!=='application/json')throw new ApiError(415,'json_required');
  if(!request.body)throw new ApiError(400,'invalid_input',{body:'required'});
  const reader=request.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
  for(;;){const r=await reader.read();if(r.done)break;bytes+=r.value.byteLength;
    if(bytes>maxBytes){await reader.cancel();throw new ApiError(413,'body_too_large');}chunks.push(r.value);}
  const data=new Uint8Array(bytes);let offset=0;for(const c of chunks){data.set(c,offset);offset+=c.byteLength;}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data)) as unknown;}
  catch{throw new ApiError(400,'invalid_input',{body:'invalid JSON'});}
}
