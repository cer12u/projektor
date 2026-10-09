// TEST ONLY: ephemeral local DraftVault HTTP fixture. Never deploy this binding.
// It deliberately reuses the real signed-cookie boundary and atomic workspace.
import ingress, { body } from '../transport/ingress.mjs';
import { authenticate, AuthError } from '../transport/auth.mjs';
import { AuthenticatedWorkspace } from '../transport/workspace.mjs';
import { hasScope } from '../src/resource-access.mjs';
import { canonical, failure, resourceReadable } from '../src/shared-core.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const bindingFields = ['principalId','workspaceId','workspaceEpoch','resourceType','resourceId','editorId','projectAtProtection','draftId'];
const validId = value => typeof value === 'string' && UUID.test(value);
const fail = (code, status = 403) => ({ error: { code, outcome:'unknown', retryable:status === 503 }, status });
function response(value, status = value?.status ?? 200, extraHeaders = {}) {
 const {status:_status,...payload} = value;
 return Response.json(payload, {status, headers:{'cache-control':'no-store','x-content-type-options':'nosniff',...extraHeaders}});
}
function validBinding(binding) {
 return binding && typeof binding === 'object' && !Array.isArray(binding)
  && Object.keys(binding).length === bindingFields.length
  && Object.keys(binding).every(key => bindingFields.includes(key))
  && ['principalId','workspaceId','workspaceEpoch','resourceId','projectAtProtection','draftId'].every(key => validId(binding[key]))
  && ((binding.resourceType === 'issue' && ['title','content'].includes(binding.editorId))
   || (binding.resourceType === 'project' && binding.editorId === 'issue-create')); 
}

