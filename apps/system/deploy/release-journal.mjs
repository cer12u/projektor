// @module deployment
// @role journal
import {mkdir,readFile,open,rmdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {fail} from './cloudflare-port.mjs';
export const releaseKey=release=>createHash('sha256').update(JSON.stringify([release.account,release.worker,release.artifactTreeSha256])).digest('hex');
// Local, fail-closed persistence. No cross-executor availability is implied.
// A crash-held lock or corrupt/truncated event requires inspection, never a reset.
export function createJournal(root,release){
  const key=releaseKey(release),file=resolve(root,key+'.jsonl'),lock=resolve(root,key+'.lock');
  async function read(){
    let text;try{text=await readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}
    if(!text.endsWith('\n'))fail('JOURNAL_TRUNCATED');
    let events;try{events=text.trimEnd().split('\n').map(JSON.parse);}catch{fail('JOURNAL_CORRUPT');}
    for(let i=0;i<events.length;i++)if(events[i].sequence!==i||events[i].releaseKey!==key)fail('JOURNAL_IDENTITY_MISMATCH');
    return events.at(-1)?.state||null;
  }
  return Object.freeze({
    location:file,read,
    async exclusive(operation){
      await mkdir(root,{recursive:true});try{await mkdir(lock);}catch(e){if(e.code==='EEXIST')fail('JOURNAL_LOCKED_INSPECT_BEFORE_RECOVERY');throw e;}
      try{return await operation();}finally{await rmdir(lock);}
    },
    async append(state){
      let previous;try{previous=await readFile(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
      if(previous)await read();
      const sequence=previous?previous.trimEnd().split('\n').length:0;
      const event={sequence,releaseKey:key,recordedAt:new Date().toISOString(),state};
      const handle=await open(file,sequence?'a':'wx');
      try{await handle.writeFile(JSON.stringify(event)+'\n');await handle.sync();}finally{await handle.close();}
    },
  });
}
