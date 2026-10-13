// @module workbench
// @role model
import {sameReferences} from "../../modules/work/reference-contracts";
import {scopeOf,type BodyDocument} from "../../modules/work/content-contracts";
import type {Receipt} from './editor-contracts';
import type {Pending} from './edit-contracts';
export async function operationTarget(op:Pending,prefix:string):Promise<string>{if(op.issueId)return op.issueId;const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([op.owner,op.operationId])));return prefix+[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');}
/** Validates the immutable pending command's receipt; authority is checked by the caller at application time. */
export function validatePendingReceipt(receipt:Receipt,op:Pending,valid:(value:unknown)=>value is BodyDocument){
  if(receipt.operationId!==op.operationId||!valid(receipt.snapshot)||scopeOf(receipt.snapshot)!==op.projectId||receipt.snapshot.body!==op.body
    ||(op.references!==undefined&&!sameReferences(receipt.snapshot.references,op.references))||(op.title!==undefined&&(receipt.snapshot.title??'')!==op.title)||receipt.snapshot.revision!==(op.revision??0)+1||(op.issueId&&receipt.snapshot.id!==op.issueId))throw new Error('invalid_operation_receipt');
}
export function validateReceiptChanges(receipt:Receipt,op:Pending){if(op.changes)for(const [field,value]of Object.entries(op.changes))if(JSON.stringify((receipt.snapshot as unknown as Record<string,unknown>)[field])!==JSON.stringify(value))throw new Error('invalid_attribute_receipt');}
/** A held command is checked without replacing the current editor baseline. */
export async function validateHeldReceipt(receipt:Receipt,op:Pending,operationId:string,prefix:string,valid:(value:unknown)=>value is BodyDocument){
  if(receipt.operationId!==operationId||!valid(receipt.snapshot)||scopeOf(receipt.snapshot)!==op.projectId||receipt.snapshot.id!==await operationTarget(op,prefix)||receipt.snapshot.revision!==(op.revision??0)+1||receipt.snapshot.body!==op.body||(op.references!==undefined&&!sameReferences(receipt.snapshot.references,op.references))||(op.title!==undefined&&(receipt.snapshot.title??'')!==op.title))throw new Error('invalid_operation_receipt');
  validateReceiptChanges(receipt,op);
}
