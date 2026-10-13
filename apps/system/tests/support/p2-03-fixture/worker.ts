import {createRequestServices} from "../../../src/apps/composition";
// @module verification
// @role fixture-p2-03
// Synthetic control entrypoint; never included in the product Worker or shared DB.
import { authenticate } from '../identity-fixture';
import { digest,randomToken } from "../../../src/adapters/crypto/passwords";
import type {AuthDB} from "../../../src/adapters/d1/primitives";
import type {Authenticated} from "../../../src/adapters/d1/identity/authorization";
import {executeMutation,readMutationResult} from "../../../src/adapters/d1/persistence/transaction";
import {MutationError} from "../../../src/adapters/d1/persistence/public";
import {decideIssueChange,needsIssueState} from "../../../src/modules/work/decisions";
import {decodeIssueChange} from "../../../src/modules/work/public";
import { prepareIssue,readIssuePlanningState,getIssue,getIssueHistory,readIssueResult,issuePolicies } from "../../../src/adapters/d1/work/issues";
import { issueApi } from "../../../src/apps/http/issue";
import { ApiError } from "../../../src/adapters/protocol-errors";
type Fixture={prefix:string;ids:Record<string,string>;keys:Record<string,string>};
async function fresh(db:AuthDB){
  const prefix=`i-${crypto.randomUUID()}-`,labels=['editor','other','viewer','no-view','global','human'];
  const ids=Object.fromEntries(labels.map(l=>[l,prefix+l])),keys=Object.fromEntries(labels.filter(l=>l!=='human').map(l=>[l,ids[l]+'-key']));
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO workspaces(id,name,source_json) VALUES('p2-03-workspace','Synthetic P2-03','{}')"),
    ...['P','Q'].map(project=>db.prepare("INSERT OR IGNORE INTO projects(id,workspace_id,key,slug,name,description,source_json) VALUES(?,'p2-03-workspace',?,?,?,'Synthetic P2-03','{}')").bind(project,project,project,project)),
    db.prepare('CREATE TABLE IF NOT EXISTS issue_fixture_cases(id TEXT PRIMARY KEY,data TEXT NOT NULL)'),
    db.prepare(`CREATE TRIGGER IF NOT EXISTS issue_fixture_history_failure BEFORE INSERT ON issue_history WHEN NEW.operation_id='history-fail'
      BEGIN SELECT RAISE(ABORT,'synthetic history constraint');END`),
    db.prepare(`CREATE TRIGGER IF NOT EXISTS issue_fixture_result_failure BEFORE UPDATE ON operation_results WHEN NEW.operation_id='result-fail' AND NEW.state='confirmed'
      BEGIN SELECT RAISE(ABORT,'synthetic result constraint');END`),
    db.prepare(`CREATE TRIGGER IF NOT EXISTS issue_fixture_zero_update BEFORE UPDATE ON issues
      WHEN NEW.body='synthetic-ignore-update' BEGIN SELECT RAISE(IGNORE);END`),
    db.prepare(`CREATE TRIGGER IF NOT EXISTS issue_fixture_zero_history BEFORE INSERT ON issue_history
      WHEN NEW.operation_id='history-zero' BEGIN SELECT RAISE(IGNORE);END`),
  ]);
  await db.batch(labels.map(l=>db.prepare('INSERT INTO principals(id,kind,display_name,login_id,active,auth_version) VALUES(?,?,?,?,1,1)').bind(ids[l],l==='human'?'human':'agent',l,l==='human'?ids[l]:null)));
  await db.prepare('UPDATE principal_management SET global_administrator=1 WHERE principal_id=?').bind(ids.global).run();
  const tokens:Record<string,string>={};
  for(const [l,key]of Object.entries(keys)){tokens[l]=randomToken();await db.prepare('INSERT INTO api_credentials(id,principal_id,token_hash,expires_at,revoked_at) VALUES(?,?,?,unixepoch()+3600,NULL)').bind(key,ids[l],await digest(tokens[l])).run();}
  for(const l of ['editor','other','viewer','no-view','human'])for(const project of ['P','Q']){
    const perms=l==='viewer'?['view']:l==='no-view'?['edit']:['view','edit'];
    await db.batch(perms.flatMap(p=>[db.prepare('INSERT INTO memberships VALUES(?,?,?)').bind(ids[l],project,p),
      ...(keys[l]?[db.prepare('INSERT INTO api_grants VALUES(?,?,?)').bind(keys[l],project,p)]:[])]));
  }
  const session=randomToken(),csrf=randomToken();
  await db.prepare('INSERT INTO sessions(token_hash,principal_id,auth_version,api_credential_id,csrf_token,created_at,last_seen_at,absolute_expires_at,revoked_at) VALUES(?,?,1,NULL,?,unixepoch(),unixepoch(),unixepoch()+3600,NULL)').bind(await digest(session),ids.human,csrf).run();
  await db.prepare('INSERT INTO issue_fixture_cases VALUES(?,?)').bind(prefix,JSON.stringify({prefix,ids,keys})).run();
  return {caseId:prefix,ids,keys,tokens,session,csrf};
}
async function fixture(db:AuthDB,id:string):Promise<Fixture>{
  const r=await db.prepare('SELECT data FROM issue_fixture_cases WHERE id=?').bind(id).first<{data:string}>();
  if(!r)throw new Error('Unknown synthetic case');return JSON.parse(r.data) as Fixture;
}
async function fault(db:AuthDB,auth:Authenticated,f:Fixture,action?:string,target?:string){
  if(!action)return;
  if(action==='edit')await db.prepare("DELETE FROM memberships WHERE principal_id=? AND project_id='P' AND permission='edit'").bind(auth.id).run();
  else if(action==='view')await db.prepare("DELETE FROM memberships WHERE principal_id=? AND project_id='P' AND permission='view'").bind(auth.id).run();
  else if(action==='membership')await db.prepare("DELETE FROM memberships WHERE principal_id=? AND project_id='P'").bind(auth.id).run();
  else if(action==='scope')await db.prepare("DELETE FROM api_grants WHERE credential_id=? AND project_id='P' AND permission='edit'").bind(auth.credential_id).run();
  else if(action==='scope-view')await db.prepare("DELETE FROM api_grants WHERE credential_id=? AND project_id='P' AND permission='view'").bind(auth.credential_id).run();
  else if(action==='credential')await db.prepare('UPDATE api_credentials SET revoked_at=unixepoch() WHERE id=?').bind(auth.credential_id).run();
  else if(action==='expiry')await db.prepare('UPDATE api_credentials SET expires_at=unixepoch() WHERE id=?').bind(auth.credential_id).run();
  else if(action==='principal')await db.prepare('UPDATE principals SET active=0 WHERE id=?').bind(auth.id).run();
  else if(action==='session-idle')await db.prepare('UPDATE sessions SET last_seen_at=unixepoch()-2592000 WHERE token_hash=?').bind(auth.token_hash).run();
  else if(action==='session-absolute')await db.prepare('UPDATE sessions SET absolute_expires_at=unixepoch() WHERE token_hash=?').bind(auth.token_hash).run();
  else if(action==='session')await db.prepare('UPDATE sessions SET revoked_at=unixepoch() WHERE principal_id=?').bind(auth.id).run();
  else if(action==='auth-version')await db.prepare('UPDATE principals SET auth_version=auth_version+1 WHERE id=?').bind(auth.id).run();
  else if(action==='rename')await db.prepare('UPDATE principals SET display_name=? WHERE id=?').bind('changed editor',f.ids.editor).run();
  else if(action==='tamper-history')await db.prepare("UPDATE issue_history SET actor_name='changed' WHERE issue_id=?").bind(target).run();
  else if(action==='delete-history')await db.prepare('DELETE FROM issue_history WHERE issue_id=?').bind(target).run();
  else if(action==='move')await db.prepare("UPDATE issues SET project_id='Q' WHERE id=?").bind(target).run();
  else if(action==='change-id')await db.prepare("UPDATE issues SET id='changed' WHERE id=?").bind(target).run();
  else if(action==='change-created')await db.prepare("UPDATE issues SET created_at='2000-01-01T00:00:00.000Z' WHERE id=?").bind(target).run();
  else throw new Error('Unknown synthetic action');
}
export default {
  async fetch(request,env){
    const db=env.DB.withSession('first-primary'),url=new URL(request.url),json=(b:unknown,s=200)=>Response.json(b,{status:s,headers:{'Cache-Control':'no-store'}});
    try{
      const api=await issueApi(request,createRequestServices(db,Math.floor(Date.now()/1000)),url.origin);if(api)return api;
      if(url.pathname==='/fixture/new')return json(await fresh(db));
      if(url.pathname==='/fixture/state'){
        const f=await fixture(db,url.searchParams.get('case')??'');
        const result=await db.batch([
          db.prepare('SELECT * FROM issues WHERE id IN(SELECT target_id FROM operation_results WHERE principal_id LIKE ?) ORDER BY id').bind(f.prefix+'%'),
          db.prepare('SELECT * FROM issue_history WHERE actor_id LIKE ? ORDER BY issue_id,revision').bind(f.prefix+'%'),
          db.prepare('SELECT * FROM operation_results WHERE principal_id LIKE ? ORDER BY principal_id,operation_id').bind(f.prefix+'%'),
          db.prepare('SELECT * FROM mutation_guards'),
        ]);return json(Object.fromEntries(['issues','history','operations','guards'].map((n,i)=>[n,result[i].results])));
      }
      const auth=await authenticate(request,db,Math.floor(Date.now()/1000));
      const v=await request.json<{caseId:string;projectId?:string;issueId?:string;input?:unknown;fault?:string;read?:string}>();
      const f=await fixture(db,v.caseId);
      if(url.pathname==='/fixture/read-legacy')return json({snapshot:await readMutationResult(db,auth,String(v.input),issuePolicies(v.projectId??'P'))});
      if(url.pathname==='/fixture/control'){await fault(db,auth,f,v.fault,v.issueId);return json({ok:true});}
      if(url.pathname==='/fixture/after-auth-read'){
        await fault(db,auth,f,v.fault,v.issueId);
        return json(v.read==='history'?await getIssueHistory(db,auth,v.projectId??'P',v.issueId!,0,20)
          :v.read==='result'?await readIssueResult(db,auth,v.projectId??'P',String(v.input))
          :{issue:await getIssue(db,auth,v.projectId??'P',v.issueId!)});
      }
      if(url.pathname==='/fixture/mutate'){
        const command=decodeIssueChange(v.projectId??'P',v.issueId,v.input);
        const decision=decideIssueChange(command,needsIssueState(command)?await readIssuePlanningState(db,auth,command):undefined);
        if(decision.kind==='reject')throw new MutationError(409,'precondition_conflict',decision.reason);
        const p=await prepareIssue(auth,command,decision.plan);
        await fault(db,auth,f,v.fault,v.issueId);
        return json(await executeMutation(db,auth,p.command,p.adapter,p.policyFor));
      }
      return json({error:'not_found'},404);
    }catch(e){
      if(e instanceof ApiError)return json({error:e.code,fields:e.fields},e.status);
      if(e instanceof MutationError)return json({error:e.code,...(e.reason?{reason:e.reason}:{}),...(e.current!==undefined?{current:e.current}:{})},e.status);
      return json({error:'fixture_unavailable'},503);
    }
  }
} satisfies ExportedHandler<Env>;
