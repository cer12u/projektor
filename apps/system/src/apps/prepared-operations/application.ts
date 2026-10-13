// @module composition
// @role application
/** Durable journal orchestration. Fixed feature calls share the direct HTTP use cases. */
import {type ChangeOutcome} from '../../modules/change-outcomes';
import {OperationError,type Operations,type OperationJournal,type OperationJson,type OperationReceipt} from '../../modules/prepared-operations';
import {type WorkContent} from '../../modules/work/public';
import {type Execution} from '../../modules/execution/public';
import {decodePreparedCommand,describePreparedCommand} from './commands';
export function createPreparedOperations(journal:OperationJournal,work:Pick<WorkContent,'changeIssue'|'changeContent'|'changeDirectory'>,execution:Pick<Execution,'change'|'report'>):Operations {
 return {
  decodePreparation:decodePreparedCommand,
  prepare:command=>journal.record(describePreparedCommand(command)),
  list:options=>journal.list(options),
  get:operationId=>journal.get(operationId),
  async execute(operationId){
   const stored=await journal.get(operationId);
   if(stored.result.status==='confirmed')return {kind:'retained',receipt:{operationId,snapshot:stored.result.snapshot,source:'recovered'}};
   if(stored.formatVersion!==1)throw new OperationError({kind:'conflict',code:'operation_format_unsupported'},operationId);
   const envelope=decodePreparedCommand({route:stored.route,input:stored.input});
   const fence=await journal.executionFence(stored,describePreparedCommand(envelope));
   async function disclose<T,C>(outcome:ChangeOutcome<T,C>):Promise<OperationReceipt<T>>{
    if(outcome.application!=='confirmed')throw new OperationError(outcome.failure,operationId,outcome as Exclude<ChangeOutcome<OperationJson>,{application:'confirmed'}>);
    if(outcome.receipt.operationId!==operationId)throw new OperationError({kind:'unavailable',code:'operation_unconfirmed'},operationId);
    // Current journal/result authorization is checked after the feature returned. The receipt
    // is immutable; keep its feature type rather than recasting an arbitrary JSON snapshot.
    const confirmed=await journal.get(operationId);
    if(confirmed.result.status!=='confirmed')throw new OperationError({kind:'unavailable',code:'operation_unconfirmed'},operationId);
    return {...outcome.receipt,source:outcome.source};
   }
   switch(envelope.kind){
    case 'directory':return {kind:'directory',receipt:await disclose(await work.changeDirectory(envelope.command,fence))};
    case 'issue':return {kind:'issue',receipt:await disclose(await work.changeIssue(envelope.command,fence))};
    case 'content':return {kind:'content',receipt:await disclose(await work.changeContent(envelope.command,fence))};
    case 'execution':return {kind:'execution',receipt:await disclose(await execution.change(envelope.command,fence))};
    case 'report':return {kind:'report',receipt:await disclose(await execution.report(envelope.command,fence))};
   }
  }
 };
}
