// @module verification
// @role fixture-p2
// Test-only entrypoint. Not imported by the product Worker or exposed by its routes.
import { authenticate } from '../identity-fixture';
import { digest, randomToken } from "../../../src/adapters/crypto/passwords";
import type {AuthDB} from "../../../src/adapters/d1/primitives";
import type {Authenticated} from "../../../src/adapters/d1/identity/authorization";
import {executeMutation,readMutationResult,canonicalInput,type MutationAdapter,type MutationTarget,} from "../../../src/adapters/d1/persistence/transaction";
import {sql} from "../../../src/adapters/d1/primitives";
import {MutationError,type Json} from "../../../src/adapters/d1/persistence/public";

const visible = (t: MutationTarget) => sql(`EXISTS(SELECT 1 FROM fixture_targets WHERE id=? AND project_id=?)`, t.targetId, t.projectId);
const current = (t: MutationTarget) => sql(`SELECT json_object('id',id,'revision',revision,'state',state,'related',related_id,'value',value)
  FROM fixture_targets WHERE id=? AND project_id=?`, t.targetId, t.projectId);
const policyFor = (kind: string) => ['fixture.update', 'fixture.other'].includes(kind) ? { visible } : undefined;
type Input = { revision: number; state: string; relatedId: string; value: string };
type Body = Input & { operationId: string; targetId?: string; projectId?: string; kind?: string; fault?: string; revoke?: string; maxBytes?:number; certify?:boolean; fenceValid?:boolean; fencePermission?:'assign' };
function adapter(input: Input, fault?: string): MutationAdapter<Input> {
  const fail = { statement: sql('INSERT INTO fixture_failures(valid) VALUES(0)'), expectedChanges: 1 };
  return {
    permissions: ['edit'], visible, current,
    preconditions: c => [
      { reason: 'revision_conflict', valid: sql('EXISTS(SELECT 1 FROM fixture_targets WHERE id=? AND revision=?)', c.targetId, input.revision) },
      { reason: 'transition_conflict', valid: sql(`EXISTS(SELECT 1 FROM fixture_targets WHERE id=? AND state='open') AND ?='done'`, c.targetId, input.state) },
      { reason: 'related_invalid', valid: sql('EXISTS(SELECT 1 FROM fixture_related WHERE id=? AND project_id=?)', input.relatedId, c.projectId) },
      { reason: 'injected_guard_failure', valid: sql('?', fault === 'guard' ? 0 : 1) },
    ],
    updates: c => [
      { statement: sql(`UPDATE fixture_targets SET revision=revision+1,state=?,related_id=?,value=? WHERE id=? AND project_id=? AND revision=?`,
        input.state, input.relatedId, input.value, fault === 'zero-update' ? 'missing' : c.targetId, c.projectId, input.revision), expectedChanges: 1 },
      ...(fault === 'after-update' ? [fail] : []),
    ],
    history: c => [
      { statement: sql(`INSERT INTO fixture_history(principal_id,operation_id,target_id,revision,value)
        SELECT ?,?,id,revision,value FROM fixture_targets WHERE id=?`, c.principalId, c.operationId, c.targetId), expectedChanges: 1 },
      ...(fault === 'after-history' ? [fail] : []),
    ],
    snapshot: c => fault === 'result' ? sql('NULL') : current(c),
  };
}
async function reset(db: AuthDB) {
  const ddl = [
    `CREATE TABLE IF NOT EXISTS fixture_related(id TEXT PRIMARY KEY,project_id TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS fixture_targets(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,revision INTEGER NOT NULL,state TEXT NOT NULL,
      related_id TEXT NOT NULL REFERENCES fixture_related(id),value TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS fixture_history(principal_id TEXT NOT NULL,operation_id TEXT NOT NULL,target_id TEXT NOT NULL REFERENCES fixture_targets(id),
      revision INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(principal_id,operation_id),
      FOREIGN KEY(principal_id,operation_id) REFERENCES operation_results(principal_id,operation_id))`,
    `CREATE TABLE IF NOT EXISTS fixture_failures(valid INTEGER NOT NULL CHECK(valid=1))`,
    `CREATE TABLE IF NOT EXISTS fixture_controls(fail_delete INTEGER NOT NULL)`,
    `CREATE TRIGGER IF NOT EXISTS fixture_fail_last BEFORE DELETE ON mutation_guards
      WHEN EXISTS(SELECT 1 FROM fixture_controls WHERE fail_delete=1) BEGIN SELECT RAISE(ABORT,'fixture last constraint'); END`,
  ];
  await db.batch(ddl.map(q => db.prepare(q)));
  await db.batch([
    ...['fixture_history','operation_results','mutation_guards','fixture_targets','fixture_related','fixture_failures','fixture_controls',
      'management_audit','credential_project_records','principal_project_records','credential_management','principal_management',
      'password_setup_states','sessions','api_grants','api_credentials','memberships','passwords','principals'].map(t => db.prepare(`DELETE FROM ${t}`)),
    db.prepare("INSERT INTO fixture_controls VALUES(0)"),
    db.prepare("INSERT INTO fixture_related VALUES('link','P'),('private-link','Q')"),
    db.prepare("INSERT INTO fixture_targets VALUES('target','P',1,'open','link','before'),('target-2','P',1,'open','link','before'),('private-target','Q',1,'open','private-link','private')"),
    db.prepare("INSERT INTO principals VALUES('fixture-agent','agent','Synthetic agent',NULL,1,1)"),
    db.prepare("INSERT INTO principals VALUES('fixture-human','human','Synthetic human','synthetic-human',1,1)"),
    db.prepare("INSERT INTO memberships VALUES('fixture-agent','P','view'),('fixture-agent','P','edit'),('fixture-human','P','view'),('fixture-human','P','edit')"),
  ]);
  const api = randomToken(), session = randomToken(), derived = randomToken(), csrf = randomToken();
  await db.batch([
    db.prepare("INSERT INTO api_credentials VALUES('fixture-key','fixture-agent',?,unixepoch()+3600,NULL)").bind(await digest(api)),
    db.prepare("INSERT INTO api_grants VALUES('fixture-key','P','view'),('fixture-key','P','edit')"),
    db.prepare("INSERT INTO sessions(token_hash,principal_id,auth_version,api_credential_id,csrf_token,created_at,last_seen_at,absolute_expires_at,revoked_at) VALUES(?,'fixture-human',1,NULL,?,unixepoch(),unixepoch(),unixepoch()+3600,NULL)").bind(await digest(session),csrf),
    db.prepare("INSERT INTO sessions(token_hash,principal_id,auth_version,api_credential_id,csrf_token,created_at,last_seen_at,absolute_expires_at,revoked_at) VALUES(?,'fixture-agent',1,'fixture-key',?,unixepoch(),unixepoch(),unixepoch()+3600,NULL)").bind(await digest(derived),csrf),
  ]);
  return { api, session, derived };
}
async function revoke(db: AuthDB, auth: Authenticated, action?: string) {
  const queries: Record<string, ReturnType<typeof sql>> = {
    credential: sql("UPDATE api_credentials SET revoked_at=unixepoch() WHERE id='fixture-key'"),
    membership: sql("DELETE FROM memberships WHERE principal_id=? AND project_id='P' AND permission='edit'",auth.id),
    scope: sql("DELETE FROM api_grants WHERE credential_id='fixture-key' AND permission='edit'"),
    view: sql("DELETE FROM memberships WHERE principal_id=? AND project_id='P' AND permission='view'",auth.id),
    principal: sql('UPDATE principals SET active=0 WHERE id=?',auth.id),
    version: sql('UPDATE principals SET auth_version=auth_version+1 WHERE id=?',auth.id),
    session: sql('UPDATE sessions SET revoked_at=unixepoch() WHERE token_hash=?',auth.token_hash),
    idle: sql('UPDATE sessions SET last_seen_at=unixepoch()-2592000 WHERE token_hash=?',auth.token_hash),
    absolute: sql('UPDATE sessions SET absolute_expires_at=unixepoch() WHERE token_hash=?',auth.token_hash),
    expiry: sql("UPDATE api_credentials SET expires_at=unixepoch() WHERE id='fixture-key'"),
  };
  if (action) { const q = queries[action]; if (!q) throw new Error('Unknown fixture control'); await db.prepare(q.text).bind(...q.values).run(); }
}
export default {
  async fetch(request, env) {
    const db = env.DB.withSession('first-primary'), url = new URL(request.url);
    const response = (value: unknown, status = 200) => Response.json(value, {status,headers:{'Cache-Control':'no-store'}});
    try {
      if (url.pathname === '/fixture/ledger') return response({names:(await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{name:string}>()).results.map(row=>row.name)});
      if (url.pathname === '/fixture/reset' && request.method === 'POST') return response(await reset(db));
      if (url.pathname === '/fixture/state') {
        const tables = ['fixture_targets','fixture_history','operation_results','mutation_guards'];
        const rows = await db.batch(tables.map(t => db.prepare(`SELECT * FROM ${t} ORDER BY 1,2`)));
        return response(Object.fromEntries(tables.map((t,i) => [t,rows[i].results])));
      }
      if (url.pathname === '/fixture/canonical') {
        // Pure input boundary checks also run inside the target workerd.
        const outcomes: string[] = [];
        const invalid: Json[] = [Number.NaN, Number.POSITIVE_INFINITY];
        const cycle: { self?: Json } = {}; cycle.self = cycle;
        const hole: Json[] = []; hole.length = 1;
        for (const value of [...invalid, cycle, hole, 'x'.repeat(16385)]) {
          try { canonicalInput(value); outcomes.push('accepted'); } catch (e) { outcomes.push(e instanceof MutationError ? e.code : 'unexpected'); }
        }
        return response({equal:canonicalInput({b:2,a:[1,-0]})===canonicalInput({a:[1,0],b:2}),outcomes});
      }
      const auth = await authenticate(request, db, Math.floor(Date.now()/1000));
      if (url.pathname === '/fixture/control' && request.method === 'POST') {
        const body: { action: string } = await request.json();
        if (body.action === 'move') await db.prepare("UPDATE fixture_targets SET project_id='Q' WHERE id='target'").run();
        else if (body.action === 'reopen') await db.prepare("UPDATE fixture_targets SET state='open' WHERE id='target'").run();
        else if (body.action === 'tamper') await db.prepare("UPDATE operation_results SET snapshot='{}' WHERE operation_id='snapshot'").run();
        else if (body.action === 'disable-store') await db.prepare('ALTER TABLE operation_results RENAME TO fixture_unavailable_results').run();
        else if (body.action === 'restore-store') await db.prepare('ALTER TABLE fixture_unavailable_results RENAME TO operation_results').run();
        else await revoke(db,auth,body.action);
        return response({ok:true});
      }
      if (url.pathname === '/fixture/result') {
        await revoke(db,auth,url.searchParams.get('revoke')??undefined);
        return response({snapshot:await readMutationResult(db,auth,url.searchParams.get('id')??'',policyFor)});
      }
      if (url.pathname === '/fixture/mutate' && request.method === 'POST') {
        const body: Body = await request.json();
        await revoke(db,auth,body.revoke); // Controlled TOCTOU injection after real P1a authentication.
        if (body.fault === 'after-result') await db.prepare('UPDATE fixture_controls SET fail_delete=1').run();
        try {
          const input = {revision:body.revision,state:body.state,relatedId:body.relatedId,value:body.value};
          const result = await executeMutation(db,auth,{
            operationId:body.operationId,kind:body.kind??'fixture.update',targetId:body.targetId??'target',projectId:body.projectId??'P',input,
          },{...adapter(input,body.fault),...(body.maxBytes!==undefined||body.certify?{commandPolicy:{canonicalMaxBytes:body.maxBytes??16384,certifyPreDispatchDenial:body.certify}}:{})},policyFor,body.fenceValid!==undefined||body.fencePermission?{valid:sql('?',body.fenceValid===false?0:1),requiredPermissions:body.fencePermission?[body.fencePermission]:[]}:undefined);
          // Commit then simulate loss at the response boundary; recovery must use the same operation ID.
          if (body.fault === 'response-loss') return response({error:'synthetic_response_lost'},503);
          return response(result);
        } finally { if (body.fault === 'after-result') await db.prepare('UPDATE fixture_controls SET fail_delete=0').run(); }
      }
      return response({error:'fixture_not_found'},404);
    } catch (error) {
      if (error instanceof MutationError) return response({error:error.code,...(error.reason?{reason:error.reason}:{}),
        ...(error.current!==undefined?{current:error.current}:{}),...(error.mutationOutcome?{mutationOutcome:error.mutationOutcome}:{})},error.status);
      if (error instanceof Error && 'status' in error && typeof error.status === 'number') return response({error:error.message},error.status);
      // Fixture runtime failures are retained by the runner; never return SQL/credential details.
      console.error('P2 fixture failed', error instanceof Error ? error.name : 'unknown');
      return response({error:'fixture_failure'},500);
    }
  },
} satisfies ExportedHandler<Pick<Env,'DB'>>;
