// @module workbench
// @role contracts
import type {EditRecord} from './edit-contracts';
export interface EditorView{record:EditRecord;accessLost:boolean;ready:boolean;storageAvailable:boolean;writes:number}
