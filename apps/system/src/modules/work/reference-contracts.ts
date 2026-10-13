// @module work
// @role public-value-policy
/** References belong to the source Issue/Wiki revision; Library bytes stay external. */
export type ContentReference =
  | {kind:'link';url:string;label?:string}
  | {kind:'library';libraryFileId:string;versionId:string;fileId?:string;url?:string;label?:string};
const unicode=(v:unknown,max:number):v is string=>typeof v==='string'&&!/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(v)&&new TextEncoder().encode(v).length<=max;
const opaqueId=(v:unknown,max:number):v is string=>unicode(v,max)&&/^[A-Za-z0-9_.:-]+$/.test(v);
export function parseContentReferences(value:unknown):ContentReference[]{
 if(!Array.isArray(value)||value.length>32)throw new Error('references: array of at most 32 entries required');
 const result=value.map((entry:unknown)=>{
  if(!entry||typeof entry!=='object'||Array.isArray(entry))throw new Error('references: object required');
  const v=entry as Record<string,unknown>,library=v.kind==='library';
  if(v.kind!=='link'&&!library)throw new Error('references: link or library kind required');
  const keys=library?['kind','fileId','versionId','libraryFileId','url','label']:['kind','url','label'];
  if(Object.keys(v).some(k=>!keys.includes(k)))throw new Error('references: unknown field');
  if((!library||Object.hasOwn(v,'url'))&&(!unicode(v.url,2048)||!v.url.length))throw new Error('references: nonempty URL of at most 2048 UTF-8 bytes required');
  if(Object.hasOwn(v,'label')&&!unicode(v.label,512))throw new Error('references: label of at most 512 UTF-8 bytes required');
  if(library&&((!opaqueId(v.libraryFileId,256)||!/^libfile_[A-Za-z0-9_-]+$/.test(v.libraryFileId))||!opaqueId(v.versionId,128)||(Object.hasOwn(v,'fileId')&&!opaqueId(v.fileId,256))))throw new Error('references: stable Library file ID and string version ID required');
  // No trimming, URL normalization, HTML stripping, or numeric version conversion.
  return {...v} as ContentReference;
 });
 if(new TextEncoder().encode(JSON.stringify(result)).length>4096)throw new Error('references: JSON must fit 4096 UTF-8 bytes');
 return result;
}
export const sameReferences=(a:ContentReference[]|undefined,b:ContentReference[]|undefined)=>JSON.stringify(a??[])===JSON.stringify(b??[]);
