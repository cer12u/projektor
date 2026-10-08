import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Miniflare, createFetchMock } from 'miniflare';
import { legacyApiTokenMode, parseLegacyScopes, LEGACY_API_TOKEN_MODE } from '../service/legacy-bearer.mjs';

const origin = 'https://legacy-bearer.invalid';
const hash = value => createHash('sha256').update(value).digest('hex');
const sourceSchema = `CREATE TABLE users(id TEXT PRIMARY KEY);
CREATE TABLE workspace_members(workspace_id TEXT,user_id TEXT,role TEXT);
CREATE TABLE api_tokens(id TEXT PRIMARY KEY,workspace_id TEXT,user_id TEXT,issued_by_user_id TEXT,token_hash TEXT,scopes TEXT,expires_at INTEGER,last_used_at INTEGER);`;
const scopes = ['issue:read','issue:write','comment:write','wiki:read','wiki:write','wiki:trash','wiki:restore','history:read','deleted:read','operations:read_own','resource:manage'];

test('legacy parser retains pinned storage semantics and mode is explicit', () => {
 assert.deepEqual(parseLegacyScopes(' [read,write] '), ['read','write']);
 assert.deepEqual(parseLegacyScopes('["write",7,"unrecognized"]'), ['write','unrecognized']);
 for (const raw of [null, '', '{}', 'write']) assert.deepEqual(parseLegacyScopes(raw), []);
 assert.equal(legacyApiTokenMode({}), false);
 for (const mode of [null, '', 'enabled', true]) assert.throws(() => legacyApiTokenMode({ LEGACY_API_TOKEN_AUTH: mode }), { code: 'AUTH_INFRASTRUCTURE_UNAVAILABLE' });
 assert.throws(() => legacyApiTokenMode({ LEGACY_API_TOKEN_AUTH: LEGACY_API_TOKEN_MODE }), { code: 'AUTH_INFRASTRUCTURE_UNAVAILABLE' });
});

