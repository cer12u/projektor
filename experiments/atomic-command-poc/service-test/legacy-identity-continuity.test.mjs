import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { denyOutbound } from '../test-support/offline.mjs';
import { AuthError, createVerifier } from '../service/auth.mjs';
import { createLegacyIdentityContinuityPlanner, IdentityContinuityPlanError } from '../scripts/legacy-identity-continuity.mjs';
import { currentSession } from '../session-ports/server.mjs';

const NOW = 1791424800000;
const ids = Object.freeze({ workspace: '10000000-0000-4000-8000-000000000001', epoch: '10000000-0000-4000-8000-000000000002',
 legacy: '10000000-0000-4000-8000-000000000003', other: '10000000-0000-4000-8000-000000000004', credential: '10000000-0000-4000-8000-000000000005' });
const subject = 'provider-subject-is-not-the-legacy-user-id';
const email = 'Exact.Case@example.test';
const providerConfig = Object.freeze({ issuer: 'https://synthetic.cloudflareaccess.com', jwksUrl: 'https://synthetic.cloudflareaccess.com/cdn-cgi/access/certs',
 humanAudience: 'synthetic-existing-human-app', machineAudience: null, jwksCacheMs: 10000, jwksTimeoutMs: 1000 });
const sourceBoundary = Object.freeze({ issuer: providerConfig.issuer, humanAudience: providerConfig.humanAudience, emailVerification: 'signed_access_email' });
// Synthetic signing material exists in memory for this process only. The public
// JWKS response is supplied locally; no provider or production token is accessed.
const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
const key = await crypto.subtle.generateKey({ ...algorithm, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ['sign', 'verify']);
const jwk = { ...await crypto.subtle.exportKey('jwk', key.publicKey), kid: 'synthetic-key', use: 'sig' };
const encode = value => Buffer.from(value).toString('base64url');
async function token(changes = {}) {
 const claims = { iss: providerConfig.issuer, aud: [providerConfig.humanAudience], sub: subject, type: 'app', email,
  iat: NOW / 1000 - 10, nbf: NOW / 1000 - 10, exp: NOW / 1000 + 600, ...changes };
 const input = `${encode(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: jwk.kid }))}.${encode(JSON.stringify(claims))}`;
 return `${input}.${encode(new Uint8Array(await crypto.subtle.sign(algorithm.name, key.privateKey, new TextEncoder().encode(input))))}`;
}
const request = jwt => new Request('https://migration-only.invalid/', { headers: { 'cf-access-jwt-assertion': jwt } });
const seams = () => ({ now: () => NOW, fetchImpl: async () => new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'content-type': 'application/json' } }) });
const awaitedToken = await token();
const falseEmailToken = await token({ email_verified: false });
const sharedViewerToken = await token({ email: 'public-viewer@projektor.local' });
const snapshot = db => JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
 .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]));
