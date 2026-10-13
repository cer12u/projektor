// @module tooling.schema
// @role adoption
// Pure proposal preparation. No connection, live execution, or historical-time inference.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {assess} from "./assessment.mjs";
import {ledgerSQL} from "./ledger.mjs";
import {snapshot} from "./snapshot.mjs";
export const applicationTableNames=s=>Object.keys(s.tables).filter(n=>!['d1_migrations','_cf_METADATA','_cf_KV'].includes(n)).sort();
const literal=s=>"'"+String(s).replaceAll("'","''")+"'";
const identifier=s=>'"'+s.replaceAll('"','""')+'"';
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export async function prepareBaselineAdoption({snapshot:s,chain,baselineCount=15,counts,gate,identity,provenance}) {
 assert.equal(baselineCount,15,'This reviewed baseline is exactly canonical0001–0015.');
 assert.equal(chain.migrations.length>=15,true);
 assert.equal(s.objects.some(o=>o.name==='d1_migrations'||o.tbl_name==='d1_migrations'),false,'Ledger must be wholly absent.');
 assert.deepEqual(s.ledger,[]);
 assert.deepEqual({...gate},{mode:'stopped',epoch:4});
 assert.ok(identity?.accountId&&identity?.databaseId&&identity?.observedAt,'Explicit observed target identity required.');
 assert.ok(provenance?.sourceEvidence&&provenance?.dataEffectReview,'Evidence and data-effect review required.');
 const names=applicationTableNames(s);
 assert.deepEqual(Object.keys(counts).sort(),names,'Every application table count is required; no internal-table counts.');
 assert.ok(Object.values(counts).every(n=>Number.isSafeInteger(n)&&n>=0));
 // A private in-memory projection lets the existing strict schema validator check
 // exact canonical prefix and internal declarations. It does not create history.
 const db=new DatabaseSync(':memory:');let ledger;
 try{db.exec(ledgerSQL);ledger=snapshot(db);}finally{db.close();}
 const projected={...s,objects:[...s.objects,...ledger.objects].sort((a,b)=>a.type.localeCompare(b.type)||a.name.localeCompare(b.name)),tables:{...s.tables,...ledger.tables},ledger:chain.migrations.slice(0,baselineCount).map((m,i)=>({id:i+1,name:m.name,applied_at:'projection-only-not-applied'}))};
 const projectedAssessment=await assess(projected,chain);
 assert.ok(['current','ready'].includes(projectedAssessment.status),JSON.stringify(projectedAssessment));
 assert.equal(projectedAssessment.schemaPrefix,baselineCount,'Exact baseline schema required.');
 const schemaJSON=JSON.stringify(s.objects.map(({type,name,tbl_name,sql})=>({type,name,tbl_name,sql})));
 const schemaRead="(SELECT json_group_array(json_object('type',type,'name',name,'tbl_name',tbl_name,'sql',sql)) FROM (SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name))";
 const guards=[schemaRead+'='+literal(schemaJSON),"(SELECT count(*) FROM write_gate WHERE id=1 AND mode='stopped' AND epoch=4)=1","(SELECT count(*) FROM model_settings WHERE key='schema_family' AND value='projektor-new-v1')=1",
  "NOT EXISTS(SELECT 1 FROM principals p WHERE NOT EXISTS(SELECT 1 FROM principal_management m WHERE m.principal_id=p.id))",
  "NOT EXISTS(SELECT 1 FROM api_credentials c WHERE NOT EXISTS(SELECT 1 FROM credential_management m WHERE m.credential_id=c.id))",
  "NOT EXISTS(SELECT 1 FROM principals p WHERE p.kind='human' AND NOT EXISTS(SELECT 1 FROM password_setup_states s WHERE s.principal_id=p.id))",
  "NOT EXISTS(SELECT 1 FROM memberships m WHERE NOT EXISTS(SELECT 1 FROM principal_project_records p WHERE p.principal_id=m.principal_id AND p.project_id=m.project_id))",
  "NOT EXISTS(SELECT 1 FROM api_grants g WHERE NOT EXISTS(SELECT 1 FROM credential_project_records c WHERE c.credential_id=g.credential_id AND c.project_id=g.project_id))",
  "NOT EXISTS(SELECT 1 FROM api_grants g JOIN api_credentials c ON c.id=g.credential_id WHERE NOT EXISTS(SELECT 1 FROM principal_project_records p WHERE p.principal_id=c.principal_id AND p.project_id=g.project_id))",
  ...names.map(n=>'(SELECT count(*) FROM '+identifier(n)+')='+counts[n])];
 const statements=[
  "SELECT CASE WHEN "+guards.join(' AND ')+" THEN 1 ELSE json('baseline adoption precondition failed') END AS baseline_guard;",
  ledgerSQL,
  'INSERT INTO "d1_migrations" (id,name) VALUES '+chain.migrations.slice(0,baselineCount).map((m,i)=>'('+(i+1)+','+literal(m.name)+')').join(',')+';',
  'SELECT id,name,applied_at FROM "d1_migrations" ORDER BY id;'
 ];
 return {format:1,status:'review-required-not-authorized',kind:'present-baseline-adoption',identity,baselineCount,migrations:chain.migrations.slice(0,baselineCount),pending:chain.migrations.slice(baselineCount).map(m=>m.name),schemaSha256:digest(s.objects),counts,gate,provenance,appliedAtMeaning:'Actual database CURRENT_TIMESTAMP at adoption, not historical DDL execution time.',historicalExecutionEstablished:false,allowedPermanentChanges:['Create official d1_migrations table','Insert exact IDs1–15 and canonical filenames at adoption time'],sql:statements.join('\n'),sqlSha256:digest(statements.join('\n')),writesPerformed:0};
}
