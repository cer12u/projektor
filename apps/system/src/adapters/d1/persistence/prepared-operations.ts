// @module persistence
// @role private-d1
/** Immutable journal persistence. Business execution is owned by the shared application. */
import {canonicalInput,MutationError,fingerprintCommand} from './commit';
import type {AuthDB} from '../primitives';
import type {Authenticated} from '../identity/authorization';
import {createD1IntentStore} from './journal-store';
import type {D1OperationDefinition,PreparedIntent} from './transaction';
import {OperationError,type DurableOperation,type StoredOperationFence,type OperationJournal,type PreparedDescription} from '../../../modules/prepared-operations';
import {failureOf} from './outcomes';
import {digest} from '../../crypto/sha256';
function matches(stored:DurableOperation,p:PreparedIntent):boolean {
 return canonicalInput(stored.route,4096)===p.routeJson&&canonicalInput(stored.input,65536)===p.inputJson
  &&stored.target.kind===p.kind&&stored.target.targetId===p.targetId&&stored.target.projectId===p.projectId;
}
async function boundary<T>(operationId:string|undefined,run:()=>Promise<T>):Promise<T>{
 try{return await run();}catch(error){if(error instanceof OperationError)throw error;throw new OperationError(failureOf(error),operationId);}
}
export function createD1OperationJournal(db:AuthDB,auth:Authenticated,definitions:readonly D1OperationDefinition[]):OperationJournal {
 if(!definitions.length)throw new Error('operation_definitions_missing');
 const store=createD1IntentStore(db,auth,definitions);
 async function encode(p:PreparedDescription):Promise<PreparedIntent>{
  const definition=definitions.find(d=>d.routeTag===p.route.kind);
  if(!definition?.operationKinds.includes(p.kind))throw new MutationError(500,'unregistered_mutation_kind');
  const targetId='id' in p.target?p.target.id:p.target.prefix+await digest(JSON.stringify([auth.id,p.operationId]));
  const routeJson=canonicalInput(p.route,4096),inputJson=canonicalInput(p.input,65536);
  const {inputHash}=await fingerprintCommand({kind:p.kind,operationId:p.operationId,targetId,projectId:p.projectId,input:p.mutationInput},p.canonicalInputLimit);
  return {operationId:p.operationId,kind:p.kind,targetId,projectId:p.projectId,
   route:p.route,input:p.input,routeJson,inputJson,hash:inputHash,permissions:[...new Set(['view' as const,...p.permissions])].sort()};
 }
 return {
  get:operationId=>boundary(operationId,()=>store.get(operationId)),
  list:options=>boundary(undefined,()=>store.list(options)),
  record:envelope=>boundary(envelope.operationId,async()=>{
   await store.assertBoundary(true);
   const p=await encode(envelope);
   try{await store.record(p);}catch{/* Reconcile an ambiguous acknowledgment without replaying registration. */}
   let stored:DurableOperation;
   try{stored=await store.get(p.operationId);}catch(error){
    if(!(error instanceof MutationError&&error.status===404))throw error;
    return store.diagnoseUnrecorded(p);
   }
   if(stored.inputHash!==p.hash||!matches(stored,p))throw new MutationError(409,'operation_input_mismatch');
   if(stored.formatVersion!==1)throw new MutationError(409,'operation_format_unsupported');
   return stored;
  }),
  executionFence:(stored,envelope)=>boundary(stored.operationId,async()=>{
   await store.assertBoundary(true);
   const p=await encode(envelope);
   if(stored.operationId!==p.operationId||stored.inputHash!==p.hash||!matches(stored,p))throw new MutationError(409,'operation_input_mismatch');
   const fence:StoredOperationFence={operationId:p.operationId,formatVersion:1,kind:p.kind,targetId:p.targetId,projectId:p.projectId,
    routeJson:p.routeJson,inputJson:p.inputJson,hash:p.hash,permissions:stored.requiredPermissions};
   return fence;
  })
 };
}
