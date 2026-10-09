import {MachineRuntime,createMachineTransport} from '../client/machine-runtime.mjs';
import {FileMachineCredentialProvider} from '../client/native-machine-pairing.mjs';
import {NodeRuntimeJournal} from '../client/node-runtime-journal.mjs';
let input='';for await(const chunk of process.stdin)input+=chunk;
const spec=JSON.parse(input), journal=new NodeRuntimeJournal(spec.journal);
const transport=createMachineTransport({baseUrl:spec.origin,protocol:spec.protocol,getToken:spec.providerPath?()=>new FileMachineCredentialProvider(spec.providerPath).getToken():async()=>spec.syntheticToken,attemptDeadlineMs:1000});
const runtime=new MachineRuntime({transport,journal,runtimeInstanceId:spec.runtimeId,maxReceiptChecks:2,retryDelaysMs:[20,20],recoveryDeadlineMs:10000});
try {
 await runtime.connect(spec.context);
 const result=spec.action==='submit'?await runtime.submit(spec.command):await runtime.recover(spec.command.operationId);
 process.stdout.write(JSON.stringify({result}));
} catch(error) { process.stdout.write(JSON.stringify({error:error.code??error.message})); }
finally {try{await transport.close();}catch{}journal.close();}
