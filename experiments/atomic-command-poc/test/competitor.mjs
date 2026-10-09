import { parentPort,workerData } from 'node:worker_threads';
import { openStore,executeCommand } from '../src/core.mjs';
const db=openStore(workerData.path);
parentPort.postMessage({ready:true});
parentPort.once('message',()=>{try{parentPort.postMessage({result:executeCommand(db,workerData.actor,workerData.command,{now:workerData.now})});}catch(e){parentPort.postMessage({error:e.message});}finally{db.close();}});