export class BrowserFixtureWorkspace extends AuthenticatedWorkspace {
 constructor(ctx, env) {
  super(ctx, env);
  ctx.blockConcurrencyWhile(async () => {
   ctx.storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS browser_fixture_state(id INTEGER PRIMARY KEY CHECK(id=1), authz_version INTEGER NOT NULL, ids_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS browser_session(credential_id TEXT PRIMARY KEY REFERENCES credential(id), session_id TEXT UNIQUE NOT NULL, tombstoned INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS draft_key(key_id TEXT PRIMARY KEY, binding_json TEXT UNIQUE NOT NULL, key_base64 TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
   `);
  });
 }
 row(sql, ...args) { return this.ctx.storage.sql.exec(sql, ...args).toArray()[0]; }
 seedFixture(ids) {
  return this.ctx.storage.transactionSync(() => {
   const sql = this.ctx.storage.sql;
   sql.exec('INSERT INTO workspace VALUES(?,?,1,0)',ids.workspace,ids.epoch);
   for(const project of [ids.project,ids.otherProject])sql.exec('INSERT INTO project VALUES(?,?,1,0)',project,'Content fixture project');
   for (const actor of [ids.actorA,ids.actorB]) {
    sql.exec('INSERT INTO membership VALUES(?,?,0,1)',actor,'human');
    for(const scope of ['operations:read_own','issue:read','issue:write','comment:write','history:read','progress:write','issue:transition'])sql.exec('INSERT INTO principal_scope VALUES(?,?)',actor,scope);
    for (const project of [ids.project,ids.otherProject]) sql.exec('INSERT INTO project_grant VALUES(?,?,1,1)',actor,project);
   }
   sql.exec('INSERT INTO issue VALUES(?,?,?,7,0)',ids.issue,ids.project,'original title');
   sql.exec('INSERT INTO issue_fts VALUES(?,?)',ids.issue,'original title');
   sql.exec('INSERT INTO browser_fixture_state VALUES(1,1,?)',JSON.stringify(ids));
   return true;
  });
 }
 // Only the private control worker can create fixture identities or credentials.
 loginFixture({actor,credentialId,sessionId,issuer,subject,expiresAt,renew=false}) {
  return this.ctx.storage.transactionSync(() => {
   if (!validId(actor) || !validId(credentialId) || !validId(sessionId) || !Number.isSafeInteger(expiresAt)) return fail('VALIDATION',400);
   const member = this.row('SELECT * FROM membership WHERE principal_id=?',actor);
   if (!member || member.revoked) return fail('FORBIDDEN');
   if (renew) {
    const credential = this.row('SELECT * FROM credential WHERE id=? AND principal_id=?',credentialId,actor);
    const session = this.row('SELECT * FROM browser_session WHERE credential_id=? AND session_id=?',credentialId,sessionId);
    if (!credential || !session || session.tombstoned || credential.revoked) return fail('SESSION_TOMBSTONED',401);
    if (credential.expires_at <= Date.now()) return fail('SESSION_EXPIRED',401);
    this.ctx.storage.sql.exec('UPDATE credential SET expires_at=? WHERE id=?',expiresAt,credentialId);
   } else {
    this.ctx.storage.sql.exec('INSERT INTO credential VALUES(?,?,?,0,1,1)',credentialId,actor,expiresAt);
    for(const scope of ['operations:read_own','issue:read','issue:write','comment:write','history:read','progress:write','issue:transition'])this.ctx.storage.sql.exec('INSERT INTO credential_scope VALUES(?,?)',credentialId,scope);
    this.ctx.storage.sql.exec('INSERT INTO identity_binding VALUES(?,?,?,?,?)',issuer,subject,credentialId,actor,'human');
    this.ctx.storage.sql.exec('INSERT INTO browser_session VALUES(?,?,0)',credentialId,sessionId);
   }
   return {principalId:actor,credentialId,sessionId,expiresAt};
  });
 }
 checkedSession(verified) {
  const actor = this.actor(verified);
  if (!actor || actor.actorKind !== 'human') return fail('UNAUTHENTICATED',401);
  const workspace = this.row('SELECT * FROM workspace WHERE id=?',verified.workspaceId);
  const credential = this.row('SELECT * FROM credential WHERE id=? AND principal_id=?',verified.credentialId,actor.principalId);
  const member = this.row('SELECT * FROM membership WHERE principal_id=?',actor.principalId);
  const session = this.row('SELECT * FROM browser_session WHERE credential_id=?',verified.credentialId);
  if (!workspace || !credential || !member || member.kind !== 'human' || !session) return fail('UNAUTHENTICATED',401);
  if (session.tombstoned) return fail('SESSION_TOMBSTONED',401);
  if (Date.now() >= credential.expires_at || Date.now() >= verified.credentialExpiresAt) return fail('SESSION_EXPIRED',401);
  if (credential.revoked || member.revoked || !credential.can_read) return fail('FORBIDDEN');
  if (!workspace.active) return fail('STORE_FENCED',503);
  const expiresAt = Math.min(credential.expires_at,verified.credentialExpiresAt);
  return {
   principalId:actor.principalId,workspaceId:workspace.id,workspaceEpoch:workspace.epoch,
   actorKind:'human',authzVersion:this.row('SELECT authz_version FROM browser_fixture_state WHERE id=1').authz_version,
   sessionId:session.session_id,sessionEpoch:session.session_id,expiresAt,credentialExpiresAt:expiresAt,exp:Math.floor(expiresAt/1000),
   scopes:this.ctx.storage.sql.exec('SELECT c.scope FROM credential_scope c JOIN principal_scope p ON p.scope=c.scope WHERE c.credential_id=? AND p.principal_id=? ORDER BY c.scope',verified.credentialId,actor.principalId).toArray().map(row=>row.scope).filter(scope=>credential.can_write||!scope.endsWith(':write'))
  };
 }
 browserSession(verified) { return this.ctx.storage.transactionSync(() => this.checkedSession(verified)); }
 browserKey(verified, input) {
  return this.ctx.storage.transactionSync(() => {
   const session = this.checkedSession(verified);
   if (session.error) return session;
   if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['binding','keyId'].includes(key)) || !validBinding(input.binding) || (input.keyId !== undefined && !validId(input.keyId))) return fail('VALIDATION',400);
   const binding = input.binding;
   if (binding.principalId !== session.principalId || binding.workspaceId !== session.workspaceId) return fail('DRAFT_SCOPE_MISMATCH');
   if (binding.workspaceEpoch !== session.workspaceEpoch) return fail('EPOCH_MISMATCH',409);
   const actor={principalId:session.principalId,credentialId:verified.credentialId,actorKind:'human'};
   const creating=binding.resourceType==='project';
   const issue=creating?null:this.row('SELECT * FROM issue WHERE id=?',binding.resourceId);
   const project=creating?this.row('SELECT * FROM project WHERE id=?',binding.resourceId):null;
   const currentProject=creating?project?.id:issue?.project_id;
   // Creation drafts are bound to a current writable project. Existing issue
   // drafts retain both current-resource and original protection-scope gates.
   if(creating){
    if(!project||project.deleted)return fail('NOT_FOUND',404);
    if(binding.projectAtProtection!==project.id)return fail('DRAFT_SCOPE_MISMATCH');
    const grant=this.row('SELECT can_read,can_write FROM project_grant WHERE principal_id=? AND project_id=?',session.principalId,project.id);
    const credential=this.row('SELECT can_write FROM credential WHERE id=?',verified.credentialId);
    if(!grant?.can_read||!grant.can_write||!credential?.can_write||!hasScope(this.db,actor,'issue:write')||!hasScope(this.db,actor,'issue:read'))return fail('FORBIDDEN');
   }else{
    if(!issue||issue.deleted)return fail('NOT_FOUND',404);
   }
   for(const projectId of [currentProject,binding.projectAtProtection]){
    const grant=this.row('SELECT can_read FROM project_grant WHERE principal_id=? AND project_id=?',session.principalId,projectId);
    if(!grant?.can_read)return fail('FORBIDDEN');
   }
   if(!creating&&!resourceReadable(this.db,actor,issue.id))return fail('NOT_FOUND',404);
   const encoded = canonical(binding);
   let key = input.keyId
    ? this.row('SELECT * FROM draft_key WHERE key_id=?',input.keyId)
    : this.row('SELECT * FROM draft_key WHERE binding_json=?',encoded);
   if (input.keyId && !key) return fail('KEY_UNAVAILABLE',404);
   if (key && key.binding_json !== encoded) return fail('DRAFT_SCOPE_MISMATCH');
   if (key?.revoked) return fail('KEY_REVOKED');
   if (key && key.expires_at <= Date.now()) return fail('KEY_EXPIRED',410);
   if (!key) {
    // New protection starts at the actual current project, never a caller-
    // selected unrelated project. Moves retain the original stored binding.
    if (binding.projectAtProtection !== currentProject) return fail('DRAFT_SCOPE_MISMATCH');
    const now = Date.now();
    key = {key_id:crypto.randomUUID(),binding_json:encoded,key_base64:btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),created_at:now,expires_at:now+7*86400000,revoked:0};
    this.ctx.storage.sql.exec('INSERT INTO draft_key VALUES(?,?,?,?,?,0)',key.key_id,key.binding_json,key.key_base64,key.created_at,key.expires_at);
   }
   return {keyId:key.key_id,key:key.key_base64,leaseExpiresAt:Math.min(Date.now()+300000,session.expiresAt,key.expires_at),session};
  });
 }
 browserLogout(verified) {
  return this.ctx.storage.transactionSync(() => {
   // Repeated logout is harmless, but never releases the tombstone.
   const actor = this.actor(verified);
   if (!actor) return fail('UNAUTHENTICATED',401);
   const session = this.row('SELECT * FROM browser_session WHERE credential_id=?',verified.credentialId);
   if (!session) return fail('UNAUTHENTICATED',401);
   this.ctx.storage.sql.exec('UPDATE browser_session SET tombstoned=1 WHERE credential_id=?',verified.credentialId);
   this.ctx.storage.sql.exec('UPDATE credential SET revoked=1 WHERE id=?',verified.credentialId);
   return {ok:true,sessionId:session.session_id};
  });
 }
 command(verified, command) {
  const checked = this.checkedSession(verified);
  if (checked.error) return failure(checked.error.code === 'SESSION_EXPIRED' ? 'EXPIRED' : 'FORBIDDEN');
  const result = super.command(verified,command);
  if (command.payload.title === 'TEST_ONLY_DROP_AFTER_COMMIT') return this.ctx.storage.sync().then(() => {throw Error('test-only postcommit response loss');});
  return result;
 }
 issue(verified, args) {
  const checked = this.checkedSession(verified);
  return checked.error ? failure(checked.error.code === 'SESSION_EXPIRED' ? 'EXPIRED' : 'FORBIDDEN') : super.issue(verified,args);
 }
 projects(verified,args) {
  const checked=this.checkedSession(verified);
  return checked.error?failure(checked.error.code==='SESSION_EXPIRED'?'EXPIRED':'FORBIDDEN'):super.projects(verified,args);
 }
 entries(verified,args) {
  const checked=this.checkedSession(verified);
  return checked.error?failure(checked.error.code==='SESSION_EXPIRED'?'EXPIRED':'FORBIDDEN'):super.entries(verified,args);
 }
 revisions(verified,args) {
  const checked=this.checkedSession(verified);
  return checked.error?failure(checked.error.code==='SESSION_EXPIRED'?'EXPIRED':'FORBIDDEN'):super.revisions(verified,args);
 }
 receipt(verified, args) {
  const checked = this.checkedSession(verified);
  return checked.error ? failure(checked.error.code === 'SESSION_EXPIRED' ? 'EXPIRED' : 'FORBIDDEN') : super.receipt(verified,args);
 }
 fixtureControl(action, args = []) {
  return this.ctx.storage.transactionSync(() => {
   const ids = JSON.parse(this.row('SELECT ids_json FROM browser_fixture_state WHERE id=1').ids_json);
   const sql = this.ctx.storage.sql;
   const actor = value => value === 'B' ? ids.actorB : value === 'A' || value === undefined ? ids.actorA : value;
   let result = true, changed = true;
   if (action === 'revokeCurrentProject' || action === 'revokeOriginalProject') {
    const project = action === 'revokeOriginalProject' ? ids.project : this.row('SELECT project_id FROM issue WHERE id=?',ids.issue).project_id;
    sql.exec('UPDATE project_grant SET can_read=0 WHERE principal_id=? AND project_id=?',actor(args[0]),project);
   } else if (action === 'grantProject') {
    sql.exec('INSERT INTO project_grant VALUES(?,?,1,1) ON CONFLICT(principal_id,project_id) DO UPDATE SET can_read=1,can_write=1',actor(args[0]),args[1] ?? ids.project);
   } else if (action === 'revokeMembership') {
    sql.exec('UPDATE membership SET revoked=1 WHERE principal_id=?',actor(args[0]));
   } else if (action === 'revokeCredential') {
    sql.exec('UPDATE credential SET revoked=1 WHERE principal_id=?',actor(args[0]));
   } else if (action === 'expire') {
    sql.exec('UPDATE credential SET expires_at=? WHERE principal_id=?',args[1] ?? 0,actor(args[0]));
   } else if (action === 'moveResource') {
    sql.exec('UPDATE issue SET project_id=? WHERE id=?',args[0] ?? ids.otherProject,ids.issue);
   } else if (action === 'deleteResource') {
    sql.exec('UPDATE issue SET deleted=1 WHERE id=?',ids.issue);
   } else if (action === 'revokeKey') {
    sql.exec('UPDATE draft_key SET revoked=1 WHERE key_id=?',args[0]);
   } else if (action === 'effects' || action === 'inspect') {
    changed = false;
    result = {issue:this.row('SELECT * FROM issue WHERE id=?',ids.issue),workspace:this.row('SELECT * FROM workspace'),authzVersion:this.row('SELECT authz_version FROM browser_fixture_state').authz_version};
    for (const table of ['activity','outbox','operation','draft_key']) result[table] = this.row(`SELECT COUNT(*) AS n FROM ${table}`).n;
    result.sessions = sql.exec('SELECT credential_id,session_id,tombstoned FROM browser_session').toArray();
   } else if (action === 'authzVersion') {
    changed = false; result = this.row('SELECT authz_version FROM browser_fixture_state').authz_version;
   } else if (action === 'sql') {
    result = sql.exec(args[0],...(args[1] ?? [])).toArray();
    changed = !/^\s*SELECT\b/i.test(args[0]);
   } else throw Error('Unknown private fixture control');
   if (changed) sql.exec('UPDATE browser_fixture_state SET authz_version=authz_version+1 WHERE id=1');
   return result;
  });
 }
}

export default {async fetch(request,env) {
 const url = new URL(request.url);
 if (!['/v1/session','/v1/draft-keys','/v1/logout'].includes(url.pathname)) return ingress.fetch(request,env);
 try {
  if (url.search) return response(fail('VALIDATION',400));
  const expectedMethod = url.pathname === '/v1/session' ? 'GET' : 'POST';
  if (request.method !== expectedMethod) return response(fail('METHOD_NOT_ALLOWED',405));
  const verified = await authenticate(request,env,'human');
  if (request.method === 'POST' && (url.origin !== env.TEST_ORIGIN || request.headers.get('origin') !== env.TEST_ORIGIN || request.headers.get('x-projektor-csrf') !== 'same-origin')) return response(fail('CSRF_REJECTED'));
  const stub = env.WORKSPACE.getByName(verified.workspaceId);
  if (url.pathname === '/v1/session') return response(await stub.browserSession(verified));
  if (url.pathname === '/v1/draft-keys') return response(await stub.browserKey(verified,await body(request)));
  return response(await stub.browserLogout(verified),undefined,{'set-cookie':'projektor_test_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'});
 } catch (error) {
  return response(error instanceof AuthError ? fail(error.code,error.status) : fail('TRANSPORT_UNKNOWN',503));
 }
}};
