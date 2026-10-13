// @module persistence
// @role public
export type {Operations,DurableOperation,OperationPreparation,OperationReceipt,OperationSummaryPage} from "../../../modules/prepared-operations";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
/** This HTTP attempt was rejected before dispatch, not proof about concurrent attempts with the same ID. */
export interface MutationNonapplication {
  readonly operationId: string;
  readonly status: 'not_applied';
  readonly phase: 'pre_dispatch';
}
export class MutationError extends Error {
  constructor(public readonly status: number, public readonly code: string,
    public readonly reason?: string, public readonly current?: Json,
    public readonly mutationOutcome?: MutationNonapplication) { super(code); }
}
