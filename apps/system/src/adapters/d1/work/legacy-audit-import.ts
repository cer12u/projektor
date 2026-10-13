// @module work
// @role import-participant
/** Additive operational import only. No HTTP route and no credential or Issue-revision writes. */
import type {AuthDB} from '../primitives';
import {sql} from '../primitives';
import {guardedBatch,type CountedWrite} from '../persistence/guarded-batch';
import {digest} from '../../crypto/sha256';
import {ApiError} from '../../protocol-errors';
import {InputError} from '../../../modules/change-outcomes';
import {validateLegacyGateAudit,canonicalLegacyAuditRow,type LegacyGateAuditArtifact,type LegacyAuditImportReceipt} from '../../../modules/work/legacy-audit';
interface PreparedAudit {artifact:LegacyGateAuditArtifact;artifactHash:string;datasetId:string;rows:{row:LegacyGateAuditArtifact['rows'][number];json:string;hash:string}[]}
export async function prepareLegacyAuditArtifact(serialized:string):Promise<PreparedAudit>{
 if(typeof serialized!=='string'||new TextEncoder().encode(serialized).byteLength>262144)throw new InputError('legacy_audit_invalid');
 let parsed:unknown;try{parsed=JSON.parse(serialized);}catch{throw new InputError('legacy_audit_invalid');}
 const artifact=validateLegacyGateAudit(parsed),rows=await Promise.all(artifact.rows.map(async row=>{const json=canonicalLegacyAuditRow(row);return {row,json,hash:await digest(json)};}));
 if(await digest('['+rows.map(x=>x.json).join(',')+']')!==artifact.rowsSha256||rows.some(x=>artifact.rowHashes.find(h=>h.id===x.row.id)?.sha256!==x.hash))throw new InputError('legacy_audit_hash_mismatch');
 return {artifact,artifactHash:await digest(serialized),datasetId:'legacy-gate-audit-'+artifact.rowsSha256,rows};
}
export async function importLegacyGateAudit(db:AuthDB,serialized:string):Promise<LegacyAuditImportReceipt>{
 const p=await prepareLegacyAuditArtifact(serialized),table=p.artifact.sourceTable,counts=JSON.stringify({[table]:p.rows.length});
 const gate=await db.prepare('SELECT mode FROM write_gate WHERE id=1').first<{mode:string}>();
 if(gate?.mode!=='stopped')throw new ApiError(409,'audit_import_requires_stopped_gate');
 const expected=p.rows.map(({row,json,hash})=>sql(`EXISTS(SELECT 1 FROM imported_entities e JOIN import_row_receipts r ON r.kind=e.kind AND r.entity_id=e.id WHERE r.dataset_id=? AND e.kind=? AND e.id=? AND e.workspace_id=? AND e.record_hash=? AND r.record_hash=? AND CAST(e.record AS BLOB)=CAST(? AS BLOB) AND EXISTS(SELECT 1 FROM issues i JOIN projects project ON project.id=i.project_id WHERE i.id=? AND i.workspace_id=? AND project.workspace_id=? AND e.scope_id=i.project_id))`,p.datasetId,table,row.id,row.workspace_id,hash,hash,json,row.issue_id,row.workspace_id,row.workspace_id));
 async function confirmed():Promise<boolean>{
  const q=sql(`SELECT EXISTS(SELECT 1 FROM write_gate WHERE id=1 AND mode='stopped') AND EXISTS(SELECT 1 FROM import_runs WHERE id=? AND input_hash=? AND phase='verified' AND counts=?) AND (SELECT count(*) FROM import_row_receipts WHERE dataset_id=?)=? AND (${expected.map(x=>x.text).join(' AND ')}) AS valid`,p.datasetId,p.artifactHash,counts,p.datasetId,p.rows.length,...expected.flatMap(x=>x.values));
  return (await db.prepare(q.text).bind(...q.values).first<{valid:number}>())?.valid===1;
 }
 const receipt=(replayed:boolean):LegacyAuditImportReceipt=>({datasetId:p.datasetId,sourceTable:table,status:'verified',count:p.rows.length,sourceArtifactSha256:p.artifactHash,sourceRowsSha256:p.artifact.rowsSha256,replayed,gate:'stopped'});
 const prior=await db.prepare('SELECT input_hash FROM import_runs WHERE id=?').bind(p.datasetId).first<{input_hash:string}>();
 if(prior){if(prior.input_hash!==p.artifactHash||!await confirmed())throw new ApiError(409,'audit_import_input_mismatch');return receipt(true);}
 const relations=p.rows.map(({row})=>sql(`EXISTS(SELECT 1 FROM issues i JOIN projects project ON project.id=i.project_id JOIN imported_entities source ON source.kind='issues' AND source.id=i.id AND source.scope_id=i.project_id AND source.workspace_id=i.workspace_id WHERE i.id=? AND i.workspace_id=? AND project.workspace_id=?) AND NOT EXISTS(SELECT 1 FROM imported_entities WHERE kind=? AND id=?)`,row.issue_id,row.workspace_id,row.workspace_id,table,row.id));
 const guard=sql(`EXISTS(SELECT 1 FROM model_settings WHERE key='schema_family' AND value='projektor-new-v1') AND EXISTS(SELECT 1 FROM write_gate WHERE id=1 AND mode='stopped') AND NOT EXISTS(SELECT 1 FROM import_runs WHERE id=?) AND (${relations.map(x=>x.text).join(' AND ')})`,p.datasetId,...relations.flatMap(x=>x.values));
 const writes:CountedWrite[]=[
  {expectedChanges:1,statement:sql("UPDATE write_gate SET mode='importing',epoch=epoch+1 WHERE id=1 AND mode='stopped'")},
  {expectedChanges:1,statement:sql("INSERT INTO import_runs VALUES(?,?,'importing',?,unixepoch())",p.datasetId,p.artifactHash,counts)},
 ];
 for(const {row,json,hash}of p.rows)writes.push(
  {expectedChanges:1,statement:sql('INSERT INTO imported_entities(kind,id,workspace_id,scope_id,record,record_hash) SELECT ?,?,?,project_id,?,? FROM issues WHERE id=? AND workspace_id=?',table,row.id,row.workspace_id,json,hash,row.issue_id,row.workspace_id)},
  {expectedChanges:1,statement:sql('INSERT INTO import_row_receipts VALUES(?,?,?,?)',p.datasetId,table,row.id,hash)});
 writes.push({expectedChanges:1,statement:sql("UPDATE import_runs SET phase='verified' WHERE id=? AND input_hash=? AND phase='importing'",p.datasetId,p.artifactHash)},
  {expectedChanges:1,statement:sql("UPDATE write_gate SET mode='stopped',epoch=epoch+1 WHERE id=1 AND mode='importing'")});
 let lost=false;try{await db.batch(guardedBatch(db,guard,writes));}catch{lost=true;}
 if(!await confirmed())throw new ApiError(409,'audit_import_unconfirmed');
 return receipt(lost);
}
