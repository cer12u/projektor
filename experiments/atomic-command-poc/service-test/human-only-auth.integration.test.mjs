import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { Miniflare, createFetchMock } from 'miniflare';

test('actual human-only service supports bootstrap/session while unconfigured machine routes fail closed', async () => {
 const origin = 'https://human-only-service.invalid', issuer = 'https://human-only-provider.invalid';
 const ids = Object.fromEntries(['workspace', 'epoch', 'principal', 'credential'].map(name => [name, randomUUID()]));
 const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
 const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'ephemeral-local-only', alg: 'RS256', use: 'sig' };
 const jwt = (machine = false) => {
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: issuer, type: 'app', aud: [machine ? 'unconfigured-machine' : 'existing-human'],
   sub: machine ? '' : 'synthetic-human', ...(machine ? { common_name: 'synthetic-service.access' } : {}),
   iat: now - 5, nbf: now - 5, exp: now + 600 };
  const input = [JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: jwk.kid }), JSON.stringify(claims)].map(text => Buffer.from(text).toString('base64url')).join('.');
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
 };
 const mock = createFetchMock(); mock.disableNetConnect();
 mock.get(issuer).intercept({ path: '/certs' }).reply(200, JSON.stringify({ keys: [jwk] }), { headers: { 'content-type': 'application/json' } }).persist();
 const mf = new Miniflare({ cf: false, name: 'human-only', unsafeInspectDurableObjects: true, modules: true,
  scriptPath: new URL('../service/entry.mjs', import.meta.url).pathname,
  compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
  modulesRules: [{ type: 'Text', include: ['**/*.sql'], fallthrough: true }], fetchMock: mock,
  bindings: { APP_ORIGIN: origin, WORKSPACE_IDS: JSON.stringify([ids.workspace]), REQUEST_TIMEOUT_MS: '5000', BODY_TIMEOUT_MS: '1000',
   PROVIDER_CONFIG: JSON.stringify({ issuer, jwksUrl: issuer + '/certs', humanAudience: 'existing-human', machineAudience: null, jwksCacheMs: 60000, jwksTimeoutMs: 500 }),
   MCP_RATE_LIMIT_CONFIG: 'null' }, durableObjects: { WORKSPACE: { className: 'WorkspaceService', useSQLite: true } } });
 try {
  await mf.ready;
  const db = await mf.unsafeGetDurableObjectStorage('human-only', 'WorkspaceService', { name: ids.workspace });
  await db.exec('INSERT INTO workspace VALUES(?,?,1,0)', ids.workspace, ids.epoch);
  await db.exec("INSERT INTO membership VALUES(?,'human',0,1)", ids.principal);
  await db.exec('INSERT INTO credential VALUES(?,?,?,0,1,0)', ids.credential, ids.principal, Date.now() + 600000);
  await db.exec("INSERT INTO identity_binding VALUES(?,?,?,?,'human')", issuer, 'synthetic-human', ids.credential, ids.principal);
  await db.exec('INSERT INTO principal_scope VALUES(?,?)', ids.principal, 'issue:read');
  await db.exec('INSERT INTO credential_scope VALUES(?,?)', ids.credential, 'issue:read');
  const headers = { 'cf-access-jwt-assertion': jwt() };
  for (const path of ['/v1/bootstrap', '/v1/session?workspaceId=' + ids.workspace]) {
   const response = await mf.dispatchFetch(origin + path, { headers });
   assert.equal(response.status, 200, await response.clone().text());
   assert.equal((await response.json()).principalId, ids.principal);
  }
  for (const credential of [jwt(true), jwt(), 'pk_synthetic_legacy_token']) {
   for (const tail of [`my-issues?workspaceEpoch=${ids.epoch}`, 'mcp']) {
    const response = await mf.dispatchFetch(`${origin}/machine/v1/workspaces/${ids.workspace}/${tail}`, { headers: { authorization: `Bearer ${credential}` } });
    assert.equal(response.status, 401, await response.clone().text());
    assert.match(response.headers.get('content-type'), /application\/json/);
   }
  }
  const response = await mf.dispatchFetch(origin + '/v1/bootstrap', { headers: { 'cf-access-jwt-assertion': jwt(true) } });
  assert.equal(response.status, 401);
  assert.equal((await db.exec('SELECT count(*) AS n FROM identity_binding'))[0].n, 1);
  assert.equal((await db.exec('SELECT count(*) AS n FROM membership'))[0].n, 1);
 } finally { await mf.dispose(); }
});
