// Read-only continuity for d398 api_tokens. This verifies the original secret;
// it never issues credentials, enrolls principals, or writes legacy last_used_at.
import { AuthError, authenticateServicePerimeter } from './auth.mjs';
export const LEGACY_API_TOKEN_MODE = 'd39852-api-tokens-v1';
const id = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const deny = (code = 'UNAUTHENTICATED', status = 401) => { throw new AuthError(code, status); };
const unavailable = () => deny('AUTH_INFRASTRUCTURE_UNAVAILABLE', 503);

// Kept equivalent to apps/api/src/auth/scopes.ts at d39852cef35217bc1dbf4c42d646bda1f09994d3.
export function parseLegacyScopes(raw) {
 if (!raw) return [];
 if (typeof raw !== 'string') return [];
 try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed.filter(scope => typeof scope === 'string') : []; }
 catch { const match = raw.match(/^\s*\[(.*)\]\s*$/); return match ? match[1].split(',').map(scope => scope.trim()).filter(Boolean) : []; }
}
export function legacyApiTokenMode(env) {
 if (env.LEGACY_API_TOKEN_AUTH === undefined) return false;
 if (env.LEGACY_API_TOKEN_AUTH !== LEGACY_API_TOKEN_MODE) unavailable();
 if (typeof env.DB?.prepare !== 'function') unavailable();
 return true;
}
// Bearer extraction grants nothing; a co-present service assertion is verified
// independently below, before any D1 credential lookup.
export function legacyBearerFrom(request,{ignoreAccessCredentials=false}={}) {
 const header = request.headers.get('authorization');
 const cookies = request.headers.get('cookie') ?? '';
 if (cookies.length > 32768 || cookies.split(';').some(cookie => {
  const name=cookie.trim().split('=',1)[0];
  return name==='__Host-projektor_session'||!ignoreAccessCredentials&&name==='CF_Authorization';
 })) deny('AUTH_CREDENTIAL_AMBIGUOUS');
 if (!header?.startsWith('Bearer ')) deny();
 const token = header.slice(7);
 if (!token || token.length > 8192 || !/^[\x21-\x7e]+$/.test(token)) deny();
 // Only the pinned OAuth provider can authenticate OAuth tokens. Never interpret
 // userId:grantId:secret as an API token or trust a grant ID from its raw bearer.
 if (token.includes(':')) deny();
 return token;
}
export function createLegacyApiTokenVerifier({ sourceDb, providerConfig, accessPerimeter='cloudflare', now = Date.now }) {
 if (typeof sourceDb?.prepare !== 'function' || typeof now !== 'function') unavailable();
 if(!['cloudflare','none'].includes(accessPerimeter))unavailable();
 return async function verify(request, workspaceId) {
  if (!id(workspaceId)) deny();
  // In the explicitly selected app-owned mode, Access headers/cookies are
  // inert metadata. Only the existing application bearer can authenticate.
  const token = legacyBearerFrom(request,{ignoreAccessCredentials:accessPerimeter==='none'});
  const perimeter = accessPerimeter==='cloudflare'&&request.headers.has('cf-access-jwt-assertion')
   ? await authenticateServicePerimeter(request, providerConfig) : null;
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const hash = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
  let rows;
  try {
   // Selected-workspace membership also covers global PATs. No email, names,
   // secret or hash is selected. LIMIT 2 detects ambiguous/corrupt source rows.
   const result = await sourceDb.prepare(`SELECT at.id, at.workspace_id, at.expires_at, at.scopes,
    at.issued_by_user_id, u.id AS user_id, wm.role AS member_role
    FROM api_tokens at LEFT JOIN users u ON u.id = at.user_id
    LEFT JOIN workspace_members wm ON wm.user_id = at.user_id AND wm.workspace_id = ?
    WHERE at.token_hash = ? LIMIT 2`).bind(workspaceId, hash).all();
   if (result?.success !== true || !Array.isArray(result.results) || result.results.length > 2) unavailable();
   rows = result.results;
  } catch { unavailable(); }
  if (rows.length !== 1) deny();
  const row = rows[0], authenticatedAt = now();
  if (!Number.isSafeInteger(authenticatedAt) || authenticatedAt < 0) unavailable();
  if (!id(row.id) || !id(row.user_id) || row.workspace_id !== null && !id(row.workspace_id) || row.issued_by_user_id !== null && !id(row.issued_by_user_id)) deny();
  if (row.workspace_id !== null && row.workspace_id !== workspaceId) deny('WORKSPACE_MISMATCH', 403);
  if (!['owner', 'admin', 'member', 'viewer'].includes(row.member_role)) deny('FORBIDDEN', 403);
  if (row.expires_at !== null && (!Number.isSafeInteger(row.expires_at) || row.expires_at < 0 || !Number.isSafeInteger(row.expires_at * 1000))) deny();
  const credentialExpiresAt = Math.min(row.expires_at === null ? Number.MAX_SAFE_INTEGER : row.expires_at * 1000, perimeter?.credentialExpiresAt ?? Number.MAX_SAFE_INTEGER);
  if (credentialExpiresAt <= authenticatedAt) deny('CREDENTIAL_EXPIRED');
  const scopes = parseLegacyScopes(row.scopes);
  const machine = row.issued_by_user_id !== null && row.issued_by_user_id !== row.user_id;
  // This role clamp belongs only to an explicitly delegated machine principal.
  // A human-owned PAT retains its human principal and current resource grants.
  if (machine && (row.workspace_id === null || row.member_role !== 'member' || row.expires_at === null || !scopes.length || scopes.some(scope => scope !== 'read' && scope !== 'write'))) deny('FORBIDDEN', 403);
  const write = scopes.includes('*') || scopes.includes('write');
  const read = write || scopes.includes('read');
  if (!read) deny('FORBIDDEN', 403);
  return Object.freeze({ source: 'legacy_api_token', principalId: row.user_id, credentialId: row.id,
   principalKind: machine ? 'machine' : 'human', actorKind: 'machine',
   authMethod: token.startsWith('pk_') ? 'pk' : 'pat', credentialExpiresAt, authenticatedAt,
   legacyCapabilities: Object.freeze({ read, write }), requestId: crypto.randomUUID() });
 };
}
