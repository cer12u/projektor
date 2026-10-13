// @module adapter.agent-file-credentials
// @role private-filesystem
import {open,stat,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,dirname} from 'node:path';

/** Explicit private location only; never discovers, creates or repairs a store. */
export function privateJsonProvider(privateRoot:string,path:string):()=>Promise<unknown>{
 const root=resolve(privateRoot),filePath=resolve(path);
 if(dirname(filePath)!==root)throw new Error('explicit_private_file_required');
 return async()=>{
  const directory=await stat(root);
  if(!directory.isDirectory()||(directory.mode&0o077)!==0||directory.uid!==process.getuid?.()||await realpath(root)!==root)throw new Error('private_directory_required');
  const file=await open(filePath,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
   const m=await file.stat();
   if(!m.isFile()||(m.mode&0o077)!==0||m.uid!==process.getuid?.()||m.size>4096)throw new Error('private_file_required');
   try{return JSON.parse(await file.readFile('utf8')) as unknown;}catch{throw new Error('credential_record_invalid');}
  }finally{await file.close();}
 };
}
