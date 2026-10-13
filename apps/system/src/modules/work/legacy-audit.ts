// @module work
// @role import-contract
/** Original operational audit records are retained source data, never native Issue revisions. */
import {InputError} from '../change-outcomes';
export interface LegacyGateAuditRow {id:string;workspace_id:string;issue_id:string;occurred_at:number}
export interface LegacyGateAuditArtifact {
 version:1;kind:'legacy-operational-audit-preservation';sourceTable:'issue_gate_rejections';sourceCount:number;
 retrievedAt:string;rows:LegacyGateAuditRow[];rowHashes:{id:string;sha256:string}[];rowsSha256:string;
}
export interface LegacyAuditImportReceipt {
 datasetId:string;sourceTable:'issue_gate_rejections';status:'verified';count:number;
 sourceArtifactSha256:string;sourceRowsSha256:string;replayed:boolean;gate:'stopped';
}
const identifier=/^[A-Za-z0-9_-]{1,128}$/,sha256=/^[a-f0-9]{64}$/;
export function validateLegacyGateAudit(value:unknown):LegacyGateAuditArtifact {
 const fail=()=>new InputError('legacy_audit_invalid');
 if(!value||typeof value!=='object'||Array.isArray(value))throw fail();
 const v=value as Record<string,unknown>;
 if(v.version!==1||v.kind!=='legacy-operational-audit-preservation'||v.sourceTable!=='issue_gate_rejections'||
  !Array.isArray(v.rows)||v.rows.length<1||v.rows.length>8||v.sourceCount!==v.rows.length||!Array.isArray(v.rowHashes)||v.rowHashes.length!==v.rows.length||
  typeof v.rowsSha256!=='string'||!sha256.test(v.rowsSha256)||typeof v.retrievedAt!=='string'||!Number.isFinite(Date.parse(v.retrievedAt)))throw fail();
 const ids=new Set<string>();
 for(const row of v.rows as unknown[]){
  if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).sort().join(',')!=='id,issue_id,occurred_at,workspace_id')throw fail();
  const r=row as Record<string,unknown>;
  if(['id','issue_id','workspace_id'].some(k=>typeof r[k]!=='string'||!identifier.test(r[k]))||typeof r.occurred_at!=='number'||!Number.isSafeInteger(r.occurred_at)||r.occurred_at<0||ids.has(r.id as string))throw fail();
  ids.add(r.id as string);
 }
 const hashes=new Set<string>();
 for(const candidate of v.rowHashes as unknown[]){
  if(!candidate||typeof candidate!=='object'||Array.isArray(candidate))throw fail();
  const item=candidate as Record<string,unknown>;
  if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).sort().join(',')!=='id,sha256'||typeof item.id!=='string'||!ids.has(item.id)||hashes.has(item.id)||typeof item.sha256!=='string'||!sha256.test(item.sha256))throw fail();
  hashes.add(item.id);
 }
 return v as unknown as LegacyGateAuditArtifact;
}
/** The retained file's canonicalization: sorted object keys; original row ordering and Unix values. */
export function canonicalLegacyAuditRow(row:LegacyGateAuditRow):string {
 return JSON.stringify({id:row.id,issue_id:row.issue_id,occurred_at:row.occurred_at,workspace_id:row.workspace_id});
}
