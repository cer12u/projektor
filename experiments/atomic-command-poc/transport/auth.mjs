// Local issuer profile only. This does not implement Access/OAuth enrollment.
const id = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export class AuthError extends Error { constructor(code, status = 401) { super(code); this.code = code; this.status = status; } }
function decode(segment) {
 if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new AuthError('UNAUTHENTICATED');
 const bytes = Uint8Array.from(atob(segment.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
 return bytes;
}
export async function authenticate(request, env, kind) {
 const bearer = request.headers.get('authorization');
 const cookies = request.headers.get('cookie') || '';
 const assertions = request.headers.get('cf-access-jwt-assertion');
 const matches = [...cookies.matchAll(/(?:^|;\s*)projektor_test_session=([^;]*)/g)];
 if (assertions || (bearer && matches.length) || matches.length > 1) throw new AuthError('AUTH_CREDENTIAL_AMBIGUOUS');
 let token;
 if (kind === 'machine') {
  if (matches.length || !/^Bearer [A-Za-z0-9_.-]+$/.test(bearer || '')) throw new AuthError('UNAUTHENTICATED');
  token = bearer.slice(7);
 } else {
  if (bearer || matches.length !== 1) throw new AuthError('UNAUTHENTICATED');
  token = matches[0][1];
 }
 if (token.length > 8192) throw new AuthError('UNAUTHENTICATED');
 let header, claims, signature;
 const parts = token.split('.');
 try {
  if (parts.length !== 3) throw new Error();
  header = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(decode(parts[0])));
  claims = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(decode(parts[1])));
  signature = decode(parts[2]);
 } catch { throw new AuthError('UNAUTHENTICATED'); }
 if (!header || header.alg !== 'RS256' || header.typ !== 'projektor-local+jwt' || header.kid !== 'ephemeral-test-key' || Object.keys(header).some(k => !['alg','typ','kid'].includes(k))) throw new AuthError('UNAUTHENTICATED');
 let key;
 try { key = await crypto.subtle.importKey('jwk', JSON.parse(env.TEST_PUBLIC_JWK), {name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'}, false, ['verify']); }
 catch { throw new AuthError('AUTH_INFRASTRUCTURE_UNAVAILABLE',503); }
 if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,signature,new TextEncoder().encode(parts.slice(0,2).join('.')))) throw new AuthError('UNAUTHENTICATED');
 if (!claims || claims.iss !== env.TEST_ISSUER || claims.aud !== `projektor-local-${kind}` || claims.kind !== kind || typeof claims.sub !== 'string' || claims.sub.length > 200 || !claims.sub || typeof claims.cid !== 'string' || !id.test(claims.cid) || typeof claims.wid !== 'string' || !id.test(claims.wid)) throw new AuthError('UNAUTHENTICATED');
 const now = Date.now()/1000;
 if (![claims.exp,claims.iat,claims.nbf].every(Number.isSafeInteger) || !Number.isSafeInteger(claims.exp*1000) || claims.nbf > now || claims.iat > now || claims.exp <= claims.iat) throw new AuthError('UNAUTHENTICATED');
 if (claims.exp <= now) throw new AuthError(kind === 'machine' ? 'CREDENTIAL_EXPIRED' : 'SESSION_EXPIRED');
 return {issuer:claims.iss,subject:claims.sub,credentialId:claims.cid,workspaceId:claims.wid,actorKind:kind,credentialExpiresAt:claims.exp*1000,authMethod:kind==='machine'?'local_test_bearer':'local_test_cookie',authenticatedAt:Date.now(),requestId:crypto.randomUUID()};
}
