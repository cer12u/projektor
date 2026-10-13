// @module workbench
// @role model
/** Rendering policy only. Never persist this derived value over the source URL. */
export function safeReferenceHref(raw:string|undefined):string|undefined{
 if(!raw||raw.trim()!==raw||/[\u0000-\u0020\u007f\\]/.test(raw))return undefined;
 try{const url=new URL(raw);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?raw:undefined;}catch{return undefined;}
}
