// @module verification
// @role work-read-sql-regression
// Actual SQLite + current migrations verify the adapter boundary. This is not hosted D1 proof.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';
import {mkdir,readdir,readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const out=resolve('.local/work-read-sql');await mkdir(out,{recursive:true});
const bundled=await build({stdin:{contents:`export {assembleWorkContent} from './src/adapters/d1/work/assembly';export {decodeLegacyReference} from './src/modules/work/public';`,resolveDir:process.cwd()},outfile:out+'/work.mjs',bundle:true,platform:'node',format:'esm',metafile:true});
const {assembleWorkContent,decodeLegacyReference}=await import(pathToFileURL(out+'/work.mjs').href);
const db=new DatabaseSync(':memory:');for(const p of (await readdir('migrations')).filter(p=>p.endsWith('.sql')).sort())db.exec(await readFile('migrations/'+p,'utf8'));
// Synthetic values; no account or business record is read.
db.exec(`INSERT INTO workspaces VALUES('W','Work','{}'),('X','Other','{}');
INSERT INTO projects VALUES('P','W','PRJ','same','Project','','{}'),('Q','X','PRJ','same','Hidden','','{}');
INSERT INTO principals(id,kind,display_name,active,auth_version) VALUES('ACTOR','agent','Actor',1,1);
INSERT INTO api_credentials(id,principal_id,token_hash,expires_at) VALUES('KEY','ACTOR','synthetic-hash',unixepoch()+3600);
INSERT INTO memberships VALUES('ACTOR','P','view');INSERT INTO api_grants VALUES('KEY','P','view');`);
const id='I_'+'1'.repeat(64),hidden='I_'+'2'.repeat(64),absent='I_'+'3'.repeat(64),wiki='W_'+'4'.repeat(64);
for(const [key,project]of [[id,'P'],[hidden,'Q']])db.prepare("INSERT INTO issues(id,project_id,body,revision,number,created_at,updated_at) VALUES(?,?,?,1,12,'2026-10-12T00:00:00.000Z','2026-10-12T00:00:00.000Z')").run(key,project,'private '+project);
db.prepare("INSERT INTO content_documents(id,kind,scope_id,body,revision,created_at,updated_at) VALUES(?,'wiki','P','body',1,'2026-10-12T00:00:00.000Z','2026-10-12T00:00:00.000Z')").run(wiki);
const adapter={prepare(text){return {bind(...values){return {async first(){return db.prepare(text).get(...values)??null;},async all(){return {results:db.prepare(text).all(...values)};}};}};}};
const auth={id:'ACTOR',kind:'agent',displayName:'Actor',authentication:'api',auth_version:1,credential_id:'KEY',token_hash:'synthetic-hash'},work=assembleWorkContent(adapter,auth).api;
let checks=0;const equal=(a,b,label)=>{assert.deepEqual(a,b,label);checks++;};
equal((await work.getIssue({projectId:'P',issueId:id})).value.body,'private P','authorized Issue returned');
equal((await work.getIssue({projectId:'P',issueId:absent})).status,'not_found','authorized absent Issue distinguished');
equal((await work.getIssue({projectId:'Q',issueId:hidden})).status,'denied','other project data denied');
equal((await work.getContent({projectId:'P',resource:{kind:'wiki'},id:wiki})).status,'value','authorized content returned');
equal((await work.getContent({projectId:'P',resource:{kind:'wiki'},id:'W_'+'0'.repeat(64)})).status,'not_found','authorized absent content distinguished');
const missing=await work.issueResult({projectId:'P',operationId:'missing'});equal([missing.status,missing.application],['missing','unknown'],'missing receipt never proves nonapplication');
equal((await work.contentResult({projectId:'P',resource:{kind:'wiki'},operationId:'missing'})).status,'missing','Content uses same receipt distinction');
const legacy=decodeLegacyReference('/projects/PRJ/issues/12/old-title');equal((await work.resolveLegacy(legacy)).value.id,id,'hidden duplicate does not cause ambiguity');
db.exec("INSERT INTO memberships VALUES('ACTOR','Q','view');INSERT INTO api_grants VALUES('KEY','Q','view');");equal((await work.resolveLegacy(legacy)).status,'conflict','two currently authorized legacy targets are ambiguous');
db.exec("DELETE FROM api_grants WHERE project_id='Q';DELETE FROM memberships WHERE project_id='P';");
equal((await work.getIssue({projectId:'P',issueId:id})).status,'denied','current revocation rejects existing body');
equal((await work.issueResult({projectId:'P',operationId:'missing'})).status,'denied','current revocation takes precedence over missing receipt');
equal((await work.resolveLegacy(legacy)).status,'not_found','inaccessible legacy candidates disclose no ambiguity');
db.exec("UPDATE api_credentials SET revoked_at=unixepoch()");equal((await work.resolveLegacy(legacy)).failure.kind,'unauthenticated','credential checked even with no visible legacy match');
equal((await work.getIssue({projectId:'P',issueId:absent})).failure.kind,'unauthenticated','invalid credential does not reveal absence');
db.close();const inputs=Object.keys(bundled.metafile.inputs).filter(p=>p!=='<stdin>');const report={status:'passed',checks,runtime:'Node24 SQLite actual current schema and adapter queries',providerRequests:0,hostedD1:false,sourceHashes:Object.fromEntries(await Promise.all(inputs.map(async p=>[p,createHash('sha256').update(await readFile(p)).digest('hex')])))};await writeFile(out+'/result.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,checks,runtime:report.runtime}));
