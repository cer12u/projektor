// @module workbench
// @role model
import {sameReferences} from "../../modules/work/reference-contracts";
import type {EditRecord,Pending} from './edit-contracts';
export const draftReferences=(r:EditRecord)=>r.references??r.base?.references??[];
export const dirtyRecord=(r:EditRecord)=>r.text!==(r.base?.body??'')||(r.title??'')!==(r.base?.title??'')||!sameReferences(draftReferences(r),r.base?.references)||!!Object.keys(r.attributes??{}).length;
export const unsavedRecord=(r:EditRecord)=>dirtyRecord(r)||!!r.pending||!!r.latest||!!r.heldOperations?.length;
export function provenRejectedCreation(op:Pending,journal:Partial<Pending>|undefined):boolean{
  return !!journal&&journal.phase==='rejected'&&journal.nonApplication==='pre_dispatch'&&journal.owner===op.owner&&journal.operationId===op.operationId
    &&op.attempts<=1&&journal.attempts===1&&!op.issueId&&!journal.issueId&&(op.resourceKey??'issue')==='issue'&&(journal.resourceKey??'issue')==='issue'
    &&journal.projectId===op.projectId&&journal.body===op.body&&journal.title===op.title&&sameReferences(journal.references,op.references)
    &&journal.revision===op.revision&&JSON.stringify(journal.changes)===JSON.stringify(op.changes);
}
export const key=(r:Pick<EditRecord,'owner'|'targetId'|'unitId'>)=>[r.owner,r.targetId,r.unitId];
