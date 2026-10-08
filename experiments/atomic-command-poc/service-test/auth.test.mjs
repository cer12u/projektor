import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticate, AuthError, createVerifier } from '../service/auth.mjs';

const NOW = 1791424800000;
const config = Object.freeze({ issuer: 'https://test-team.cloudflareaccess.com', jwksUrl: 'https://test-team.cloudflareaccess.com/cdn-cgi/access/certs', humanAudience: 'human-application-audience', machineAudience: 'machine-projektor', jwksCacheMs: 10000, jwksTimeoutMs: 1000 });
const subject = '7335d417-61da-459d-899c-0a01c76a2f94';
const machineSubject = 'e367826f93b8d71185e03fe518aff3b4.access';
const cid = '2f077d73-e685-4e52-82f8-f899450df81b';
const wid = '515bb2d7-759f-4d4b-ad65-7b8e4240dcc7';
const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
async function makeKey(kid) {
 const pair = await crypto.subtle.generateKey({ ...algorithm, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ['sign', 'verify']);
 return { pair, jwk: { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid, use: 'sig' } };
}
const [first, second] = await Promise.all([makeKey('first'), makeKey('second')]);
const encode = value => Buffer.from(value).toString('base64url');
function claims(kind = 'human', changes = {}) {
 return { iss: config.issuer, sub: kind === 'human' ? subject : '', aud: [kind === 'human' ? config.humanAudience : config.machineAudience],
  ...(kind === 'human' ? { type: 'app', email: 'synthetic@example.test', identity_nonce: 'synthetic-nonce' } : { type: 'app', common_name: machineSubject }),
  iat: NOW / 1000 - 30, nbf: NOW / 1000 - 30, exp: NOW / 1000 + 7200, ...changes };
}
async function sign({ key = first, kind = 'human', changes = {}, header = {}, rawClaims, rawHeader } = {}) {
 const input = `${encode(rawHeader ?? JSON.stringify({ alg: 'RS256', kid: key.jwk.kid, typ: 'JWT', ...header }))}.${encode(rawClaims ?? JSON.stringify(claims(kind, changes)))}`;
 return `${input}.${encode(new Uint8Array(await crypto.subtle.sign(algorithm.name, key.pair.privateKey, new TextEncoder().encode(input))))}`;
}
const request = (token, kind = 'human', headers = {}) => new Request('https://projektor.example.test/v1/me', { headers: { ...(kind === 'human' ? { cookie: `CF_Authorization=${token}` } : { authorization: `Bearer ${token}` }), ...headers } });
const jwks = (keys = [first.jwk], options) => new Response(JSON.stringify({ keys }), { headers: { 'content-type': 'application/json' }, ...options });
function fixture({ configChanges = {}, fetchImpl, keys = [first.jwk] } = {}) {
 let now = NOW;
 const calls = [];
 const verify = createVerifier({ ...config, ...configChanges }, { now: () => now, fetchImpl: async (...args) => {
  calls.push(args);
  return fetchImpl ? fetchImpl(...args) : jwks(keys);
 } });
 return { verify, calls, advance: ms => { now += ms; }, setTime: value => { now = value; } };
}
async function rejects(action, code = 'UNAUTHENTICATED', status = 401) {
 await assert.rejects(action, error => error instanceof AuthError && error.code === code && error.status === status);
}
const unavailable = action => rejects(action, 'AUTH_INFRASTRUCTURE_UNAVAILABLE', 503);

test('Cloudflare Access human token maps only verified provider identity, not JWT roles or application IDs', async () => {
 const f = fixture();
 const token = await sign({ changes: { roles: ['admin'], scope: '*', wid, cid, kind: 'machine', principalId: 'attacker' } });
 const identity = await f.verify(request(token), 'human');
 assert.deepEqual(identity, { issuer: config.issuer, subject, actorKind: 'human', credentialExpiresAt: (NOW / 1000 + 7200) * 1000,
  authMethod: 'cloudflare_access', authenticatedAt: NOW, requestId: identity.requestId });
 assert.match(identity.requestId, /^[0-9a-f-]{36}$/);
 assert.equal(Object.isFrozen(identity), true);
 assert.equal(f.calls.length, 1);
 assert.equal(f.calls[0][0], config.jwksUrl);
 assert.equal(f.calls[0][1].redirect, 'manual');
 assert.equal(f.calls[0][1].credentials, 'omit');
 assert.equal(f.calls[0][1].headers.authorization, undefined);
});

test('Access assertion header and cookie fallback both work; identical copies are allowed', async () => {
 const f = fixture(); const token = await sign();
 await f.verify(new Request('https://app.test', { headers: { 'cf-access-jwt-assertion': token } }), 'human');
 await f.verify(request(token, 'human', { 'cf-access-jwt-assertion': token }), 'human');
 await f.verify(request(token, 'human', { cookie: `unrelated=value; CF_Authorization=${token}; another=x` }), 'human');
 assert.equal(f.calls.length, 1);
});

test('Access service-token machine identity has no application IDs and stays separate from human JWTs', async () => {
 const f = fixture(); const token = await sign({ kind: 'machine' });
 const identity = await f.verify(request(token, 'machine'), 'machine');
 assert.equal(identity.credentialId, undefined); assert.equal(identity.workspaceId, undefined);
 assert.equal(identity.subject, machineSubject);
 assert.equal(identity.actorKind, 'machine'); assert.equal(identity.authMethod, 'cloudflare_access_service_token');
 const withoutNbf = await sign({ kind: 'machine', changes: { nbf: undefined } });
 await f.verify(request(withoutNbf, 'machine'), 'machine');
 await rejects(() => f.verify(request(token), 'human'));
 await rejects(() => f.verify(request(token, 'machine'), 'human'));
 const human = await sign();
 await rejects(() => f.verify(request(human, 'machine'), 'machine'));
});

test('ambiguous credentials fail before contacting the provider', async () => {
 const f = fixture(); const token = await sign();
 for (const headers of [
  { cookie: `CF_Authorization=${token}; CF_Authorization=${token}` },
  { 'cf-access-jwt-assertion': `${token}x` },
  { authorization: `Bearer ${token}` },
 ]) await rejects(() => f.verify(request(token, 'human', headers), 'human'), 'AUTH_CREDENTIAL_AMBIGUOUS');
 await rejects(() => f.verify(new Request('https://app.test', { headers: { authorization: `Bearer ${token}`, 'cf-access-jwt-assertion': token } }), 'machine'), 'AUTH_CREDENTIAL_AMBIGUOUS');
 assert.equal(f.calls.length, 0);
});

test('missing, local-test, oversized and malformed transport credentials fail closed', async () => {
 const f = fixture(); const token = await sign();
 for (const headers of [{}, { cookie: `projektor_test_session=${token}` }, { cookie: `__Host-projektor_session=${token}` }, { cookie: 'CF_Authorization' }, { cookie: 'CF_Authorization=' }, { cookie: `CF_Authorization=${'a'.repeat(8193)}` }, { 'cf-access-jwt-assertion': '' }]) {
  await rejects(() => f.verify(new Request('https://app.test', { headers }), 'human'));
 }
 for (const authorization of ['Basic xyz', 'Bearer a b', 'Bearer ', 'Bearer a,b']) await rejects(() => f.verify(new Request('https://app.test', { headers: { authorization } }), 'machine'));
 await rejects(() => f.verify(request(token), 'admin'));
 assert.equal(f.calls.length, 0);
});

test('Access org tokens and service-token identities cannot authenticate as humans', async () => {
 const f = fixture();
 for (const changes of [{ type: 'org' }, { type: undefined }, { sub: '' }, { sub: null }, { common_name: 'service.access' }, { sub: '', common_name: 'service.access' }]) {
  const token = await sign({ changes }); await rejects(() => f.verify(request(token), 'human'));
 }
 assert.equal(f.calls.length, 0);
});

test('exact issuer and bounded application audience array are required', async () => {
 const f = fixture();
 for (const changes of [{ iss: 'https://other.cloudflareaccess.com' }, { iss: `${config.issuer}/` }, { aud: config.humanAudience }, { aud: [] }, { aud: [config.machineAudience] }, { aud: [config.humanAudience, 1] }, { aud: [config.humanAudience, config.humanAudience] }, { aud: Array(17).fill('other') }]) {
  const token = await sign({ changes }); await rejects(() => f.verify(request(token), 'human'));
 }
 const additionalAudience = await sign({ changes: { aud: ['another-app', config.humanAudience] } });
 await f.verify(request(additionalAudience), 'human');
 assert.equal(f.calls.length, 1);
});

test('machine service identity and numeric dates have strict schema', async () => {
 const f = fixture();
 for (const changes of [{ common_name: undefined }, { common_name: '' }, { type: 'org' }, { sub: subject }, { common_name: 'x'.repeat(201) }, { common_name: '\ud800' }, { exp: String(NOW / 1000 + 100) }, { iat: 1.5 }, { nbf: null }, { exp: Number.MAX_SAFE_INTEGER }, { iat: -1 }]) {
  const token = await sign({ kind: 'machine', changes }); await rejects(() => f.verify(request(token, 'machine'), 'machine'));
 }
 assert.equal(f.calls.length, 0);
});

test('nbf and iat future and inconsistent validity intervals are rejected', async () => {
 const f = fixture();
 for (const changes of [{ nbf: NOW / 1000 + 1 }, { iat: NOW / 1000 + 1 }, { exp: NOW / 1000 - 31 }, { nbf: NOW / 1000, exp: NOW / 1000 }]) {
  const token = await sign({ changes }); await rejects(() => f.verify(request(token), 'human'));
 }
});

test('verified expiry has typed session/machine errors at the exact boundary', async () => {
 const f = fixture();
 for (const kind of ['human', 'machine']) {
  const token = await sign({ kind, changes: { exp: NOW / 1000 } });
  await rejects(() => f.verify(request(token, kind), kind), kind === 'human' ? 'SESSION_EXPIRED' : 'CREDENTIAL_EXPIRED');
 }
 assert.equal(f.calls.length, 1);
});

test('validity is rechecked after a slow JWKS fetch and no fixed token lifetime is assumed', async () => {
 let f;
 f = fixture({ fetchImpl: () => { f.advance(2000); return jwks(); } });
 const short = await sign({ changes: { exp: NOW / 1000 + 1 } });
 await rejects(() => f.verify(request(short), 'human'), 'SESSION_EXPIRED');
 const long = await sign({ changes: { exp: NOW / 1000 + 365 * 86400 } });
 await f.verify(request(long), 'human');
});

test('signature forgery and same-kid bad signatures do not trigger JWKS refetches', async () => {
 const f = fixture(); const valid = await sign();
 await f.verify(request(valid), 'human'); f.advance(5000);
 const forged = await sign({ key: second, header: { kid: first.jwk.kid } });
 await rejects(() => f.verify(request(forged), 'human'));
 assert.equal(f.calls.length, 1);
});

test('alg confusion, remote key headers, crit and wrong typ are rejected before fetch', async () => {
 const f = fixture();
 for (const header of [{ alg: 'none' }, { alg: 'HS256' }, { alg: 'PS256' }, { jku: 'https://attacker.test/jwks' }, { jwk: first.jwk }, { crit: ['b64'], b64: false }, { typ: 'projektor-local+jwt' }, { kid: '' }]) {
  const token = await sign({ header }); await rejects(() => f.verify(request(token), 'human'));
 }
 assert.equal(f.calls.length, 0);
});

test('duplicate JSON members, invalid UTF-8 and noncanonical base64url fail closed', async () => {
 const f = fixture();
 const duplicateHeader = await sign({ rawHeader: '{"alg":"none","alg":"RS256","kid":"first"}' });
 const duplicateClaims = await sign({ rawClaims: JSON.stringify(claims()).replace('"type":"app"', '"type":"org","type":"app"') });
 const token = await sign(); const parts = token.split('.');
 const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
 const noncanonical = parts[2].slice(0, -1) + alphabet[alphabet.indexOf(parts[2].at(-1)) + 1];
 for (const malformed of [duplicateHeader, duplicateClaims, `${encode(new Uint8Array([255]))}.${parts[1]}.${parts[2]}`, `${parts[0]}.${parts[1]}.${noncanonical}`, `${parts[0]}=.${parts[1]}.${parts[2]}`, 'e30.e30.AA']) {
  await rejects(() => f.verify(request(malformed), 'human'));
 }
 assert.equal(f.calls.length, 0);
});

test('JWKS cache is reused before TTL and refreshes at expiry', async () => {
 const f = fixture(); const token = await sign();
 await f.verify(request(token), 'human'); f.advance(9999);
 await f.verify(request(token), 'human'); assert.equal(f.calls.length, 1);
 f.advance(1); await f.verify(request(token), 'human'); assert.equal(f.calls.length, 2);
});

test('unknown kid refresh handles rotation and atomically removes retired keys', async () => {
 let rotated = false;
 const f = fixture({ fetchImpl: () => jwks(rotated ? [second.jwk] : [first.jwk]) });
 const old = await sign(); const next = await sign({ key: second });
 await f.verify(request(old), 'human'); rotated = true; f.advance(5000);
 await f.verify(request(next), 'human'); assert.equal(f.calls.length, 2);
 await rejects(() => f.verify(request(old), 'human')); assert.equal(f.calls.length, 2);
});

test('unknown kid storms are globally rate bounded even with many different kids', async () => {
 const f = fixture(); const valid = await sign();
 await f.verify(request(valid), 'human');
 for (let index = 0; index < 10; index++) {
  const token = await sign({ header: { kid: `unknown-${index}` } });
  await rejects(() => f.verify(request(token), 'human'));
 }
 assert.equal(f.calls.length, 1);
 f.advance(5000);
 const unknown = await sign({ header: { kid: 'still-unknown' } });
 await rejects(() => f.verify(request(unknown), 'human'));
 await rejects(() => f.verify(request(unknown), 'human'));
 assert.equal(f.calls.length, 2);
});

test('concurrent cold cache and concurrent rotation use one refresh each', async () => {
 let keys = [first.jwk];
 const f = fixture({ fetchImpl: async () => { await new Promise(resolve => setTimeout(resolve, 5)); return jwks(keys); } });
 const initial = await sign();
 await Promise.all(Array.from({ length: 20 }, () => f.verify(request(initial), 'human')));
 assert.equal(f.calls.length, 1);
 keys = [first.jwk, second.jwk]; f.advance(5000); const next = await sign({ key: second });
 await Promise.all(Array.from({ length: 20 }, () => f.verify(request(next), 'human')));
 assert.equal(f.calls.length, 2);
});

test('provider outage cannot extend expired cache and retry storms are rate bounded', async () => {
 let down = false;
 const f = fixture({ fetchImpl: () => { if (down) throw Error('offline'); return jwks(); } });
 const token = await sign(); await f.verify(request(token), 'human');
 down = true; f.advance(10000);
 await unavailable(() => f.verify(request(token), 'human'));
 await unavailable(() => f.verify(request(token), 'human')); assert.equal(f.calls.length, 2);
 down = false; f.advance(5000); await f.verify(request(token), 'human'); assert.equal(f.calls.length, 3);
});

test('failed unknown-kid refresh does not discard still-fresh trusted keys', async () => {
 let down = false;
 const f = fixture({ fetchImpl: () => { if (down) throw Error('offline'); return jwks(); } });
 const valid = await sign(); await f.verify(request(valid), 'human');
 down = true; f.advance(5000); const next = await sign({ key: second });
 await unavailable(() => f.verify(request(next), 'human'));
 await f.verify(request(valid), 'human');
 f.advance(5000); await unavailable(() => f.verify(request(valid), 'human'));
});

test('Access PEM metadata is accepted but signature validation uses the matching JWK', async () => {
 const pem = { kid: 'ignored', cert: '-----BEGIN CERTIFICATE-----\nignored\n-----END CERTIFICATE-----' };
 const f = fixture({ fetchImpl: () => new Response(JSON.stringify({ keys: [first.jwk], public_cert: pem, public_certs: [pem] }), { headers: { 'content-type': 'application/jwk-set+json; charset=utf-8' } }) });
 await f.verify(request(await sign()), 'human');
});

test('malformed, duplicate, private, weak and incompatible JWKs fail closed', async t => {
 const token = await sign();
 const invalid = [
  ['empty keys', []], ['duplicate kid', [first.jwk, first.jwk]], ['too many keys', Array.from({ length: 17 }, (_, i) => ({ ...first.jwk, kid: `${i}` }))],
  ['private key', [{ ...first.jwk, d: 'private' }]], ['wrong kty', [{ ...first.jwk, kty: 'oct' }]], ['wrong alg', [{ ...first.jwk, alg: 'HS256' }]],
  ['wrong use', [{ ...first.jwk, use: 'enc' }]], ['wrong ops', [{ ...first.jwk, key_ops: ['sign'] }]], ['weak modulus', [{ ...first.jwk, n: encode(new Uint8Array(128).fill(255)) }]],
  ['oversized modulus', [{ ...first.jwk, n: encode(new Uint8Array(1025).fill(255)) }]], ['bad exponent', [{ ...first.jwk, e: 'Ag' }]], ['invalid base64', [{ ...first.jwk, n: 'bad+value' }]],
  ['remote x5u', [{ ...first.jwk, x5u: 'https://attacker.test' }]],
 ];
 for (const [name, keys] of invalid) await t.test(name, async () => {
  const f = fixture({ keys }); await unavailable(() => f.verify(request(token), 'human'));
 });
});

test('JWKS response status, content type, JSON and advertised size are bounded', async t => {
 const token = await sign();
 for (const [name, response] of [
  ['server error', () => new Response('down', { status: 503 })], ['redirect', () => new Response('', { status: 302, headers: { location: 'https://attacker.test' } })],
  ['html', () => new Response('<html/>', { headers: { 'content-type': 'text/html' } })],
  ['duplicate keys member', () => new Response('{"keys":[],"keys":[]}', { headers: { 'content-type': 'application/json' } })],
  ['invalid JSON', () => new Response('{', { headers: { 'content-type': 'application/json' } })],
  ['advertised oversized', () => jwks([first.jwk], { headers: { 'content-type': 'application/json', 'content-length': '65537' } })],
 ]) await t.test(name, async () => {
  const f = fixture({ fetchImpl: response }); await unavailable(() => f.verify(request(token), 'human'));
 });
});

test('streaming JWKS byte bound applies without content-length and cancels the body', async () => {
 let cancelled = false;
 const f = fixture({ fetchImpl: () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(65537)); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } }) });
 const token = await sign();
 await unavailable(() => f.verify(request(token), 'human'));
 assert.equal(cancelled, true);
});

