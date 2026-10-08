// Provider verification only: enrollment, token issuance and authorization live elsewhere.
// Cloudflare Access claims/transport: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/
// Web Crypto contract: https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
const COOKIE = 'CF_Authorization';
const MAX_TOKEN_BYTES = 8192;
const MAX_JWKS_BYTES = 65536;
const MAX_KEYS = 16;
const REFRESH_INTERVAL_MS = 5000;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, name) => Object.prototype.hasOwnProperty.call(value, name);
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\p{Cc}\p{Surrogate}]/u.test(value);
const kidValid = value => typeof value === 'string' && /^[\x21-\x7e]{1,128}$/.test(value);
export class AuthError extends Error {
 constructor(code, status = 401) { super(code); this.name = 'AuthError'; this.code = code; this.status = status; }
}
const unauthenticated = () => new AuthError('UNAUTHENTICATED');
const unavailable = () => new AuthError('AUTH_INFRASTRUCTURE_UNAVAILABLE', 503);

// JSON.parse alone silently accepts duplicate security-sensitive members. Keep the
// accepted JSON grammar small and bounded, including unknown provider claims.
function json(source) {
 let index = 0;
 const whitespace = () => { while (/[\x20\t\r\n]/.test(source[index] || '\0')) index++; };
 function value(depth) {
  if (depth > 16) throw Error('JSON nesting limit');
  whitespace();
  const first = source[index];
  if (first === '"') {
   const match = /^"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(source.slice(index));
   if (!match) throw Error('Invalid JSON string');
   index += match[0].length;
   return JSON.parse(match[0]);
  }
  if (first === '{' || first === '[') {
   const object = first === '{';
   const result = object ? Object.create(null) : [];
   const end = object ? '}' : ']';
   index++; whitespace();
   if (source[index] === end) { index++; return result; }
   while (true) {
    let key;
    if (object) {
     whitespace();
     if (source[index] !== '"') throw Error('Invalid JSON member');
     key = value(depth + 1); whitespace();
     if (own(result, key) || source[index++] !== ':') throw Error('Duplicate or invalid JSON member');
    }
    const item = value(depth + 1);
    if (object) result[key] = item; else result.push(item);
    whitespace();
    const next = source[index++];
    if (next === end) return result;
    if (next !== ',') throw Error('Invalid JSON separator');
   }
  }
  const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(source.slice(index));
  if (!match) throw Error('Invalid JSON value');
  index += match[0].length;
  return JSON.parse(match[0]);
 }
 const result = value(0); whitespace();
 if (index !== source.length) throw Error('Trailing JSON data');
 return result;
}
function bytes(segment) {
 if (typeof segment !== 'string' || !/^[A-Za-z0-9_-]+$/.test(segment) || segment.length % 4 === 1) throw Error('Invalid base64url');
 const binary = atob(segment.replace(/-/g, '+').replace(/_/g, '/'));
 const canonical = btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
 if (canonical !== segment) throw Error('Noncanonical base64url');
 return Uint8Array.from(binary, character => character.charCodeAt(0));
}
function https(value, issuer = false) {
 if (!text(value, 2048) || value !== value.trim()) throw unavailable();
 let url;
 try { url = new URL(value); } catch { throw unavailable(); }
 if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash || (issuer && url.search)) throw unavailable();
 return value;
}
function settings(config) {
 const fields = ['issuer', 'jwksUrl', 'humanAudience', 'machineAudience', 'jwksCacheMs', 'jwksTimeoutMs'];
 if (!record(config) || Object.keys(config).some(key => !fields.includes(key))) throw unavailable();
 const issuer = https(config.issuer, true);
 const jwksUrl = https(config.jwksUrl);
 if (!text(config.humanAudience, 256) || !text(config.machineAudience, 256) || config.humanAudience === config.machineAudience) throw unavailable();
 const jwksCacheMs = own(config, 'jwksCacheMs') ? config.jwksCacheMs : 300000;
 const jwksTimeoutMs = own(config, 'jwksTimeoutMs') ? config.jwksTimeoutMs : 3000;
 if (!Number.isSafeInteger(jwksCacheMs) || jwksCacheMs < REFRESH_INTERVAL_MS || jwksCacheMs > 3600000 ||
     !Number.isSafeInteger(jwksTimeoutMs) || jwksTimeoutMs < 50 || jwksTimeoutMs > 10000) throw unavailable();
 return Object.freeze({ issuer, jwksUrl, humanAudience: config.humanAudience, machineAudience: config.machineAudience, jwksCacheMs, jwksTimeoutMs });
}
function tokenFrom(request, kind) {
 if (kind !== 'human' && kind !== 'machine') throw unauthenticated();
 const authorization = request.headers.get('authorization');
 const assertion = request.headers.get('cf-access-jwt-assertion');
 const cookies = request.headers.get('cookie') || '';
 if (cookies.length > 32768) throw unauthenticated();
 const matches = cookies.split(';').map(cookie => cookie.trim()).filter(cookie => cookie.split('=', 1)[0] === COOKIE);
 if (matches.length > 1 || (authorization !== null && (matches.length || assertion !== null))) throw new AuthError('AUTH_CREDENTIAL_AMBIGUOUS');
 let token;
 if (kind === 'machine') {
  if (matches.length || assertion !== null || !/^Bearer [A-Za-z0-9_.-]+$/i.test(authorization || '')) throw unauthenticated();
  token = authorization.slice(7);
 } else {
  if (authorization !== null || (!matches.length && assertion === null)) throw unauthenticated();
  if (matches.length && !matches[0].startsWith(`${COOKIE}=`)) throw unauthenticated();
  const cookie = matches.length ? matches[0].slice(COOKIE.length + 1) : null;
  if (assertion !== null && cookie !== null && assertion !== cookie) throw new AuthError('AUTH_CREDENTIAL_AMBIGUOUS');
  // Access normally forwards both copies. Match them before choosing the header.
  token = assertion ?? cookie;
 }
 if (!token || token.length > MAX_TOKEN_BYTES) throw unauthenticated();
 return token;
}
function claimsValid(claims, config, kind, nowMs, checkExpiry = true) {
 const audience = kind === 'human' ? config.humanAudience : config.machineAudience;
 if (!record(claims) || claims.iss !== config.issuer || claims.type !== 'app' || !Array.isArray(claims.aud) ||
     !claims.aud.length || claims.aud.length > 16 || claims.aud.some(aud => !text(aud, 256)) ||
     new Set(claims.aud).size !== claims.aud.length || !claims.aud.includes(audience)) throw unauthenticated();
 if (kind === 'human') {
  // Cloudflare Access identity-based application token, not the org session or
  // service-token variant. Custom cid/wid/kind/roles never grant application access.
  if (!text(claims.sub, 200) || own(claims, 'common_name')) throw unauthenticated();
 } else {
  // Access service-token application JWT, already exchanged upstream. Never
  // accept a client secret here. The app DB maps issuer/common_name/kind itself.
  if (claims.sub !== '' || !text(claims.common_name, 200)) throw unauthenticated();
 }
 const nbf = kind === 'machine' && !own(claims, 'nbf') ? claims.iat : claims.nbf;
 if (![claims.iat, nbf, claims.exp].every(value => Number.isSafeInteger(value) && value >= 0 && Number.isSafeInteger(value * 1000)) ||
     claims.exp <= claims.iat || claims.exp <= nbf || nbf * 1000 > nowMs || claims.iat * 1000 > nowMs) throw unauthenticated();
 if (checkExpiry && claims.exp * 1000 <= nowMs) throw new AuthError(kind === 'machine' ? 'CREDENTIAL_EXPIRED' : 'SESSION_EXPIRED');
}
async function importKeys(document) {
 if (!record(document) || Object.keys(document).some(key => !['keys', 'public_cert', 'public_certs'].includes(key)) || !Array.isArray(document.keys) || !document.keys.length || document.keys.length > MAX_KEYS) throw unavailable();
 // Access publishes PEM copies too; validate their bounded shape, never import
 // them or follow certificate URLs. Key selection uses only the JWK kid.
 const pem = value => record(value) && Object.keys(value).every(key => ['kid', 'cert'].includes(key)) && kidValid(value.kid) && typeof value.cert === 'string' && value.cert.length > 0 && value.cert.length <= 16384;
 if ((own(document, 'public_cert') && !pem(document.public_cert)) ||
     (own(document, 'public_certs') && (!Array.isArray(document.public_certs) || document.public_certs.length > MAX_KEYS || document.public_certs.some(value => !pem(value))))) throw unavailable();
 const keys = new Map();
 const fields = ['kty', 'kid', 'n', 'e', 'alg', 'use', 'key_ops', 'ext', 'x5c', 'x5t', 'x5t#S256'];
 for (const jwk of document.keys) {
  if (!record(jwk) || Object.keys(jwk).some(key => !fields.includes(key)) || jwk.kty !== 'RSA' || !kidValid(jwk.kid) || keys.has(jwk.kid) ||
      (own(jwk, 'alg') && jwk.alg !== 'RS256') || (own(jwk, 'use') && jwk.use !== 'sig') ||
      (own(jwk, 'key_ops') && (!Array.isArray(jwk.key_ops) || jwk.key_ops.length !== 1 || jwk.key_ops[0] !== 'verify')) ||
      (own(jwk, 'ext') && typeof jwk.ext !== 'boolean')) throw unavailable();
  if (own(jwk, 'x5c') && (!Array.isArray(jwk.x5c) || !jwk.x5c.length || jwk.x5c.length > 4 || jwk.x5c.some(cert => !text(cert, 8192) || !/^[A-Za-z0-9+/]+={0,2}$/.test(cert)))) throw unavailable();
  for (const field of ['x5t', 'x5t#S256']) if (own(jwk, field) && bytes(jwk[field]).length !== (field === 'x5t' ? 20 : 32)) throw unavailable();
  const modulus = bytes(jwk.n);
  const exponent = bytes(jwk.e);
  const bits = modulus.length * 8 - Math.clz32(modulus[0]) + 24;
  let exponentValue = 0;
  for (const byte of exponent) exponentValue = exponentValue * 256 + byte;
  if (modulus[0] === 0 || bits < 2048 || bits > 8192 || !(modulus.at(-1) & 1) || exponent.length > 4 || exponent[0] === 0 || exponentValue < 3 || !(exponentValue & 1)) throw unavailable();
  const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', key_ops: ['verify'], ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  keys.set(jwk.kid, key);
 }
 return keys;
}
async function fetchKeys(config, fetchImpl) {
 const controller = new AbortController();
 let reader;
 let responseBody;
 let timer;
 const deadline = new Promise((_, reject) => {
  timer = setTimeout(() => {
   reject(unavailable());
   controller.abort();
   if (reader) void reader.cancel().catch(() => {});
  }, config.jwksTimeoutMs);
 });
 try {
  return await Promise.race([deadline, (async () => {
   const response = await fetchImpl(config.jwksUrl, {
    method: 'GET', redirect: 'manual', cache: 'no-store', credentials: 'omit', signal: controller.signal,
    headers: { accept: 'application/jwk-set+json, application/json' },
   });
   responseBody = response.body;
   if (controller.signal.aborted) { void responseBody?.cancel().catch(() => {}); throw unavailable(); }
   if (response.status !== 200 || response.redirected || (response.url && response.url !== new URL(config.jwksUrl).href) || !response.body) throw unavailable();
   const mediaType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
   if (!['application/json', 'application/jwk-set+json'].includes(mediaType)) throw unavailable();
   const contentLength = response.headers.get('content-length');
   if (contentLength !== null && (!/^[0-9]+$/.test(contentLength) || Number(contentLength) > MAX_JWKS_BYTES)) throw unavailable();
   reader = response.body.getReader();
   const chunks = [];
   let size = 0;
   while (true) {
    const chunk = await reader.read();
    if (controller.signal.aborted) throw unavailable();
    if (chunk.done) break;
    if (!(chunk.value instanceof Uint8Array) || (size += chunk.value.byteLength) > MAX_JWKS_BYTES) throw unavailable();
    chunks.push(chunk.value);
   }
   const body = new Uint8Array(size);
   let offset = 0;
   for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
   return await importKeys(json(decoder.decode(body)));
  })()]);
 } catch { throw unavailable(); }
 finally {
  clearTimeout(timer);
  controller.abort();
  if (reader) void reader.cancel().catch(() => {});
  else if (responseBody) void responseBody.cancel().catch(() => {});
 }
}