function fixture(t, { sourceMutation, targetMutation, configChanges = {}, boundaryChanges = {}, principal = ids.legacy, epoch = ids.epoch } = {}) {
 const sourceDb = new DatabaseSync(':memory:'), targetDb = new DatabaseSync(':memory:');
 t.after(() => { sourceDb.close(); targetDb.close(); });
 sourceDb.exec('CREATE TABLE users(id TEXT PRIMARY KEY, email TEXT NOT NULL); CREATE TABLE workspace_members(workspace_id TEXT, user_id TEXT);');
 sourceDb.prepare('INSERT INTO users VALUES(?,?)').run(ids.legacy, email);
 sourceDb.prepare('INSERT INTO users VALUES(?,?)').run(ids.other, email.toLowerCase());
 sourceDb.prepare('INSERT INTO workspace_members VALUES(?,?)').run(ids.workspace, ids.legacy);
 targetDb.exec(readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8'));
 targetDb.exec('CREATE TABLE identity_binding(issuer TEXT NOT NULL, subject TEXT NOT NULL, credential_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, kind TEXT NOT NULL);');
 targetDb.prepare('INSERT INTO workspace VALUES(?,?,0,0)').run(ids.workspace, ids.epoch);
 targetDb.prepare("INSERT INTO membership VALUES(?,'legacy_unbound',0,1)").run(ids.legacy);
 targetDb.prepare("INSERT INTO membership VALUES(?,'human',0,1)").run(ids.other);
 targetDb.prepare('INSERT INTO principal_scope VALUES(?,?)').run(ids.legacy, 'issue:read');
 sourceMutation?.(sourceDb); targetMutation?.(targetDb);
 const before = [snapshot(sourceDb), snapshot(targetDb)];
 sourceDb.exec('PRAGMA query_only=ON'); targetDb.exec('PRAGMA query_only=ON');
 const plan = createLegacyIdentityContinuityPlanner({ providerConfig: { ...providerConfig, ...configChanges },
  sourceBoundary: { ...sourceBoundary, ...boundaryChanges }, sourceDb, targetDb, workspaceId: ids.workspace, workspaceEpoch: epoch, expectedPrincipalId: principal }, seams());
 return { sourceDb, targetDb, plan, unchanged: () => assert.deepEqual([snapshot(sourceDb), snapshot(targetDb)], before) };
}
const planRejects = (action, code) => assert.rejects(action, error => error instanceof IdentityContinuityPlanError && error.code === code);
function bind(db, changes = {}) {
 const row = { issuer: providerConfig.issuer, subject, credentialId: ids.credential, principalId: ids.legacy, kind: 'human', ...changes };
 db.prepare('INSERT INTO identity_binding VALUES(?,?,?,?,?)').run(row.issuer, row.subject, row.credentialId, row.principalId, row.kind);
 db.prepare('INSERT INTO credential VALUES(?,?,?,0,1,0)').run(row.credentialId, row.principalId, NOW + 600000);
}

test('verified Access exact-email lookup preserves old ID in a frozen imported Store without granting authority', async t => {
 const f = fixture(t), jwt = await token(), result = await f.plan(request(jwt));
 const oldLookup = f.sourceDb.prepare('SELECT id FROM users WHERE email = ?').get(email);
 assert.equal(result.principalId, oldLookup.id);
 assert.notEqual(result.principalId, subject);
 assert.deepEqual(result, { mode: 'migration_plan_only', authActivated: false, workspaceId: ids.workspace, workspaceEpoch: ids.epoch,
  legacyUserId: ids.legacy, principalId: ids.legacy, provider: { issuer: providerConfig.issuer, subject, kind: 'human' }, existingBinding: 'absent' });
 assert.deepEqual(await f.plan(request(jwt)), result);
 assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result.provider), true);
 for (const forbidden of [email, jwt, ids.credential]) assert.equal(JSON.stringify(result).includes(forbidden), false);
 assert.throws(() => currentSession(f.targetDb, result, ids.workspace, { now: NOW }), { code: 'UNAUTHENTICATED' });
 f.unchanged();
});

test('exact-email source lookup refuses missing and ambiguous users and never normalizes or upserts', async t => {
 const cases = [
  ['missing', { sourceMutation: db => db.prepare('DELETE FROM users WHERE id=?').run(ids.legacy) }, 'MIGRATION_LEGACY_USER_MISSING'],
  ['duplicate exact email', { sourceMutation: db => db.prepare('UPDATE users SET email=? WHERE id=?').run(email, ids.other) }, 'MIGRATION_LEGACY_USER_AMBIGUOUS'],
  ['wrong target principal', { principal: ids.other }, 'MIGRATION_PRINCIPAL_MISMATCH'],
  ['source membership removed', { sourceMutation: db => db.exec('DELETE FROM workspace_members') }, 'MIGRATION_SOURCE_MEMBERSHIP_MISMATCH'],
  ['duplicate source membership', { sourceMutation: db => db.prepare('INSERT INTO workspace_members VALUES(?,?)').run(ids.workspace, ids.legacy) }, 'MIGRATION_SOURCE_MEMBERSHIP_MISMATCH'],
 ];
 for (const [name, options, code] of cases) await t.test(name, async t => {
  const f = fixture(t, options); await planRejects(() => f.plan(request(awaitedToken)), code); f.unchanged();
 });
});

test('migration plan rejects active, mismatched, missing and revoked target authority', async t => {
 const cases = [
  ['active Store', db => db.exec('UPDATE workspace SET active=1'), 'MIGRATION_TARGET_NOT_FROZEN'],
  ['wrong workspace', db => db.prepare('UPDATE workspace SET id=?').run(ids.other), 'MIGRATION_TARGET_WORKSPACE_MISMATCH'],
  ['wrong epoch', db => db.prepare('UPDATE workspace SET epoch=?').run(ids.other), 'MIGRATION_TARGET_WORKSPACE_MISMATCH'],
  ['missing member', db => db.exec('DELETE FROM membership'), 'MIGRATION_TARGET_MEMBERSHIP_MISMATCH'],
  ['machine member', db => db.exec("UPDATE membership SET kind='machine'"), 'MIGRATION_TARGET_MEMBERSHIP_MISMATCH'],
  ['revoked member', db => db.exec('UPDATE membership SET revoked=1'), 'MIGRATION_MEMBERSHIP_REVOKED'],
 ];
 for (const [name, targetMutation, code] of cases) await t.test(name, async t => {
  const f = fixture(t, { targetMutation }); await planRejects(() => f.plan(request(awaitedToken)), code); f.unchanged();
 });
});

