// @module verification
// @role regression
// Actual SQLite evaluates owner policy SQL. No provider, credentials or network.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const out=resolve('.local/domain-policy');await mkdir(out,{recursive:true});
const inputs=['src/modules/change-outcomes.ts','src/modules/work/rules.ts','src/modules/work/public.ts','src/modules/work/application.ts','src/adapters/d1/work/adapter.ts','src/adapters/d1/work/recovery-policy.ts','src/adapters/d1/execution/recovery-policy.ts','src/adapters/d1/work/assembly.ts','src/adapters/d1/execution/assembly.ts','src/adapters/d1/work/issues.ts','src/adapters/d1/work/content.ts','src/adapters/d1/execution/lifecycle.ts','src/adapters/d1/execution/reports.ts','src/adapters/d1/work/lists.ts','src/adapters/d1/work/model.ts','src/adapters/d1/identity/authorization.ts'];
await build({stdin:{contents:`export {assembleWorkContent} from './src/adapters/d1/work/assembly'; export {assembleExecution} from './src/adapters/d1/execution/assembly'; export {workPermissions} from './src/modules/work/rules'; export {workPermissionSql,workRecovery} from './src/adapters/d1/work/recovery-policy'; export {sql} from './src/adapters/d1/persistence/transaction'; export {principalProjectionSql,activeViewMembersSql,currentViewScopesSql,currentCredentialSql,credentialCeilingSql} from './src/adapters/d1/identity/authorization';`,resolveDir:process.cwd()},outfile:out+'/policy.mjs',bundle:true,platform:'node',format:'esm',loader:{'.wasm':'binary'}});
const {assembleWorkContent,assembleExecution,workPermissions,workPermissionSql,workRecovery,sql,principalProjectionSql,activeViewMembersSql,currentViewScopesSql,currentCredentialSql,credentialCeilingSql}=await import(pathToFileURL(out+'/policy.mjs').href);
const db=new DatabaseSync(':memory:');db.exec(`CREATE TABLE issues(id TEXT,project_id TEXT,assignee_id TEXT);CREATE TABLE content_documents(id TEXT,scope_id TEXT,kind TEXT,parent_kind TEXT,parent_id TEXT);CREATE TABLE intent(operation_kind TEXT,project_id TEXT,target_id TEXT,operation_id TEXT,route_json TEXT,input_json TEXT,format_version INTEGER);`);
const read=q=>db.prepare('SELECT ('+q.text+') result').get(...q.values).result;
const row=Object.fromEntries(Object.entries({operationKind:'operation_kind',projectId:'project_id',targetId:'target_id',operationId:'operation_id',routeJson:'route_json',inputJson:'input_json',formatVersion:'format_version'}).map(([k,v])=>[k,sql('i.'+v)]));
const readRow=q=>db.prepare('SELECT ('+q.text+') result FROM intent i').get(...q.values).result;
let checks=0;
const equal=(a,b,label)=>{assert.deepEqual(a,b,label);checks++;};
const fields=['body','title','references','priority','schedule','parentId','typeId','assigneeId','state'];
for(let mask=0;mask<1<<fields.length;mask++){
 const input=Object.fromEntries(fields.filter((_,i)=>mask&(1<<i)).map(k=>[k,null]));
 const direct=['view',...workPermissions('issue.edit',input)].sort(),stored=JSON.parse(read(workPermissionSql(sql("'issue.edit'"),sql('?',JSON.stringify(input))))).sort();
 equal(stored,direct,'all field combinations including explicit null match current permission policy');
}
const auth={id:'ACTOR',kind:'agent',displayName:'Synthetic'},noDb={prepare(){throw Error('Unexpected database read');}};
const work=assembleWorkContent(noDb,auth),execution=assembleExecution(noDb,auth);
const issue='I_'+'1'.repeat(64),wiki='W_'+'2'.repeat(64),comment='C_'+'3'.repeat(64);
db.prepare('INSERT INTO issues VALUES(?,?,?)').run(issue,'P','ACTOR');db.prepare('INSERT INTO content_documents VALUES(?,?,?,?,?)').run(wiki,'P','wiki',null,null);
const cases=[
 {route:{kind:'issue',projectId:'P'},input:{operationId:'issue_create',body:'body'}},
 {route:{kind:'issue',projectId:'P',id:issue},input:{operationId:'issue_edit',revision:1,assigneeId:null,state:'Todo'}},
 {route:{kind:'wiki',projectId:'P'},input:{operationId:'wiki_create',body:''}},
 {route:{kind:'wiki',projectId:'P',id:wiki},input:{operationId:'wiki_edit',revision:1,body:''}},
 {route:{kind:'comment',projectId:'P',parentKind:'issue',parentId:issue},input:{operationId:'comment_create',body:'body'}},
 {route:{kind:'comment',projectId:'P',parentKind:'wiki',parentId:wiki,id:comment},input:{operationId:'comment_edit',revision:1,body:'body'}},
 {route:{kind:'execution',projectId:'P',issueId:issue,action:'acquire'},input:{operationId:'execute'}},
 {route:{kind:'report',projectId:'P',issueId:issue,action:'progress'},input:{operationId:'report',attemptId:'A_'+'4'.repeat(64),message:'progress'}}
];
for(const value of cases){
 const d=[...work.definitions,...execution.definitions].find(d=>d.routeTag===value.route.kind),p=await d.prepare(value),c=p.command;
 db.exec('DELETE FROM intent');db.prepare('INSERT INTO intent VALUES(?,?,?,?,?,?,?)').run(c.kind,c.projectId,c.targetId,c.operationId,JSON.stringify(p.route),JSON.stringify(p.input),1);
 const policy=d.recovery(row);
 equal(readRow(policy.supported),1,'supported normalized route');
 equal(readRow(policy.preparedVisible),read(p.adapter.visible(c)),'durable/direct target parity');
 equal(JSON.parse(readRow(policy.permissions)).sort(),['view',...p.adapter.permissions].sort(),'durable/direct current permission parity');
 if(c.kind.endsWith('.create')){
  if(c.kind==='issue.create')db.prepare('INSERT INTO issues VALUES(?,?,?)').run(c.targetId,'OTHER','ACTOR');
  else db.prepare('INSERT INTO content_documents VALUES(?,?,?,?,?)').run(c.targetId,'OTHER',value.route.kind,null,null);
  equal(readRow(policy.preparedVisible),0,'cross-scope conflict denied durably');equal(read(p.adapter.visible(c)),0,'same conflict denied directly');
  if(c.kind==='issue.create')db.prepare('DELETE FROM issues WHERE id=?').run(c.targetId);else db.prepare('DELETE FROM content_documents WHERE id=?').run(c.targetId);
 }
 equal(p.canonicalInputLimit,p.adapter.commandPolicy.canonicalMaxBytes,'one canonical command limit');
 equal(!!p.adapter.commandPolicy.certifyPreDispatchDenial,c.kind==='issue.create','only Issue create can certify pre-dispatch denial');
 db.prepare('UPDATE intent SET format_version=2').run();equal(readRow(policy.supported),1,'retained future format stays discoverable under known route policy; execution is separately blocked');db.prepare('UPDATE intent SET format_version=1,route_json=json_set(route_json,\'$.unexpected\',1)').run();equal(readRow(policy.supported),0,'extra route field denied');
}
for(const tag of ['issue','wiki','comment']){const p=workRecovery(tag,row);db.prepare("UPDATE intent SET operation_kind='unknown',route_json='{}'").run();equal(readRow(p.supported),0,'unknown operation kind denied');}
for(const [call,label]of [
 [()=>work.api.listIssues({projectId:'P',query:{q:'',state:'',mine:true,page:0,pageSize:20,order:'priority'}}),'typed issue query cannot bypass validation'],
 [()=>work.api.listContent({projectId:'P',resource:{kind:'wiki'},page:1,pageSize:100}),'typed content query cannot bypass validation'],
 [()=>work.api.changeContent({projectId:'P',resource:{kind:'wiki'},id:'',input:{operationId:'bad',revision:1,body:''}}),'empty content ID rejected'],
 [()=>execution.api.change({projectId:'P',issueId:issue,action:'bogus',input:{operationId:'bad'}}),'unknown execution action denied']
]){equal((await call()).failure.code,'invalid_input',label);}
// The existing SQLite fixture now checks the moved Identity reads against their old SQL.
db.exec(`CREATE TABLE principals(id TEXT PRIMARY KEY,kind TEXT,display_name TEXT,active INTEGER,auth_version INTEGER);
CREATE TABLE memberships(principal_id TEXT,project_id TEXT,permission TEXT);
CREATE TABLE api_credentials(id TEXT,principal_id TEXT,token_hash TEXT,expires_at INTEGER,revoked_at INTEGER);
CREATE TABLE api_grants(credential_id TEXT,project_id TEXT,permission TEXT);
INSERT INTO principals VALUES('ACTOR','agent','Actor',1,1),('ACTIVE','human','Candidate',1,1),('INACTIVE','human','Inactive',0,1);
INSERT INTO memberships VALUES('ACTOR','P','view'),('ACTOR','Q','view'),('ACTIVE','P','view'),('INACTIVE','P','view'),('MISSING','P','view');
INSERT INTO api_credentials VALUES('KEY','ACTOR','synthetic-hash',unixepoch()+3600,NULL);
INSERT INTO api_grants VALUES('KEY','P','view');`);
const identityAuth={...auth,authentication:'api',auth_version:1,credential_id:'KEY',token_hash:'synthetic-hash'};
const sqliteDb={prepare(text){return{bind(...values){return{async first(){return db.prepare(text).get(...values)??null;}};}};}};
const bound=assembleWorkContent(sqliteDb,identityAuth).api;
const rows=q=>db.prepare(q.text).all(...q.values).map(r=>({...r}));
const oldCandidates=sql(`SELECT p.id,p.kind,p.display_name,p.active FROM principals p WHERE p.active=1 AND EXISTS(SELECT 1 FROM memberships m WHERE m.principal_id=p.id AND m.project_id=? AND m.permission='view')`,'P');
const compareCandidates=()=>equal(rows(activeViewMembersSql(sql('?','P'))),rows(oldCandidates),'Identity owner projection equals old eligible candidates');
compareCandidates();equal((await bound.listAssignees({projectId:'P'})).value.principals.map(p=>p.id),['ACTOR','ACTIVE'],'inactive and missing principals excluded by actual guarded Work read');
for(const id of ['ACTIVE','INACTIVE','MISSING']){
 equal(rows(sql(`SELECT p.id,p.display_name,p.active FROM (${principalProjectionSql().text}) p WHERE p.id=?`,id)),rows(sql('SELECT p.id,p.display_name,p.active FROM principals p WHERE p.id=?',id)),'history/display projection preserves inactive and missing principal semantics');
}
const compareScopes=()=>{const credential=currentCredentialSql(identityAuth),ceiling=credentialCeilingSql(identityAuth,sql('m.project_id'),sql('m.permission'));const old=sql(`SELECT m.project_id scope FROM memberships m WHERE m.principal_id=? AND m.permission='view' AND (${credential.text}) AND (${ceiling.text})`,identityAuth.id,...credential.values,...ceiling.values);equal(rows(currentViewScopesSql(identityAuth)),rows(old),'current membership and credential ceiling remain in one query');};
compareScopes();equal(rows(currentViewScopesSql(identityAuth)),[{scope:'P'}],'credential scope ceiling excludes Q');
db.exec("DELETE FROM memberships WHERE principal_id='ACTIVE'");compareCandidates();equal((await bound.listAssignees({projectId:'P'})).value.principals.map(p=>p.id),['ACTOR'],'removed membership disappears immediately');
db.exec("DELETE FROM api_grants WHERE project_id='P'");compareScopes();equal(rows(currentViewScopesSql(identityAuth)),[],'removed credential grant hides scope');equal((await bound.listAssignees({projectId:'P'})).failure.code,'forbidden','current grant revocation is denied');
db.exec("INSERT INTO api_grants VALUES('KEY','P','view');UPDATE principals SET active=0 WHERE id='ACTOR'");compareScopes();equal((await bound.listAssignees({projectId:'P'})).failure.code,'unauthenticated','inactive or missing actor is denied');
db.exec("DELETE FROM principals WHERE id='ACTOR'");compareScopes();equal((await bound.listAssignees({projectId:'P'})).failure.code,'unauthenticated','inactive or missing actor is denied');
db.close();const report={status:'passed',checks,runtime:'Node SQLite, exact owner SQL and normalized direct plans',externalRequests:0,productionActions:0,sourceHashes:Object.fromEntries(await Promise.all(inputs.map(async p=>[p,createHash('sha256').update(await readFile(p)).digest('hex')])))};await writeFile(out+'/result.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
