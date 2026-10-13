import {createRequestServices} from "../../../src/apps/composition";
// @module verification
// @role fixture-p2-02
// P2-02 test-only entrypoint. Each case appends its own synthetic namespace; audit is never cleared.
import { authenticate } from '../identity-fixture';
import { digest, randomToken } from "../../../src/adapters/crypto/passwords";
import type {AuthDB} from "../../../src/adapters/d1/primitives";
import type {Authenticated} from "../../../src/adapters/d1/identity/authorization";
import {PERMISSIONS,isPermission} from "../../../src/modules/identity/public";
import {requirePermission} from "../../../src/adapters/d1/identity/authorization";
import {displayPrincipal} from "../../../src/adapters/d1/identity/permissions";
import { readManagementForChange,executeManagement,readManagementResult } from "../../../src/adapters/d1/identity/management";
import {parseManagementCommand,planManagement} from "../../../src/modules/identity/rules";
import {MutationError} from "../../../src/adapters/d1/persistence/public";
import {protocolFailure} from "../../../src/apps/http/outcomes";
import { managementApi } from "../../../src/apps/http/management";

interface FixtureCase {prefix:string;ids:Record<string,string>}
async function newCase(db: AuthDB) {
  const prefix=`f-${crypto.randomUUID()}-`;
  const labels=['global','local-global','all-project','project','global-no-project','target-human','target-agent','old','outsider',...PERMISSIONS.map(p=>`cap-${p}`)];
  const ids=Object.fromEntries(labels.map(label=>[label,prefix+label]));
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS fixture_cases(id TEXT PRIMARY KEY,data TEXT NOT NULL)'),
    db.prepare(`CREATE TRIGGER IF NOT EXISTS fixture_audit_fail BEFORE INSERT ON management_audit
      WHEN NEW.operation_id='rollback-audit' BEGIN SELECT RAISE(ABORT,'synthetic audit constraint'); END`),
    db.prepare(`CREATE TRIGGER IF NOT EXISTS fixture_result_fail BEFORE UPDATE ON operation_results
      WHEN NEW.operation_id='rollback-result' AND NEW.state='confirmed' BEGIN SELECT RAISE(ABORT,'synthetic result constraint'); END`),
  ]);
  await db.batch([
    db.prepare('INSERT INTO fixture_cases VALUES(?,?)').bind(prefix,JSON.stringify({prefix,ids})),
    ...labels.map(label=>db.prepare('INSERT INTO principals(id,kind,display_name,login_id,active,auth_version) VALUES(?,?,?,?,?,1)')
      .bind(ids[label],['target-human','old','outsider'].includes(label)?'human':'agent',label,
        ['target-human','old','outsider'].includes(label)?ids[label]:null,label==='old'?0:1)),
    ...['global','local-global','global-no-project'].map(label=>db.prepare('UPDATE principal_management SET global_administrator=1 WHERE principal_id=?').bind(ids[label])),
  ]);
  const credentials: Record<string,string>={};
  for(const label of labels.filter(l=>!['target-human','old','outsider'].includes(l)))credentials[label]=randomToken();
  const keyStatements=[];
  for(const [label,token] of Object.entries(credentials))keyStatements.push(db.prepare('INSERT INTO api_credentials VALUES(?,?,?,unixepoch()+3600,NULL)')
    .bind(ids[label]+'-key',ids[label],await digest(token)));
  await db.batch(keyStatements);
  const grants: {label:string;project:string;permissions:readonly string[]}[]=[
    {label:'global',project:'P',permissions:PERMISSIONS},{label:'global',project:'Q',permissions:PERMISSIONS},
    {label:'all-project',project:'P',permissions:PERMISSIONS},{label:'all-project',project:'Q',permissions:PERMISSIONS},
    {label:'local-global',project:'P',permissions:['view','manage']},{label:'project',project:'P',permissions:['view','manage']},
    {label:'target-human',project:'P',permissions:['view','edit','manage']},{label:'target-agent',project:'P',permissions:['view','edit']},
    ...PERMISSIONS.map(p=>({label:`cap-${p}`,project:'P',permissions:[...new Set(['view',p])]})),
  ];
  await db.batch(grants.flatMap(g=>g.permissions.flatMap(permission=>[
    db.prepare('INSERT INTO memberships VALUES(?,?,?)').bind(ids[g.label],g.project,permission),
    ...(credentials[g.label]?[db.prepare('INSERT INTO api_grants VALUES(?,?,?)').bind(ids[g.label]+'-key',g.project,permission)]:[]),
  ])));
  const human=randomToken(),old=randomToken(),outsider=randomToken(),csrf=randomToken();
  await db.batch([
    db.prepare('INSERT INTO principal_project_records(principal_id,project_id) VALUES(?,?)').bind(ids.old,'P'),
  ]);
  for(const [label,token] of [['target-human',human],['old',old],['outsider',outsider]])
    await db.prepare('INSERT INTO sessions(token_hash,principal_id,auth_version,api_credential_id,csrf_token,created_at,last_seen_at,absolute_expires_at,revoked_at) VALUES(?,?,1,NULL,?,unixepoch(),unixepoch(),unixepoch()+3600,NULL)')
      .bind(await digest(token),ids[label],csrf).run();
  return {caseId:prefix,ids,keys:Object.fromEntries(Object.keys(credentials).map(label=>[label,ids[label]+'-key'])),
    tokens:credentials,sessions:{human,old,outsider},csrf};
}
async function caseRow(db: AuthDB,id: string): Promise<FixtureCase> {
  const row=await db.prepare('SELECT data FROM fixture_cases WHERE id=?').bind(id).first<{data:string}>();
  if(!row)throw new Error('Unknown synthetic case');return JSON.parse(row.data) as FixtureCase;
}
async function fault(db: AuthDB,auth: Authenticated,fixture:FixtureCase,action?:string) {
  if(!action)return;
  const ids=fixture.ids;
  if(action==='manage')await db.prepare("DELETE FROM memberships WHERE principal_id=? AND project_id='P' AND permission='manage'").bind(auth.id).run();
  else if(action==='membership')await db.prepare("DELETE FROM memberships WHERE principal_id=? AND project_id='P'").bind(auth.id).run();
  else if(action==='scope')await db.prepare("DELETE FROM api_grants WHERE credential_id=? AND project_id='P' AND permission='manage'").bind(auth.credential_id).run();
  else if(action==='credential')await db.prepare('UPDATE api_credentials SET revoked_at=unixepoch() WHERE id=?').bind(auth.credential_id).run();
  else if(action==='expiry')await db.prepare('UPDATE api_credentials SET expires_at=unixepoch() WHERE id=?').bind(auth.credential_id).run();
  else if(action==='principal')await db.prepare('UPDATE principals SET active=0 WHERE id=?').bind(auth.id).run();
  else if(action==='administrator')await db.prepare('UPDATE principal_management SET global_administrator=0 WHERE principal_id=?').bind(auth.id).run();
  else if(action==='project-expand')await db.prepare("INSERT INTO memberships VALUES(?,'Q','view')").bind(ids['target-human']).run();
  else if(action==='key-expand')await db.prepare("INSERT INTO api_grants VALUES(?,'Q','view')").bind(ids['target-agent']+'-key').run();
  else if(action==='target-change')await db.prepare('UPDATE principals SET display_name=? WHERE id=?').bind('concurrent-name',ids['target-human']).run();
  else if(action==='target-disable')await db.prepare('UPDATE principals SET active=0 WHERE id=?').bind(ids['target-human']).run();
  else if(action==='target-key-revoke')await db.prepare('UPDATE api_credentials SET revoked_at=unixepoch() WHERE id=?').bind(ids['target-agent']+'-key').run();
  else if(action==='target-key-expire')await db.prepare('UPDATE api_credentials SET expires_at=unixepoch() WHERE id=?').bind(ids['target-agent']+'-key').run();
  else if(action==='target-agent-disable')await db.prepare('UPDATE principals SET active=0 WHERE id=?').bind(ids['target-agent']).run();
  else if(action==='q-scope')await db.prepare("DELETE FROM api_grants WHERE credential_id=? AND project_id='Q' AND permission='manage'").bind(auth.credential_id).run();
  else throw new Error('Unknown fixture action');
}
export default {
  async fetch(request,env) {
    const db=env.DB.withSession('first-primary'),url=new URL(request.url);
    const response=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
    try {
      const api=await managementApi(request,createRequestServices(db,Math.floor(Date.now()/1000)),new URL(request.url).origin);if(api)return api;
      if(url.pathname==='/fixture/new'&&request.method==='POST')return response(await newCase(db));
      if(url.pathname==='/fixture/backfill'){
        const queries=["SELECT * FROM principal_management WHERE principal_id='legacy-agent'","SELECT * FROM principal_project_records WHERE principal_id='legacy-agent'",
          "SELECT * FROM credential_management WHERE credential_id='legacy-key'","SELECT * FROM credential_project_records WHERE credential_id='legacy-key'",
          "SELECT * FROM memberships WHERE principal_id='legacy-agent'","SELECT * FROM api_grants WHERE credential_id='legacy-key'"];
        return response((await db.batch(queries.map(q=>db.prepare(q)))).map(r=>r.results));
      }
      if(url.pathname==='/fixture/state'){
        const f=await caseRow(db,url.searchParams.get('case')??'');
        const targetIds=[f.ids['target-human'],f.ids['target-agent'],f.ids.old,f.ids.outsider];
        const queries=[
          db.prepare('SELECT * FROM principals WHERE id IN (?,?,?,?) ORDER BY id').bind(...targetIds),
          db.prepare('SELECT * FROM principal_management WHERE principal_id IN (?,?,?,?) ORDER BY principal_id').bind(...targetIds),
          db.prepare('SELECT * FROM principal_project_records WHERE principal_id IN (?,?,?,?) ORDER BY 1,2').bind(...targetIds),
          db.prepare('SELECT * FROM memberships WHERE principal_id IN (?,?,?,?) ORDER BY 1,2,3').bind(...targetIds),
          db.prepare('SELECT id,principal_id,expires_at,revoked_at FROM api_credentials WHERE principal_id=?').bind(f.ids['target-agent']),
          db.prepare('SELECT * FROM credential_management WHERE credential_id=?').bind(f.ids['target-agent']+'-key'),
          db.prepare('SELECT * FROM api_grants WHERE credential_id=? ORDER BY 1,2,3').bind(f.ids['target-agent']+'-key'),
          db.prepare('SELECT * FROM management_audit WHERE actor_id LIKE ? ORDER BY 1,2').bind(f.prefix+'%'),
          db.prepare('SELECT * FROM operation_results WHERE principal_id LIKE ? ORDER BY 1,2').bind(f.prefix+'%'),
          db.prepare('SELECT * FROM mutation_guards'),
        ];
        const names=['principals','principalManagement','projectRecords','memberships','credentials','credentialManagement','grants','audit','operations','guards'];
        const results=await db.batch(queries);return response(Object.fromEntries(names.map((name,i)=>[name,results[i].results])));
      }
      if(url.pathname==='/fixture/member-count')return response({count:(await db.prepare('SELECT COUNT(*) AS n FROM memberships').first<{n:number}>())?.n});
      const auth=await authenticate(request,db,Math.floor(Date.now()/1000));
      if(url.pathname==='/fixture/who')return response({id:auth.id,kind:auth.kind,credentialId:auth.credential_id});
      if(url.pathname==='/fixture/permission'){
        const permission=url.searchParams.get('permission');if(!isPermission(permission))throw new MutationError(400,'invalid_permission');
        await requirePermission(db,auth,url.searchParams.get('project')??'',permission);return response({allowed:true});
      }
      if(url.pathname==='/fixture/display')return response(await displayPrincipal(db,auth,url.searchParams.get('project')??'',url.searchParams.get('id')??''));
      if(url.pathname==='/fixture/result')return response({snapshot:await readManagementResult(db,auth,url.searchParams.get('id')??'')});
      if(url.pathname==='/fixture/control'&&request.method==='POST'){
        const body:{caseId:string;action:string}=await request.json();await fault(db,auth,await caseRow(db,body.caseId),body.action);return response({ok:true});
      }
      if(url.pathname==='/fixture/manage'&&request.method==='POST'){
        const body:{caseId:string;command:unknown;fault?:string}=await request.json();
        const command=parseManagementCommand(body.command),read=await readManagementForChange(db,auth,command);
        if(read.kind==='outcome'){
          await fault(db,auth,await caseRow(db,body.caseId),body.fault); // Receipt disclosure also gets the post-inspection fault.
          const recovered=await readManagementForChange(db,auth,command);if(recovered.kind!=='outcome')throw new Error('fixture recovery lost');
          const o=recovered.outcome;if(o.application==='confirmed')return response({snapshot:o.receipt.snapshot,source:o.source});
          const status=o.failure.kind==='unauthenticated'?401:o.failure.kind==='forbidden'?403:o.failure.kind==='input_mismatch'||o.failure.kind==='conflict'?409:503;
          throw new MutationError(status,o.failure.code??'mutation_unavailable');
        }
        const planned=planManagement(command,read.snapshot);
        await fault(db,auth,await caseRow(db,body.caseId),body.fault); // After successful preflight, before the real common batch.
        const result=await executeManagement(db,auth,planned);
        return response(result);
      }
      if(url.pathname==='/fixture/tamper-audit'&&request.method==='POST'){
        const body:{operationId:string}=await request.json();
        await db.prepare("UPDATE management_audit SET actor_display_name='tampered' WHERE actor_id=? AND operation_id=?").bind(auth.id,body.operationId).run();
        return response({ok:true});
      }
      return response({error:'fixture_not_found'},404);
    }catch(error){
      const failure=protocolFailure(error);if(failure)return response(failure.body,failure.status);
      if(error instanceof MutationError)return response({error:error.code,...(error.reason?{reason:error.reason}:{}),...(error.current!==undefined?{current:error.current}:{})},error.status);
      if(error instanceof Error&&'status' in error&&typeof error.status==='number')return response({error:error.message},error.status);
      return response({error:'fixture_unavailable'},503);
    }
  },
} satisfies ExportedHandler<Pick<Env,'DB'>>;
