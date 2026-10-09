// OFFLINE MIGRATION PLAN ONLY. No route, enrollment, SQL writes, credential
// issuance, membership changes, provider setup, or authentication activation.
import { createMigrationOnlyAccessEvidenceReader } from '../service/auth.mjs';

export class IdentityContinuityPlanError extends Error {
 constructor(code) { super(code); this.name = 'IdentityContinuityPlanError'; this.code = code; }
}
const stop = code => { throw new IdentityContinuityPlanError(code); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const all = (db, sql, ...args) => {
 try {
  const rows = db.prepare(sql).all(...args);
  if (!Array.isArray(rows) || rows.length > 2) stop('MIGRATION_SNAPSHOT_INVALID');
  return rows;
 } catch { stop('MIGRATION_SNAPSHOT_UNAVAILABLE'); }
};
async function sourceIdentityRows(db, workspaceId, email) {
 try {
  // One statement observes identity and membership together, including on D1.
  // Only IDs cross this read boundary; never return or export the email column.
  const statement = db.prepare('SELECT u.id, m.user_id AS member_user_id FROM users u LEFT JOIN workspace_members m ON m.user_id = u.id AND m.workspace_id = ? WHERE u.email = ? COLLATE BINARY LIMIT 2');
  let rows;
  if (typeof statement.bind === 'function') {
   const result = await statement.bind(workspaceId, email).all();
   if (!record(result) || result.success !== true) stop('MIGRATION_SNAPSHOT_UNAVAILABLE');
   rows = result.results;
  } else rows = statement.all(workspaceId, email);
  if (!Array.isArray(rows) || rows.length > 2) stop('MIGRATION_SNAPSHOT_INVALID');
  return rows;
 } catch { stop('MIGRATION_SNAPSHOT_UNAVAILABLE'); }
}

// Source supports SQLite all(...args) or D1 bind(...args).all() -> {results}.
// Target must be a controlled, consistent synchronous frozen snapshot. This
// planner only issues SELECTs. Never connect it to public ingress.
// Source-boundary data is operator-reviewed evidence, never request input.
export function createLegacyIdentityContinuityPlanner({ providerConfig, sourceBoundary,
 sourceDb, targetDb, workspaceId, workspaceEpoch, expectedPrincipalId }, verifierOptions) {
 if (![workspaceId, workspaceEpoch, expectedPrincipalId].every(id) ||
     typeof sourceDb?.prepare !== 'function' || typeof targetDb?.prepare !== 'function' ||
     !record(providerConfig) || !record(sourceBoundary) ||
     Object.keys(sourceBoundary).sort().join(',') !== 'emailVerification,humanAudience,issuer' ||
     !['signed_access_email', 'email_verified_claim'].includes(sourceBoundary.emailVerification)) stop('MIGRATION_PLAN_CONFIG_INVALID');
 if (sourceBoundary.issuer !== providerConfig.issuer || sourceBoundary.humanAudience !== providerConfig.humanAudience) stop('MIGRATION_PROVIDER_MISMATCH');
 const requireEmailVerified = sourceBoundary.emailVerification === 'email_verified_claim';
 const readEvidence = createMigrationOnlyAccessEvidenceReader(providerConfig, verifierOptions);
 const now = verifierOptions?.now ?? Date.now;
 return async function planLegacyIdentityContinuity(request) {
  const evidence = await readEvidence(request);
  if (evidence.emailVerified === false || (requireEmailVerified && evidence.emailVerified !== true)) stop('MIGRATION_EMAIL_UNVERIFIED');
  // The old public viewer is shared anonymous authority, never an Access person.
  if (evidence.email === 'public-viewer@projektor.local') stop('MIGRATION_SHARED_IDENTITY_REJECTED');
  // Exact BINARY match preserves legacy users.email identity, including case. No
  // trimming, case folding, alias matching, owner inference, or upsert is allowed.
  const users = await sourceIdentityRows(sourceDb, workspaceId, evidence.email);
  if (!users.length) stop('MIGRATION_LEGACY_USER_MISSING');
  if (users.length > 1) stop(users[0].id === users[1].id ? 'MIGRATION_SOURCE_MEMBERSHIP_MISMATCH' : 'MIGRATION_LEGACY_USER_AMBIGUOUS');
  const legacyUserId = users[0].id;
  if (!id(legacyUserId) || legacyUserId !== expectedPrincipalId) stop('MIGRATION_PRINCIPAL_MISMATCH');
  if (users[0].member_user_id !== legacyUserId) stop('MIGRATION_SOURCE_MEMBERSHIP_MISMATCH');
  // Async source reads must not turn an expired provider assertion into a plan.
  const checkedAt = now();
  if (!Number.isSafeInteger(checkedAt) || checkedAt < evidence.authenticatedAt) stop('MIGRATION_CLOCK_INVALID');
  if (checkedAt >= evidence.credentialExpiresAt) stop('MIGRATION_EVIDENCE_EXPIRED');
  const workspaces = all(targetDb, 'SELECT id, epoch, active FROM workspace LIMIT 2');
  if (workspaces.length !== 1 || workspaces[0].id !== workspaceId || workspaces[0].epoch !== workspaceEpoch) stop('MIGRATION_TARGET_WORKSPACE_MISMATCH');
  if (workspaces[0].active !== 0) stop('MIGRATION_TARGET_NOT_FROZEN');
  const members = all(targetDb, 'SELECT principal_id, kind, revoked FROM membership WHERE principal_id = ? LIMIT 2', legacyUserId);
  if (members.length !== 1 || !['human', 'legacy_unbound'].includes(members[0].kind)) stop('MIGRATION_TARGET_MEMBERSHIP_MISMATCH');
  if (members[0].revoked !== 0) stop('MIGRATION_MEMBERSHIP_REVOKED');
  // Conflicting forward OR reverse bindings require review; this planner does
  // not silently relink a subject, merge accounts, or add another login identity.
  const bindings = all(targetDb, 'SELECT issuer, subject, credential_id, principal_id, kind FROM identity_binding WHERE (issuer = ? AND subject = ?) OR principal_id = ? LIMIT 2', evidence.issuer, evidence.subject, legacyUserId);
  if (bindings.length > 1) stop('MIGRATION_IDENTITY_BINDING_AMBIGUOUS');
  if (bindings.length) {
   const binding = bindings[0];
   if (binding.issuer !== evidence.issuer || binding.subject !== evidence.subject || binding.principal_id !== legacyUserId || binding.kind !== 'human') stop('MIGRATION_IDENTITY_BINDING_COLLISION');
   const credentials = all(targetDb, 'SELECT principal_id, revoked, expires_at FROM credential WHERE id = ? LIMIT 2', binding.credential_id);
   if (credentials.length !== 1 || credentials[0].principal_id !== legacyUserId) stop('MIGRATION_CREDENTIAL_MISMATCH');
   if (credentials[0].revoked !== 0) stop('MIGRATION_CREDENTIAL_REVOKED');
   if (!Number.isSafeInteger(credentials[0].expires_at) || credentials[0].expires_at <= checkedAt) stop('MIGRATION_CREDENTIAL_EXPIRED');
  }
  // This is deliberately not an ActorContext, session, credential or SQL record.
  // No credential handle is emitted and no authority is created or enlarged.
  return Object.freeze({ mode: 'migration_plan_only', authActivated: false, workspaceId, workspaceEpoch,
   legacyUserId, principalId: legacyUserId,
   provider: Object.freeze({ issuer: evidence.issuer, subject: evidence.subject, kind: 'human' }),
   existingBinding: bindings.length ? 'matches' : 'absent' });
 };
}
