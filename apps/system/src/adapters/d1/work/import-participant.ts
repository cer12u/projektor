// @module work
// @role import-participant
import { canonicalImportRow,ImportDataset,SourceEntity,sourceScope,supported,validateImportDataset } from "../maintenance/import-contract";
// Private deployment/data execution only; never a product HTTP import endpoint.
import type {AuthDB} from "../primitives";
import { ApiError } from "../../protocol-errors";
import { guardedBatch } from "../persistence/guarded-batch";
import {type Json} from "../persistence/public";
import {canonicalInput} from "../persistence/transaction";
import {sql} from "../primitives";
import { digest } from "../../crypto/sha256";
async function preflight(db:AuthDB,data:ImportDataset){
 let marker:{value:string}|null=null;try{marker=await db.prepare("SELECT value FROM model_settings WHERE key='schema_family'").first<{value:string}>();}catch{throw new ApiError(409,'isolated_new_schema_required');}if(marker?.value!=='projektor-new-v1')throw new ApiError(409,'isolated_new_schema_required');
 validateImportDataset(data);
}
async function importedWrite(db:AuthDB,datasetId:string,statement:D1PreparedStatement){const [guard,cleanup]=guardedBatch(db,sql("EXISTS(SELECT 1 FROM write_gate WHERE id=1 AND mode='importing') AND EXISTS(SELECT 1 FROM import_runs WHERE id=? AND phase='importing')",datasetId),[]);await db.batch([guard,statement,cleanup]);}
/** The single source-to-canonical projection used by both import paths. */
async function canonicalEntity(db:AuthDB,e:SourceEntity,datasetId:string){
 const expected=canonicalImportRow(e);if(!expected)return;
 // Existing per-row runner resolves Issue parents at its final validation phase.
 const row={...expected.row};if(expected.table==='issues')row.parent_id=null;
 const columns=Object.keys(row);await importedWrite(db,datasetId,db.prepare('INSERT OR IGNORE INTO '+expected.table+' ('+columns.join(',')+') VALUES('+columns.map(()=>'?').join(',')+')').bind(...Object.values(row)));
}
/** Compare stored scalar columns on D1; only the one-bit result crosses the tool boundary.
 * Expected strings must round-trip UTF-8 so wire normalization cannot conceal a mismatch. */
