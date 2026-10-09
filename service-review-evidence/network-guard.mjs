// Reviewer-only process-local HTTP guard. This never changes OS/network settings.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../experiments/atomic-command-poc/package.json',import.meta.url));
const {Dispatcher,getGlobalDispatcher,setGlobalDispatcher}=require('undici');
const previous=getGlobalDispatcher();
const attempts=[];
class LocalOnlyDispatcher extends Dispatcher {
 dispatch(options,handler){
  const url=new URL(String(options.origin));
  if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)){
   attempts.push(url.origin+String(options.path??''));
   queueMicrotask(()=>handler.onError(new Error('Reviewer test forbids external HTTP: '+url.origin)));
   return true;
  }
  return previous.dispatch(options,handler);
 }
 close(...args){return previous.close(...args);}
 destroy(...args){return previous.destroy(...args);}
}
setGlobalDispatcher(new LocalOnlyDispatcher());
export function assertNoExternalNetworkAttempts(){assert.deepEqual(attempts,[],'No live external HTTP attempt is permitted, including optional runtime metadata');}
// Optional use through NODE_OPTIONS also protects owner suites: swallowed
// runtime fetch errors still make that test process fail at orderly exit.
process.on('beforeExit',assertNoExternalNetworkAttempts);
