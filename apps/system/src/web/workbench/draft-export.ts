// @module workbench
// @role adapter
import type {EditRecord} from './edit-contracts';
export function copyDraftText(text:string):Promise<void>{return navigator.clipboard.writeText(text);}
export function downloadDraft(record:EditRecord):void{
 const url=URL.createObjectURL(new Blob([JSON.stringify({...record,exportedAt:new Date().toISOString()},null,2)],{type:'application/json'})),a=document.createElement('a');
 a.href=url;a.download='projektor-draft-'+record.unitId+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