test('fetch deadline also covers an indefinitely stalled response body', async () => {
 let cancelled = false; let signal;
 const f = fixture({ configChanges: { jwksTimeoutMs: 50 }, fetchImpl: (_url, init) => {
  signal = init.signal;
  return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"keys":')); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } });
 } });
 const token = await sign(); const started = performance.now();
 await unavailable(() => f.verify(request(token), 'human'));
 assert.ok(performance.now() - started < 1000); assert.equal(cancelled, true); assert.equal(signal.aborted, true);
});

test('fetch deadline works even if a test fetch ignores abort entirely', async () => {
 const f = fixture({ configChanges: { jwksTimeoutMs: 50 }, fetchImpl: () => new Promise(() => {}) });
 const token = await sign(); await unavailable(() => f.verify(request(token), 'human'));
 assert.equal(f.calls.length, 1);
 await unavailable(() => f.verify(request(token), 'human')); assert.equal(f.calls.length, 1);
});

test('provider config is strict, HTTPS-only and fail-closed without local/mock fallbacks', async () => {
 for (const changes of [{ issuer: 'http://issuer.test' }, { jwksUrl: 'http://issuer.test/certs' }, { issuer: 'https://user:password@issuer.test' }, { issuer: `${config.issuer}#fragment` }, { issuer: `${config.issuer}?query=1` }, { humanAudience: '' }, { machineAudience: config.humanAudience }, { jwksCacheMs: 4999 }, { jwksCacheMs: 3600001 }, { jwksTimeoutMs: 0 }, { jwksTimeoutMs: null }, { jwksCacheMs: null }, { jwksTimeoutMs: 10001 }, { fetchImpl: 'injected' }, { allowHttp: true }]) {
  assert.throws(() => createVerifier({ ...config, ...changes }), error => error instanceof AuthError && error.status === 503);
 }
 const token = await sign();
 for (const env of [{}, { TEST_PUBLIC_JWK: JSON.stringify(first.jwk) }, { PROVIDER_CONFIG: JSON.stringify({ ...config, jwksUrl: 'http://localhost:1234/keys' }), fetchImpl: () => jwks(), now: () => NOW }, { PROVIDER_CONFIG: '{"issuer":"x","issuer":"y"}' }]) {
  await unavailable(() => authenticate(request(token), env, 'human'));
 }
});