// Test seams are deliberately on this factory, never on request headers or env.
// now() returns epoch milliseconds. The returned callable is verifier(request, kind).
export function createVerifier(config, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
 config = settings(config);
 if (typeof fetchImpl !== 'function' || typeof now !== 'function') throw unavailable();
 let keys = new Map();
 let expiresAt = -Infinity;
 let lastAttempt = -Infinity;
 let lastFailure = false;
 let inflight;
 const time = () => {
  const result = now();
  if (!Number.isSafeInteger(result) || result < 0) throw unavailable();
  return result;
 };
 async function keyFor(kid) {
  const current = time();
  if (current < expiresAt && keys.has(kid)) return keys.get(kid);
  if (!inflight) {
   // Global to this verifier, not keyed by attacker-controlled kid. This bounds
   // unknown-kid storms, repeated outages and concurrent first-use refreshes.
   if (current - lastAttempt < REFRESH_INTERVAL_MS) {
    if (current >= expiresAt || lastFailure) throw unavailable();
    throw unauthenticated();
   }
   lastAttempt = current;
   inflight = (async () => {
    try {
     const refreshed = await fetchKeys(config, fetchImpl);
     const fetchedAt = time();
     keys = refreshed; // Atomic replacement retires removed keys; no stale union.
     expiresAt = fetchedAt + config.jwksCacheMs;
     lastFailure = false;
    } catch (error) { lastFailure = true; throw error; }
    finally { inflight = undefined; }
   })();
  }
  await inflight;
  const key = keys.get(kid);
  if (!key) throw unauthenticated();
  return key;
 }
 return async function verify(request, kind) {
  const token = tokenFrom(request, kind);
  let header, claims, signature, parts;
  try {
   parts = token.split('.');
   if (parts.length !== 3) throw Error('JWT shape');
   header = json(decoder.decode(bytes(parts[0])));
   claims = json(decoder.decode(bytes(parts[1])));
   signature = bytes(parts[2]);
   if (!record(header) || Object.keys(header).some(key => !['alg', 'typ', 'kid'].includes(key)) || header.alg !== 'RS256' || !kidValid(header.kid) ||
       (own(header, 'typ') && !['JWT', 'at+jwt'].includes(header.typ)) || signature.length < 256 || signature.length > 1024) throw Error('JWT header');
   // Cheap untrusted input filtering does not confer identity or authorization.
   claimsValid(claims, config, kind, time(), false);
  } catch (error) { if (error instanceof AuthError) throw error; throw unauthenticated(); }
  const key = await keyFor(header.kid);
  let verified;
  try { verified = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, encoder.encode(`${parts[0]}.${parts[1]}`)); }
  catch { throw unauthenticated(); }
  if (!verified) throw unauthenticated();
  const authenticatedAt = time();
  claimsValid(claims, config, kind, authenticatedAt);
  return Object.freeze({ issuer: claims.iss, subject: kind === 'human' ? claims.sub : claims.common_name,
   actorKind: kind, credentialExpiresAt: claims.exp * 1000, authMethod: kind === 'machine' ? 'cloudflare_access_service_token' : 'cloudflare_access',
   authenticatedAt, requestId: crypto.randomUUID() });
 };
}

// Config is operator-controlled. Bounded memoization preserves JWKS caching even
// when the runtime passes a new env wrapper; no test/local issuer fallback exists.
const verifiers = new Map();
export async function authenticate(request, env, kind) {
 const serialized = env?.PROVIDER_CONFIG;
 if (typeof serialized !== 'string' || !serialized || serialized.length > 8192) throw unavailable();
 let verifier = verifiers.get(serialized);
 if (!verifier) {
  let config;
  try { config = json(serialized); } catch { throw unavailable(); }
  verifier = createVerifier(config);
  if (verifiers.size >= 4) verifiers.delete(verifiers.keys().next().value);
  verifiers.set(serialized, verifier);
 }
 return verifier(request, kind);
}