test('real local D1 original bearer verification reaches only the existing Store authority', async t => {
 const ids = Object.fromEntries(['workspace','otherWorkspace','epoch','principal','credential','patCredential','humanCredential','project','issue','delegated','delegatedCredential','issuer'].map(key => [key, randomUUID()]));
 // Ephemeral synthetic values, never deployment credentials.
 const pk = 'pk_' + randomUUID(), pat = randomUUID() + randomUUID(), delegatedToken = 'pk_' + randomUUID();
 const mock = createFetchMock(); mock.disableNetConnect();
 const mf = new Miniflare({ cf: false, fetchMock: mock, name: 'legacy-bearer', unsafeInspectDurableObjects: true, modules: true,
  scriptPath: new URL('../service/entry.mjs', import.meta.url).pathname, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
  modulesRules: [{ type: 'Text', include: ['**/*.sql'], fallthrough: true }], d1Databases: ['DB'],
  bindings: { APP_ORIGIN: origin, WORKSPACE_IDS: JSON.stringify([ids.workspace, ids.otherWorkspace]), REQUEST_TIMEOUT_MS: '5000', BODY_TIMEOUT_MS: '1000',
   PROVIDER_CONFIG: JSON.stringify({ issuer: 'https://unused-provider.invalid', jwksUrl: 'https://unused-provider.invalid/certs', humanAudience: 'existing-human', machineAudience: null }),
   LEGACY_API_TOKEN_AUTH: LEGACY_API_TOKEN_MODE,
   MCP_RATE_LIMIT_CONFIG: JSON.stringify({ workspaceBurst: 128, workspacePerSecond: 50, identityBurst: 100, identityPerSecond: 25 }) },
  durableObjects: { WORKSPACE: { className: 'WorkspaceService', useSQLite: true } } });
 try {
  await mf.ready;
  const source = await mf.getD1Database('DB'); await source.exec(sourceSchema.replaceAll('\n', ' '));
  const sql = (query, ...args) => source.prepare(query).bind(...args).run();
  await sql('INSERT INTO users VALUES(?)', ids.principal); await sql('INSERT INTO users VALUES(?)', ids.delegated);
  await sql('INSERT INTO workspace_members VALUES(?,?,?)', ids.workspace, ids.principal, 'owner');
  await sql('INSERT INTO workspace_members VALUES(?,?,?)', ids.workspace, ids.delegated, 'member');
  const insertSource = (credential, principal, token, issuer = null, expiry = null) => sql('INSERT INTO api_tokens VALUES(?,?,?,?,?,?,?,NULL)', credential, ids.workspace, principal, issuer, hash(token), '["read","write"]', expiry);
  await insertSource(ids.credential, ids.principal, pk);
  await insertSource(ids.patCredential, ids.principal, pat, null, Math.floor(Date.now()/1000)+3600);
  await insertSource(ids.delegatedCredential, ids.delegated, delegatedToken, ids.principal, Math.floor(Date.now()/1000)+3600);
  const db = await mf.unsafeGetDurableObjectStorage('legacy-bearer', 'WorkspaceService', { name: ids.workspace });
  await db.exec('INSERT INTO workspace VALUES(?,?,1,0)', ids.workspace, ids.epoch);
  await db.exec('INSERT INTO project VALUES(?,?,1,0)', ids.project, 'Synthetic project');
  const expiry = Date.now()+7200000;
  for (const [principal, kind] of [[ids.principal,'human'], [ids.delegated,'machine']]) {
   await db.exec('INSERT INTO membership VALUES(?,?,0,1)', principal, kind);
   await db.exec('INSERT INTO project_grant VALUES(?,?,1,1)', principal, ids.project);
   await db.exec('INSERT INTO scope_manage_grant VALUES(?,?,?,1)', principal, 'project', ids.project);
   for (const scope of scopes) await db.exec('INSERT INTO principal_scope VALUES(?,?)', principal, scope);
  }
  const insertCredential = async (credential, principal = ids.principal) => {
   await db.exec('INSERT INTO credential VALUES(?,?,?,0,1,1)', credential, principal, expiry);
  };
  for (const [credential, principal] of [[ids.credential,ids.principal],[ids.patCredential,ids.principal],[ids.humanCredential,ids.principal],[ids.delegatedCredential,ids.delegated]]) {
   await insertCredential(credential, principal);
   for (const scope of scopes) await db.exec('INSERT INTO credential_scope VALUES(?,?)', credential, scope);
  }
  await db.exec("INSERT INTO identity_binding VALUES('https://unused-provider.invalid','human-subject',?,?,'human')", ids.humanCredential, ids.principal);
  const auth = token => ({ authorization: `Bearer ${token}` });
  const path = tail => `${origin}/machine/v1/workspaces/${ids.workspace}/${tail}`;
  const get = (tail, token = pk) => mf.dispatchFetch(path(`${tail}?workspaceEpoch=${ids.epoch}`), { headers: auth(token) });
  const command = (type, payload, version, entityId = ids.issue) => ({ schemaVersion:1, workspaceId:ids.workspace, workspaceEpoch:ids.epoch, operationId:randomUUID(), commandType:type, entityId, expectedVersion:version, payload });
  const post = (c, token = pk) => mf.dispatchFetch(path('commands'), { method:'POST', headers:{...auth(token),'content-type':'application/json','idempotency-key':c.operationId}, body:JSON.stringify(c) });
  const expect = async (response, status) => { assert.equal(response.status,status,await response.clone().text()); return response.json(); };
  const sourceState = async () => (await source.prepare('SELECT id,workspace_id,user_id,issued_by_user_id,scopes,expires_at,last_used_at FROM api_tokens ORDER BY id').all()).results;
  const counts = async () => (await db.exec('SELECT (SELECT count(*) FROM membership) AS members,(SELECT count(*) FROM credential) AS credentials,(SELECT count(*) FROM identity_binding) AS bindings,(SELECT count(*) FROM operation) AS operations'))[0];
  let create, receipt;
  await t.test('same human principal supports pk/PAT reads, writes, replay and current MCP', async () => {
   const before=await sourceState();
   create=command('Issue.Create',{projectId:ids.project,title:'Original',description:'source\r\nunchanged',assigneeId:ids.principal,priority:'P2',parentId:null,initialStatus:'ready'},0);
   receipt=await expect(await post(create),200); assert.equal(receipt.meta.actorId,ids.principal);
   assert.deepEqual(await expect(await post(create,pat),200),receipt);
   const issue=await expect(await get(`issues/${ids.issue}`,pat),200); assert.equal(issue.data.description,create.payload.description);
   const meta={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}};
   const response=await mf.dispatchFetch(path('mcp'),{method:'POST',headers:{...auth(pk),'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2026-07-28','mcp-method':'tools/call','mcp-name':'issue_get'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'issue_get',arguments:{workspaceId:ids.workspace,workspaceEpoch:ids.epoch,entityId:ids.issue},_meta:meta}})});
   const mcp=await expect(response,200); assert.equal(mcp.result.structuredContent.meta.actorId,ids.principal);
   assert.deepEqual(await sourceState(),before);
   assert.deepEqual(await counts(),{members:2,credentials:4,bindings:1,operations:1});
  });
  await t.test('missing Store credential cannot borrow the human credential or enroll authority', async () => {
   await db.exec('DELETE FROM credential WHERE id=?',ids.credential); const before=await counts();
   await expect(await get('projects'),401); assert.deepEqual(await counts(),before);
   await insertCredential(ids.credential);
  });
  await t.test('live source downgrade narrows both frozen title and scoped content commands', async () => {
   await sql('UPDATE api_tokens SET scopes=? WHERE id=?','[read]',ids.credential);
   await expect(await get(`issues/${ids.issue}`),200);
   await expect(await post(command('Issue.UpdateTitle',{title:'denied'},1)),403);
   await expect(await post(command('Issue.AddComment',{commentId:randomUUID(),bodyMarkdown:'denied'},1)),403);
   assert.deepEqual(await expect(await post(create),200),receipt);
   await sql('UPDATE api_tokens SET scopes=? WHERE id=?','[unrecognized]',ids.credential);
   await expect(await get('projects'),403);
   await sql('UPDATE api_tokens SET scopes=? WHERE id=?','[write]',ids.credential);
   await expect(await get('projects'),200);
   await expect(await post(command('Issue.UpdateTitle',{title:'After downgrade'},1)),200);
   assert.equal((await expect(await get(`issues/${ids.issue}`),200)).data.title,'After downgrade');
  });
  await t.test('source expiry, deletion, confinement and membership are rechecked', async () => {
   await sql('UPDATE api_tokens SET expires_at=? WHERE id=?',Math.floor(Date.now()/1000),ids.credential);
   await expect(await get('projects'),401); await sql('UPDATE api_tokens SET expires_at=NULL WHERE id=?',ids.credential);
   await expect(await mf.dispatchFetch(`${origin}/machine/v1/workspaces/${ids.otherWorkspace}/projects?workspaceEpoch=${ids.epoch}`,{headers:auth(pk)}),403);
   await sql('UPDATE api_tokens SET workspace_id=NULL WHERE id=?',ids.patCredential); await expect(await get('projects',pat),200);
   await sql('DELETE FROM workspace_members WHERE user_id=?',ids.principal); await expect(await get('projects',pat),403);
   await sql('INSERT INTO workspace_members VALUES(?,?,?)',ids.workspace,ids.principal,'owner');
   await sql('DELETE FROM api_tokens WHERE id=?',ids.patCredential); await expect(await get('projects',pat),401);
  });
  await t.test('current Store revocation, principal kind and resource ACL remain authoritative', async () => {
   await db.exec('UPDATE credential SET revoked=1 WHERE id=?',ids.credential); await expect(await get('projects'),403);
   await db.exec('UPDATE credential SET revoked=0,expires_at=0 WHERE id=?',ids.credential); await expect(await get('projects'),401);
   await db.exec('UPDATE credential SET expires_at=? WHERE id=?',expiry,ids.credential);
   await db.exec('UPDATE membership SET revoked=1 WHERE principal_id=?',ids.principal); await expect(await get('projects'),403);
   await db.exec("UPDATE membership SET revoked=0,kind='machine' WHERE principal_id=?",ids.principal); await expect(await get('projects'),401);
   await db.exec("UPDATE membership SET kind='human' WHERE principal_id=?",ids.principal);
   await db.exec('UPDATE project_grant SET can_read=0 WHERE principal_id=?',ids.principal); await expect(await get(`issues/${ids.issue}`),404);
   await db.exec('UPDATE project_grant SET can_read=1 WHERE principal_id=?',ids.principal);
  });
  await t.test('bearers never become human sessions; OAuth, ambiguous and forged context reject', async () => {
   for(const tail of ['/v1/bootstrap',`/v1/session?workspaceId=${ids.workspace}`,`/v1/workspaces/${ids.workspace}/session`]) await expect(await mf.dispatchFetch(origin+tail,{headers:auth(pk)}),401);
   await expect(await mf.dispatchFetch(origin+'/v1/draft-keys',{method:'POST',headers:{...auth(pk),origin,'x-projektor-csrf':'same-origin','content-type':'application/json'},body:'{}'}),401);
   for(const token of [`${ids.principal}:unverified-grant:synthetic`, 'not-a-token', 'a.b.c']) await expect(await get('projects',token),401);
   await expect(await mf.dispatchFetch(path(`projects?workspaceEpoch=${ids.epoch}`),{headers:{...auth(pk),'cf-access-jwt-assertion':'ignored-synthetic'}}),401);
   const extra=await expect(await mf.dispatchFetch(path(`issues/${ids.issue}?workspaceEpoch=${ids.epoch}`),{headers:{...auth(pk),'x-principal-id':ids.delegated,'x-actor-kind':'human','x-credential-id':ids.humanCredential}}),200);
   assert.equal(extra.meta.actorId,ids.principal);
  });
  await t.test('delegated-only clamp preserves human owner Wiki lifecycle and blocks machine administration', async () => {
   const wiki=randomUUID(), payload={pageId:wiki,scope:{kind:'project',projectId:ids.project},parentId:null,title:'Lifecycle',slug:'lifecycle',contentMarkdown:'body'};
   await expect(await post(command('Wiki.Create',payload,0,wiki)),200);
   const denied=await expect(await post(command('SetResourceAccess',{resource:{type:'wiki',id:wiki},expectedPolicyVersion:1,policy:{mode:'inherit',readerPrincipalIds:[],writerPrincipalIds:[]}},1,wiki)),403);
   assert.equal(denied.error.code,'FORBIDDEN');
   await expect(await post(command('Wiki.Trash',{reason:'delegated deny'},1,wiki),delegatedToken),403);
   await expect(await post(command('Wiki.Trash',{reason:'owner allowed'},1,wiki)),200);
   await sql("UPDATE workspace_members SET role='owner' WHERE user_id=?",ids.delegated);
   await expect(await get('projects',delegatedToken),403);
  });
  await t.test('failed source lookup is unavailable without fallback or authority changes', async () => {
   const before=await counts(); await source.exec('DROP TABLE api_tokens');
   await expect(await get('projects'),503); assert.deepEqual(await counts(),before);
  });
 } finally { await mf.dispose(); }
});
