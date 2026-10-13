// @module verification
// @role db-baseline-adoption
// Disposable, synthetic local D1 only. Official Wrangler entrypoints exercise
// guarded missing-ledger adoption, rollback, no-op and the real pending suffix.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFile,readdir,writeFile,mkdtemp,mkdir,copyFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assess,expectedChain,snapshot } from "../../../scripts/schema/db-schema-preflight.mjs";
import { prepareBaselineAdoption,applicationTableNames } from "../../../scripts/schema/db-baseline-adoption.mjs";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"../../..");
const dir=await mkdtemp(tmpdir()+'/projektor-baseline-fixture-');
const out=process.env.BASELINE_EVIDENCE_DIR?resolve(process.env.BASELINE_EVIDENCE_DIR):dir+'/evidence';await mkdir(out,{recursive:true});
const migrations=(await readdir(root+'/migrations')).filter(n=>n.endsWith('.sql')).sort(),baseline=migrations.slice(0,15);
assert.equal(migrations[15],'0016_federated_agent_credentials.sql');assert.equal(migrations[16],'0017_operation_intents.sql');
const chain=await expectedChain(root+'/migrations');
await mkdir(dir+'/migrations');for(const name of baseline)await copyFile(root+'/migrations/'+name,dir+'/migrations/'+name);
const config={name:'projektor-baseline-isolated',compatibility_date:'2026-10-09',d1_databases:[{binding:'DB',database_name:'projektor-baseline-isolated',database_id:'00000000-0000-0000-0000-000000000001',migrations_dir:'./migrations',remote:false}]};
await writeFile(dir+'/wrangler.json',JSON.stringify(config));
const env={...process.env,HOME:dir+'/home',XDG_CONFIG_HOME:dir+'/home',WRANGLER_SEND_METRICS:'false', CLOUDFLARE_CF_FETCH_ENABLED:'false', WRANGLER_HIDE_BANNER:'true', WRANGLER_SEND_ERROR_REPORTS:'false',CI:'true'};
for(const key of ['CLOUDFLARE_API_TOKEN','CLOUDFLARE_API_KEY','CLOUDFLARE_EMAIL','CLOUDFLARE_ACCOUNT_ID','CF_API_TOKEN','CF_API_KEY','CF_EMAIL','CF_ACCOUNT_ID'])delete env[key];
let index=0;
async function wrangler(args,success=true){const commandIndex=args.indexOf('--command');if(commandIndex!==-1)args.splice(commandIndex,2,'--command='+args[commandIndex+1]);const r=spawnSync(process.execPath,['--require',root+'/tests/support/local-network-guard.cjs',root+'/node_modules/wrangler/bin/wrangler.js',...args,'--local','--config',dir+'/wrangler.json','--persist-to',dir+'/persist'],{cwd:dir,env:{...env,WRANGLER_LOG_PATH:out+'/wrangler-'+index+'.raw.log'},encoding:'utf8',maxBuffer:4*1024*1024});await writeFile(out+'/wrangler-'+index+++'.txt',r.stdout+r.stderr);if(success)assert.equal(r.status,0,r.stderr||r.stdout||String(r.error));else assert.notEqual(r.status,0);return r;}
async function getFile(){const base=dir+'/persist/v3/d1/miniflare-D1DatabaseObject';return base+'/'+(await readdir(base)).find(n=>n.endsWith('.sqlite')&&n!=='metadata.sqlite');}
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const ident=n=>'"'+n.replaceAll('"','""')+'"';
function read(db){const s=snapshot(db),names=applicationTableNames(s);return {snapshot:s,rows:Object.fromEntries(names.map(n=>[n,db.prepare('SELECT * FROM '+ident(n)).all().map(r=>JSON.stringify(r)).sort()])),counts:Object.fromEntries(names.map(n=>[n,db.prepare('SELECT count(*) AS n FROM '+ident(n)).get().n])),gate:db.prepare('SELECT mode,epoch FROM write_gate').get()};}
async function state(){const db=new DatabaseSync(await getFile(),{readOnly:true});try{return read(db);}finally{db.close();}}
const report={startedAt:new Date().toISOString(),scope:'isolated synthetic local D1',wrangler:JSON.parse(await readFile(root+'/node_modules/wrangler/package.json','utf8')).version,productionActions:0,checks:[]};
try{
 const seed=`
 INSERT INTO principals VALUES('BASELINE_AGENT','agent','Synthetic baseline agent',NULL,1,1);
 INSERT INTO memberships VALUES('BASELINE_AGENT','BASELINE_PROJECT','view');
 INSERT INTO issues(id,project_id,body,title,revision,created_at,updated_at,references_json) VALUES('BASELINE_ISSUE','BASELINE_PROJECT','Retained issue','Retained title',1,'2026-10-12T00:00:00Z','2026-10-12T00:00:00Z','[]');
 INSERT INTO content_documents(id,kind,scope_id,project_id,title,body,revision,created_at,updated_at,references_json) VALUES('BASELINE_WIKI','wiki','BASELINE_PROJECT','BASELINE_PROJECT','Retained wiki','Retained wiki body',1,'2026-10-12T00:00:00Z','2026-10-12T00:00:00Z','[]');
 INSERT INTO operation_results(principal_id,operation_id,operation_kind,target_id,project_id,input_hash,required_permissions,state,snapshot,created_at,confirmed_at) VALUES('BASELINE_AGENT','baseline-issue-create','issue.create','BASELINE_ISSUE','BASELINE_PROJECT','${'a'.repeat(64)}','["edit"]','confirmed','{"retained":true}',1,1),('BASELINE_AGENT','baseline-wiki-create','wiki.create','BASELINE_WIKI','BASELINE_PROJECT','${'b'.repeat(64)}','["edit"]','confirmed','{"retained":true}',1,1);
 INSERT INTO issue_history(issue_id,project_id,revision,operation_id,actor_id,actor_name,change_kind,before_body,after_body,created_at) VALUES('BASELINE_ISSUE','BASELINE_PROJECT',1,'baseline-issue-create','BASELINE_AGENT','Synthetic baseline agent','issue.create',NULL,'Retained issue','2026-10-12T00:00:00Z');
 INSERT INTO content_history(content_kind,content_id,scope_id,revision,operation_id,actor_id,actor_name,change_kind,before_body,after_body,created_at) VALUES('wiki','BASELINE_WIKI','BASELINE_PROJECT',1,'baseline-wiki-create','BASELINE_AGENT','Synthetic baseline agent','wiki.create',NULL,'Retained wiki body','2026-10-12T00:00:00Z');
 UPDATE write_gate SET mode='stopped',epoch=4 WHERE id=1;`;
 const setup=(await Promise.all(baseline.map(n=>readFile(root+'/migrations/'+n,'utf8')))).join('\n')+seed;
 await wrangler(['d1','execute','projektor-baseline-isolated','--command',setup]);
 const before=await state();assert.equal((await assess(before.snapshot,chain)).status,'stop');assert.deepEqual(before.snapshot.ledger,[]);report.checks.push('Actual populated canonical0001–0015 database has no ledger; ordinary preflight stops.');
 const plan=await prepareBaselineAdoption({...before,chain,identity:{accountId:'fixture-only',databaseId:config.d1_databases[0].database_id,observedAt:new Date().toISOString()},provenance:{sourceEvidence:'Synthetic DDL setup with exact current canonical source',dataEffectReview:'Fixture seed is synthetic; no historical production claim'}});
 await writeFile(out+'/fixture-proposal.json',JSON.stringify(plan,null,2));
 const run=sql=>wrangler(['d1','execute','projektor-baseline-isolated','--command',sql],false);
 const lateFailure=await run(plan.sql+"\nSELECT json('injected late transaction failure');");assert.match(lateFailure.stdout+lateFailure.stderr,/malformed JSON/);
 assert.deepEqual(await state(),before);report.checks.push('Late failure after CREATE + all15 ledger rows rolls back entire command, including ledger table.');
 const guardFailure=await run(plan.sql.replace("epoch=4)=1","epoch=999)=1"));assert.match(guardFailure.stdout+guardFailure.stderr,/malformed JSON/);assert.deepEqual(await state(),before);report.checks.push('Guard condition0 raises malformed-JSON error before CREATE; ledger remains absent and every row is unchanged.');
 const beforeTime=Math.floor(Date.now()/1000);
 await wrangler(['d1','execute','projektor-baseline-isolated','--command',plan.sql]);
 const adopted=await state();assert.deepEqual(adopted.rows,before.rows);assert.equal((await assess(adopted.snapshot,chain)).status,'ready');assert.deepEqual(adopted.snapshot.ledger.map(r=>r.name),baseline);
 for(const row of adopted.snapshot.ledger){const at=Date.parse(row.applied_at+'Z')/1000;assert.ok(at>=beforeTime&&at<=Math.ceil(Date.now()/1000));}
 report.checks.push('Metadata-only adoption preserves every synthetic application row; IDs1–15 use truthful current adoption timestamps.');
 await run(plan.sql);assert.deepEqual(await state(),adopted);report.checks.push('Replaying identical missing-ledger proposal fails closed without duplicate adoption.');
 const noop=await wrangler(['d1','migrations','apply','projektor-baseline-isolated']);assert.match(noop.stdout,/No migrations to apply/);assert.deepEqual(await state(),adopted);report.checks.push('Official Wrangler with frozen0001–0015 baseline is a true no-op.');
 for(const name of migrations.slice(15))await copyFile(root+'/migrations/'+name,dir+'/migrations/'+name);
 const listed=await wrangler(['d1','migrations','list','projektor-baseline-isolated']);assert.match(listed.stdout,/0016_federated_agent_credentials.sql/);assert.match(listed.stdout,/0017_operation_intents.sql/);assert.doesNotMatch(listed.stdout,/0001_auth.sql/);
 await wrangler(['d1','migrations','apply','projektor-baseline-isolated']);
 const after=await state();for(const [table,rows]of Object.entries(before.rows))assert.deepEqual(after.rows[table],rows);assert.deepEqual(after.gate,before.gate);assert.equal((await assess(after.snapshot,chain)).status,'current');assert.deepEqual(after.snapshot.ledger.map(r=>r.name),migrations);assert.deepEqual(after.snapshot.foreignKeyViolations,[]);
 report.checks.push('Official Wrangler lists/applies only0016/0017; old rows/histories/receipts/gate preserved; new application tables empty; exact final schema and ledger current.');
 for(const [n,rows]of Object.entries(after.rows))if(!(n in before.rows))assert.deepEqual(rows,[]);
 const finalNoop=await wrangler(['d1','migrations','apply','projektor-baseline-isolated']);assert.match(finalNoop.stdout,/No migrations to apply/);assert.deepEqual(await state(),after);
 report.beforeBusinessSha256=hash(before.rows);report.afterOriginalBusinessSha256=hash(Object.fromEntries(Object.keys(before.rows).map(n=>[n,after.rows[n]])));report.ledger=after.snapshot.ledger;report.passed=true;
}finally{report.finishedAt=new Date().toISOString();await writeFile(out+'/baseline-fixture-result.json',JSON.stringify(report,null,2));if(!process.env.BASELINE_KEEP_FIXTURE)await rm(dir,{recursive:true,force:true});}
console.log(JSON.stringify(report,null,2));