test('existing bindings must match both directions and retain valid unrevoked credentials', async t => {
 const cases = [
  ['other principal for subject', db => bind(db, { principalId: ids.other }), 'MIGRATION_IDENTITY_BINDING_COLLISION'],
  ['other subject for principal', db => bind(db, { subject: 'other-provider-subject' }), 'MIGRATION_IDENTITY_BINDING_COLLISION'],
  ['other issuer for principal', db => bind(db, { issuer: 'https://other-provider.invalid' }), 'MIGRATION_IDENTITY_BINDING_COLLISION'],
  ['machine binding', db => bind(db, { kind: 'machine' }), 'MIGRATION_IDENTITY_BINDING_COLLISION'],
  ['ambiguous binding', db => { bind(db); bind(db, { credentialId: ids.other }); }, 'MIGRATION_IDENTITY_BINDING_AMBIGUOUS'],
  ['wrong credential principal', db => { bind(db); db.prepare('UPDATE credential SET principal_id=?').run(ids.other); }, 'MIGRATION_CREDENTIAL_MISMATCH'],
  ['missing credential', db => { bind(db); db.exec('DELETE FROM credential'); }, 'MIGRATION_CREDENTIAL_MISMATCH'],
  ['revoked credential', db => { bind(db); db.exec('UPDATE credential SET revoked=1'); }, 'MIGRATION_CREDENTIAL_REVOKED'],
  ['expired credential', db => { bind(db); db.prepare('UPDATE credential SET expires_at=?').run(NOW); }, 'MIGRATION_CREDENTIAL_EXPIRED'],
 ];
 for (const [name, targetMutation, code] of cases) await t.test(name, async t => {
  const f = fixture(t, { targetMutation }); await planRejects(() => f.plan(request(awaitedToken)), code); f.unchanged();
 });
 await t.test('exact existing mapping is only reported, with no credential handle output', async t => {
  const f = fixture(t, { targetMutation: db => { db.exec("UPDATE membership SET kind='human'"); bind(db); } });
  const result = await f.plan(request(awaitedToken)); assert.equal(result.existingBinding, 'matches');
  assert.equal(JSON.stringify(result).includes(ids.credential), false); f.unchanged();
 });
});

test('migration evidence uses the normal RS256 provider boundary and rejects untrusted claims', async t => {
 for (const changes of [{ iss: 'https://wrong-provider.invalid' }, { aud: ['other-app'] }, { type: 'org' }, { sub: '' },
  { common_name: 'machine.access' }, { exp: NOW / 1000 - 1 }, { email: undefined }, { email_verified: 'true' }]) {
  const f = fixture(t), jwt = await token(changes);
  await assert.rejects(() => f.plan(request(jwt)), error => error instanceof AuthError); f.unchanged();
 }
 const f = fixture(t), parts = awaitedToken.split('.');
 const claims = JSON.parse(Buffer.from(parts[1], 'base64url')); claims.email = email.toLowerCase();
 parts[1] = encode(JSON.stringify(claims));
 await assert.rejects(() => f.plan(request(parts.join('.'))), error => error instanceof AuthError && error.code === 'UNAUTHENTICATED');
 const normalIdentity = await createVerifier(providerConfig, seams())(request(awaitedToken), 'human');
 assert.equal(Object.hasOwn(normalIdentity, 'email'), false); assert.equal(Object.hasOwn(normalIdentity, 'emailVerified'), false);
 f.unchanged();
});

test('email verification honors the explicit source boundary and never implies a stronger policy', async t => {
 const signed = fixture(t);
 assert.equal((await signed.plan(request(awaitedToken))).principalId, ids.legacy);
 await planRejects(() => signed.plan(request(falseEmailToken)), 'MIGRATION_EMAIL_UNVERIFIED');
 const strict = fixture(t, { boundaryChanges: { emailVerification: 'email_verified_claim' } });
 await planRejects(() => strict.plan(request(awaitedToken)), 'MIGRATION_EMAIL_UNVERIFIED');
 assert.equal((await strict.plan(request(await token({ email_verified: true })))).principalId, ids.legacy);
 await planRejects(() => signed.plan(request(sharedViewerToken)), 'MIGRATION_SHARED_IDENTITY_REJECTED');
 signed.unchanged(); strict.unchanged();
});

test('source provider mismatch and unspecified trust boundary fail before reading identity data', t => {
 for (const boundaryChanges of [{ issuer: 'https://other.invalid' }, { humanAudience: 'other-app' }]) {
  assert.throws(() => fixture(t, { boundaryChanges }), { code: 'MIGRATION_PROVIDER_MISMATCH' });
 }
 for (const emailVerification of [undefined, 'assumed', true]) assert.throws(() => fixture(t, { boundaryChanges: { emailVerification } }), { code: 'MIGRATION_PLAN_CONFIG_INVALID' });
});

