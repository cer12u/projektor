// @module administration
// @role storage
// Non-authorizing context and operation correlation only. Never store cookies or passwords.
import type {RecipientSetupStatus} from '../../modules/identity/public';
type Binding=Pick<Exclude<RecipientSetupStatus,{state:'waiting'}>,'operationId'|'principalId'|'purpose'|'issuerId'|'targetAuthVersion'>;
export interface RecipientMarker {requestId:string;expiresAt:number;binding?:Binding;completionAttempted?:boolean;retirement?:'confirmed'|'unproven'}
const key='projektor-recipient-context-v1';
function valid(value:unknown):value is RecipientMarker{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;const v=value as RecipientMarker;
 if(Object.keys(v).some(k=>!['requestId','expiresAt','binding','completionAttempted','retirement'].includes(k))||typeof v.requestId!=='string'||!v.requestId||v.requestId.length>160||typeof v.expiresAt!=='number'||!Number.isFinite(v.expiresAt)||v.expiresAt<=0||v.retirement!==undefined&&!['confirmed','unproven'].includes(v.retirement)||v.completionAttempted!==undefined&&typeof v.completionAttempted!=='boolean')return false;
 const b=v.binding;return !b||Object.keys(b).every(k=>['operationId','principalId','purpose','issuerId','targetAuthVersion'].includes(k))&&typeof b.operationId==='string'&&!!b.operationId&&typeof b.principalId==='string'&&!!b.principalId&&typeof b.issuerId==='string'&&!!b.issuerId&&['initial','reset'].includes(b.purpose)&&Number.isSafeInteger(b.targetAuthVersion)&&b.targetAuthVersion>=1;
}
export function loadRecipientMarker():RecipientMarker|null{const raw=localStorage.getItem(key);if(raw===null)return null;const value:unknown=JSON.parse(raw);if(!valid(value))throw new Error('invalid_recipient_recovery');return value;}
function write(value:RecipientMarker){localStorage.setItem(key,JSON.stringify(value));if(JSON.stringify(loadRecipientMarker())!==JSON.stringify(value))throw new Error('recipient_recovery_not_saved');}
export function saveRecipientContext(context:{requestId:string;expiresAt:number},replaceAbandonedId?:string):RecipientMarker{
 const old=loadRecipientMarker();if(replaceAbandonedId){if(!old?.retirement||old.requestId!==replaceAbandonedId)throw new Error('recipient_context_changed');write(context);return context;}
 if(old&&(old.retirement||old.requestId!==context.requestId||context.expiresAt>old.expiresAt))throw new Error('recipient_context_changed');const value=old?{...old,expiresAt:context.expiresAt}:context;write(value);return value;
}
export function retainRecipientStatus(status:RecipientSetupStatus,completionAttempted=false):RecipientMarker{
 const old=loadRecipientMarker();if(!old||old.retirement||old.requestId!==status.requestId||status.expiresAt>old.expiresAt)throw new Error('recipient_context_changed');
 if(status.state==='waiting'){if(old.binding)throw new Error('recipient_binding_lost');return old;}
 const binding:Binding={operationId:status.operationId,principalId:status.principalId,purpose:status.purpose,issuerId:status.issuerId,targetAuthVersion:status.targetAuthVersion};
 if(old.binding&&Object.entries(binding).some(([k,v])=>old.binding![k as keyof Binding]!==v))throw new Error('recipient_binding_changed');
 const value={...old,binding,...(completionAttempted||old.completionAttempted?{completionAttempted:true}:{})};write(value);return value;
}
export function requireRecipientMarker(requestId:string):RecipientMarker{const value=loadRecipientMarker();if(!value||value.retirement||value.requestId!==requestId)throw new Error('recipient_context_changed');return value;}
export function retireRecipientMarker(requestId:string):void{const value=loadRecipientMarker();if(!value||value.requestId!==requestId)throw new Error('recipient_context_changed');write({...value,retirement:'unproven'});}
export function markRecipientAbandoned(requestId:string):void{const value=loadRecipientMarker();if(!value||value.requestId!==requestId)throw new Error('recipient_context_changed');write({...value,retirement:'confirmed'});}