test('same-kid replacement is discovered at cache expiry without signature-error refresh storms', async () => {
 let replacement = false;
 const f = fixture({ fetchImpl: () => jwks(replacement ? [{ ...second.jwk, kid: first.jwk.kid }] : [first.jwk]) });
 const old = await sign(); const next = await sign({ key: second, header: { kid: first.jwk.kid } });
 await f.verify(request(old), 'human'); replacement = true;
 await rejects(() => f.verify(request(next), 'human')); assert.equal(f.calls.length, 1);
 f.advance(10000); await f.verify(request(next), 'human'); assert.equal(f.calls.length, 2);
 await rejects(() => f.verify(request(old), 'human'));
});

test('a partially malformed rotation never replaces the last good unexpired key set', async () => {
 let malformed = false;
 const f = fixture({ fetchImpl: () => jwks(malformed ? [second.jwk, { ...first.jwk, kty: 'oct' }] : [first.jwk]) });
 const old = await sign(); const next = await sign({ key: second });
 await f.verify(request(old), 'human'); malformed = true; f.advance(5000);
 await unavailable(() => f.verify(request(next), 'human'));
 await f.verify(request(old), 'human');
 f.advance(5000); await unavailable(() => f.verify(request(old), 'human'));
});

test('late fetch completion after a deadline cannot populate the cache', async () => {
 let release; let cancelled = false;
 const f = fixture({ configChanges: { jwksTimeoutMs: 50 }, fetchImpl: () => new Promise(resolve => { release = resolve; }) });
 const token = await sign();
 await unavailable(() => f.verify(request(token), 'human'));
 release(new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ keys: [first.jwk] }))); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } }));
 await new Promise(resolve => setTimeout(resolve, 0));
 assert.equal(cancelled, true);
 await unavailable(() => f.verify(request(token), 'human'));
 assert.equal(f.calls.length, 1);
});

test('rejecting JWKS metadata cancels a streaming body before reading it', async () => {
 let cancelled = false;
 const f = fixture({ fetchImpl: () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/html' } }) });
 const token = await sign(); await unavailable(() => f.verify(request(token), 'human'));
 assert.equal(cancelled, true);
});
