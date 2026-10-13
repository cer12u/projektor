// @module persistence
// @role assembly
/** Composition-only actor binding for immutable journal storage. */
import type {AuthDB} from '../primitives';
import type {Authenticated} from '../identity/authorization';
import {createD1OperationJournal} from './prepared-operations';
import type {D1OperationDefinition} from './transaction';
import type {OperationJournal} from '../../../modules/prepared-operations';
export function createOperationJournal(db:AuthDB,auth:Authenticated,definitions:readonly D1OperationDefinition[]):OperationJournal {
 return createD1OperationJournal(db,auth,definitions);
}
