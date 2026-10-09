// Synthetic interoperability fixture only, not an enrolled external client.
// Local reader failures are deliberately not shaped like server JSON-RPC errors.
import {MCP_LIMITS} from '../service/mcp.mjs';
export async function readMCPResponse(response){
 if(response.headers.get('content-type')?.split(';')[0]!=='application/json')throw Error('Local MCP client: unexpected response type');
 const reader=response.body.getReader(),chunks=[];let size=0;
 try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>MCP_LIMITS.outputBytes){await reader.cancel();throw Error('Local MCP client: response limit');}chunks.push(value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