test('actual asynchronous D1 source joins exact identity and membership once, with no writes or email results', async t => {
 const mf = new Miniflare({ cf: false, modules: true, compatibilityDate: '2026-07-30',
  script: 'export default {fetch(){return new Response(null,{status:404});}}',
  d1Databases: ['LEGACY_SOURCE'], fetchMock: denyOutbound() });
 try {
  await mf.ready;
  const db = await mf.getD1Database('LEGACY_SOURCE');
  await db.exec('CREATE TABLE users(id TEXT PRIMARY KEY, email TEXT NOT NULL); CREATE TABLE workspace_members(workspace_id TEXT, user_id TEXT);');
  await db.batch([
   db.prepare('INSERT INTO users VALUES(?,?)').bind(ids.legacy, email),
   db.prepare('INSERT INTO users VALUES(?,?)').bind(ids.other, email.toLowerCase()),
   db.prepare('INSERT INTO workspace_members VALUES(?,?)').bind(ids.workspace, ids.legacy),
  ]);
  const sourceSnapshot = async () => JSON.stringify((await db.batch([
   db.prepare('SELECT * FROM users ORDER BY id'),
   db.prepare('SELECT * FROM workspace_members ORDER BY workspace_id, user_id'),
  ])).map(result => result.results));
  const local = fixture(t), reads = [];
  let now = NOW, expireAfterRead = false;
  // Observes the actual D1 query and its real storage metadata, not a fake result.
  // The caller gives the planner only a prepare/bind/all read capability.
  const sourceDb = { prepare(sql) {
   assert.match(sql, /^SELECT /); assert.doesNotMatch(sql, /;/);
   assert.match(sql, /LEFT JOIN workspace_members/); assert.match(sql, /LIMIT 2$/);
   return { bind(...args) { return { async all() {
    const result = await db.prepare(sql).bind(...args).all();
    reads.push(result);
    if (expireAfterRead) now = NOW + 600000;
    return result;
   } }; } };
  } };
  const plan = createLegacyIdentityContinuityPlanner({ providerConfig, sourceBoundary, sourceDb, targetDb: local.targetDb,
   workspaceId: ids.workspace, workspaceEpoch: ids.epoch, expectedPrincipalId: ids.legacy }, { ...seams(), now: () => now });
  const checkReadOnly = async (action, expectedRows) => {
   const before = await sourceSnapshot(), beforeReads = reads.length;
   await action();
   assert.equal(reads.length, beforeReads + 1, 'identity and membership use one source statement');
   const read = reads.at(-1);
   assert.equal(read.success, true); assert.equal(read.meta.rows_written, 0); assert.equal(read.meta.changed_db, false);
   assert.deepEqual(read.results, expectedRows);
   assert.equal(JSON.stringify(read.results).includes(email), false);
   assert.equal(await sourceSnapshot(), before); local.unchanged();
  };
  await checkReadOnly(async () => {
   const result = await plan(request(awaitedToken));
   assert.equal(result.principalId, ids.legacy); assert.equal(result.authActivated, false);
   assert.equal(JSON.stringify(result).includes(email), false);
  }, [{ id: ids.legacy, member_user_id: ids.legacy }]);
  await db.prepare('DELETE FROM workspace_members').run();
  await checkReadOnly(() => planRejects(() => plan(request(awaitedToken)), 'MIGRATION_SOURCE_MEMBERSHIP_MISMATCH'), [{ id: ids.legacy, member_user_id: null }]);
  await db.prepare('INSERT INTO workspace_members VALUES(?,?)').bind(ids.workspace, ids.legacy).run();
  await db.prepare('UPDATE users SET email=? WHERE id=?').bind(email, ids.other).run();
  await checkReadOnly(() => planRejects(() => plan(request(awaitedToken)), 'MIGRATION_LEGACY_USER_AMBIGUOUS'),
   [{ id: ids.legacy, member_user_id: ids.legacy }, { id: ids.other, member_user_id: null }]);
  await db.prepare('UPDATE users SET email=? WHERE id=?').bind(email.toLowerCase(), ids.other).run();
  await db.prepare('DELETE FROM users WHERE id=?').bind(ids.legacy).run();
  await checkReadOnly(() => planRejects(() => plan(request(awaitedToken)), 'MIGRATION_LEGACY_USER_MISSING'), []);
  await db.prepare('INSERT INTO users VALUES(?,?)').bind(ids.legacy, email).run();
  expireAfterRead = true;
  await checkReadOnly(() => planRejects(() => plan(request(awaitedToken)), 'MIGRATION_EVIDENCE_EXPIRED'), [{ id: ids.legacy, member_user_id: ids.legacy }]);
 } finally { await mf.dispose(); }
});