async function storedRowEquals(db:AuthDB,table:string,id:string,expected:Record<string,Json>){
 const values:(string|number)[]=[],checks=Object.entries(expected).map(([key,value])=>{
  const column='"'+key+'"';
  if(value===null)return column+' IS NULL';
  if(typeof value==='string'){
   if(new TextDecoder('utf-8',{ignoreBOM:true}).decode(new TextEncoder().encode(value))!==value)throw new ApiError(400,'source_field_invalid');
   values.push(value);return `typeof(${column})='text' AND CAST(${column} AS BLOB)=CAST(? AS BLOB)`;
  }
  if(typeof value==='number'){values.push(value);return `typeof(${column}) IN('integer','real') AND ${column}=?`;}
  throw new ApiError(400,'source_field_invalid');
 });
 if(!checks.length)throw new ApiError(400,'source_field_invalid');
 const row=await db.prepare(`SELECT EXISTS(SELECT 1 FROM ${table} WHERE ${checks.map(c=>'('+c+')').join(' AND ')} AND id=?) AS ok`).bind(...values,id).first<{ok:number}>();
 return row?.ok===1;
}
async function canonicalReadback(db:AuthDB,e:SourceEntity){
 const expected=canonicalImportRow(e);if(expected&&!await storedRowEquals(db,expected.table,e.id,expected.row))throw new ApiError(409,'canonical_import_mismatch');
}
async function datasetState(db:AuthDB,data:ImportDataset){
 await preflight(db,data);
 const hash=await digest(canonicalInput(data as unknown as Json,16*1024*1024));
 const counts=Object.fromEntries([...supported].map(table=>[table,data.entities.filter(e=>e.table===table).length]));
 const previous=await db.prepare('SELECT input_hash,phase FROM import_runs WHERE id=?').bind(data.id).first<{input_hash:string;phase:string}>();
 if(previous&&previous.input_hash!==hash)throw new ApiError(409,'import_dataset_mismatch');
 return{hash,counts,previous};
}
/** Full-manifest validation remains mandatory; chunks never redefine the dataset. */
export async function beginWorkImport(db:AuthDB,data:ImportDataset){
 const{hash,counts,previous}=await datasetState(db,data);if(previous?.phase==='verified')return{datasetId:data.id,phase:'verified',counts,replayed:true};
 if(!previous){await db.batch(guardedBatch(db,sql("EXISTS(SELECT 1 FROM write_gate WHERE id=1 AND mode<>'importing')"),[{expectedChanges:1,statement:sql("UPDATE write_gate SET mode='importing',epoch=epoch+1 WHERE id=1 AND mode<>'importing'")},{expectedChanges:1,statement:sql("INSERT INTO import_runs VALUES(?,?,'importing',?,unixepoch())",data.id,hash,JSON.stringify(counts))}]));}
 const gate=await db.prepare('SELECT mode FROM write_gate WHERE id=1').first<{mode:string}>();if(gate?.mode!=='importing')throw new ApiError(409,'import_gate_mismatch');
 return{datasetId:data.id,phase:'importing',counts,replayed:!!previous};
}
/** Resume from immutable row receipts, including a lost response after a commit. */
export async function importDatasetChunk(db:AuthDB,data:ImportDataset,limits:{maxRows:number;maxBytes:number}={maxRows:50,maxBytes:256*1024}){
 if(!Number.isSafeInteger(limits.maxRows)||limits.maxRows<1||limits.maxRows>50||!Number.isSafeInteger(limits.maxBytes)||limits.maxBytes<65536||limits.maxBytes>256*1024)throw new ApiError(400,'import_chunk_limit_invalid');
 const{previous}=await datasetState(db,data);if(!previous)throw new ApiError(409,'import_not_started');if(previous.phase==='verified')return{datasetId:data.id,processed:0,remaining:0,bytes:0};
 const count=await db.prepare('SELECT count(*) n FROM import_row_receipts WHERE dataset_id=?').bind(data.id).first<{n:number}>();
 if(!count||!Number.isSafeInteger(count.n)||count.n<0||count.n>data.entities.length)throw new ApiError(409,'import_receipt_mismatch');
 const rows:{kind:string;entity_id:string;record_hash:string}[]=[];
 for(let offset=0;offset<count.n;offset+=50){
  const page=await db.prepare('SELECT kind,entity_id,record_hash FROM import_row_receipts WHERE dataset_id=? ORDER BY kind,entity_id LIMIT 50 OFFSET ?').bind(data.id,offset).all<{kind:string;entity_id:string;record_hash:string}>();
  if(page.results.length!==Math.min(50,count.n-offset))throw new ApiError(409,'import_receipt_mismatch');
  rows.push(...page.results);
 }
 const receipts=new Map(rows.map(r=>[r.kind+':'+r.entity_id,r.record_hash]));
 if(receipts.size!==rows.length)throw new ApiError(409,'import_receipt_mismatch');
 for(const row of rows){const e=data.entities.find(e=>e.table===row.kind&&e.id===row.entity_id);if(!e||row.record_hash!==await digest(canonicalInput(e.row,65536)))throw new ApiError(409,'import_receipt_mismatch');}
 const rank=(e:SourceEntity)=>e.table==='workspaces'?0:e.table==='projects'?1:e.table==='issues'?2:e.table==='wiki_pages'?3:e.table==='issue_comments'?4:5;
 const pending=[...data.entities].filter(e=>!receipts.has(e.table+':'+e.id)).sort((a,b)=>rank(a)-rank(b));
 let processed=0,bytes=0;
 for(const e of pending){
  const size=new TextEncoder().encode(canonicalInput(e.row,65536)).length;
  if(processed>=limits.maxRows||bytes+size>limits.maxBytes)break;
  const record=canonicalInput(e.row,65536),recordHash=await digest(record),existing=await db.prepare('SELECT record_hash,scope_id,workspace_id FROM imported_entities WHERE kind=? AND id=?').bind(e.table,e.id).first<{record_hash:string;scope_id:string;workspace_id:string}>();
  if(existing&&(existing.record_hash!==recordHash||existing.scope_id!==sourceScope(e)||existing.workspace_id!==e.workspaceId))throw new ApiError(409,'import_record_mismatch');
  await canonicalEntity(db,e,data.id);
  const [guard,cleanup]=guardedBatch(db,sql("EXISTS(SELECT 1 FROM write_gate WHERE id=1 AND mode='importing') AND EXISTS(SELECT 1 FROM import_runs WHERE id=? AND phase='importing')",data.id),[]);await db.batch([guard,db.prepare('INSERT OR IGNORE INTO imported_entities VALUES(?,?,?,?,?,?)').bind(e.table,e.id,e.workspaceId,sourceScope(e),record,recordHash),db.prepare('INSERT OR IGNORE INTO import_row_receipts VALUES(?,?,?,?)').bind(data.id,e.table,e.id,recordHash),cleanup]);
  processed++;bytes+=size;
 }
 return{datasetId:data.id,processed,remaining:pending.length-processed,bytes};
}
/** Only complete raw/canonical/FK/count readback may leave importing mode. */
export async function finishDatasetImport(db:AuthDB,data:ImportDataset){
 const{hash,counts,previous}=await datasetState(db,data);if(!previous)throw new ApiError(409,'import_not_started');if(previous.phase==='verified')return{datasetId:data.id,phase:'verified',counts,replayed:true};
 for(const e of data.entities.filter(e=>e.table==='issues'&&e.row.parent_id!==null&&e.row.parent_id!==undefined))await importedWrite(db,data.id,db.prepare('UPDATE issues SET parent_id=? WHERE id=? AND parent_id IS NULL').bind(e.row.parent_id,e.id));
 for(const e of data.entities){const record=canonicalInput(e.row,65536),hash=await digest(record);if(!await storedRowEquals(db,'imported_entities',e.id,{kind:e.table,record,record_hash:hash}))throw new ApiError(409,'import_readback_mismatch');await canonicalReadback(db,e);}
 const foreignKeys=await db.prepare('PRAGMA foreign_key_check').all();if(foreignKeys.results.length)throw new ApiError(409,'import_reference_mismatch');
 const receipt=await db.prepare('SELECT count(*) n FROM import_row_receipts WHERE dataset_id=?').bind(data.id).first<{n:number}>();if(receipt?.n!==data.entities.length)throw new ApiError(409,'import_count_mismatch');
 await db.batch(guardedBatch(db,sql("EXISTS(SELECT 1 FROM write_gate WHERE id=1 AND mode='importing')"),[{expectedChanges:1,statement:sql("UPDATE import_runs SET phase='verified' WHERE id=? AND input_hash=? AND phase='importing'",data.id,hash)},{expectedChanges:1,statement:sql("UPDATE write_gate SET mode='stopped',epoch=epoch+1 WHERE id=1 AND mode='importing'")}]));
 return{datasetId:data.id,phase:'verified',counts,replayed:false};
}
