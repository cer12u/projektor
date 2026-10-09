// Copied I2 regression; only import paths adjusted.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MyIssuesController, createVerifiedSessionAdapter, createMyIssuesTransport, validateFilters} from '../vendor/browser/my-issues.mjs';

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const identity = () => ({principalId: uuid(1), workspaceId: uuid(2), workspaceEpoch: uuid(3), sessionId: uuid(4), actorKind: 'human', authzVersion: 1, expiresAt: 601000});
const item = (n = 10, overrides = {}) => ({id: uuid(n), project_id: uuid(5), title: `Issue ${n}`, version: 1, assignee_id: uuid(1), assignee_kind: 'human', status_category: 'ready', priority: 2, created_at: n, ...overrides});
const page = (items = [item()], {total = items.length, nextCursor = null, ...meta} = {}) => ({data: {items, total, nextCursor}, meta: {workspaceId: uuid(2), workspaceEpoch: uuid(3), actorId: uuid(1), changeSeq: 0, visibilityVersion: 1, refreshRequired: false, queryFingerprint: 'a'.repeat(64), ...meta}});
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const tick = () => new Promise(resolve => setImmediate(resolve));
const error = (code, status) => Object.assign(new Error(code), {code, status});

function setup(t, responses = [page()], filters = {}) {
  const fixture = {session: identity(), responses: [...responses], requests: [], sessions: 0, events: [], now: 1000};
  fixture.app = new MyIssuesController({
    filters,
    now: () => fixture.now,
    sessionAdapter: {read: async options => {
      fixture.sessions++;
      if (fixture.sessionRead) return fixture.sessionRead(options);
      return structuredClone(fixture.session);
    }},
    transport: {read: async request => {
      fixture.requests.push(request);
      const result = fixture.responses.shift();
      if (result instanceof Error) throw result;
      return typeof result === 'function' ? result(request) : structuredClone(result);
    }},
    onChange: state => fixture.events.push(state),
  });
  t.after(() => fixture.app.dispose());
  return fixture;
}

test('requires verified-session and query adapters instead of caller-provided identity', () => {
  assert.throws(() => new MyIssuesController({session: identity()}), /VERIFIED_ADAPTER_REQUIRED/);
  assert.deepEqual(validateFilters(), {status: 'unresolved', limit: 50, projectId: null});
  for (const filters of [{status: 'mine'}, {status: null}, {limit: 0}, {limit: 101}, {limit: 1.1}, {limit: null}, {projectId: 'all'}, {actorId: uuid(1)}]) assert.throws(() => validateFilters(filters), /INVALID_FILTER/);
});

test('loading is explicit and session verification precedes the first query', async t => {
  const f = setup(t);
  const pending = deferred();
  f.sessionRead = () => pending.promise;
  const work = f.app.refresh();
  assert.equal(f.app.snapshot().phase, 'loading');
  assert.equal(f.app.snapshot().busy, true);
  assert.equal(f.requests.length, 0);
  pending.resolve(identity());
  assert.deepEqual(await work, {kind: 'ready'});
  assert.equal(f.sessions, 1);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].cursor, null);
  assert.equal(f.app.snapshot().complete, true);
});

test('empty appears only for validated zero total with no continuation', async t => {
  const f = setup(t, [page([])]);
  assert.deepEqual(await f.app.refresh(), {kind: 'empty'});
  assert.equal(f.app.snapshot().total, 0);
  assert.equal(f.app.snapshot().complete, true);
});

test('all statuses accepts done and canceled while unresolved is the default', async t => {
  const f = setup(t, [page([item(10, {status_category: 'done'}), item(11, {status_category: 'canceled'})])], {status: 'all'});
  assert.equal((await f.app.refresh()).kind, 'ready');
  assert.equal(f.requests[0].filters.status, 'all');
});

test('stable keyset pages accumulate to exact total, with session checked each page', async t => {
  const f = setup(t, [page([item(10), item(11)], {total: 3, nextCursor: 'cursor-one'}), page([item(12)], {total: 3})], {limit: 2});
  assert.equal((await f.app.refresh()).kind, 'partial');
  assert.equal(f.app.snapshot().complete, false);
  assert.equal((await f.app.loadMore()).kind, 'ready');
  assert.equal(f.requests[1].cursor, 'cursor-one');
  assert.equal(f.sessions, 2);
  assert.deepEqual(f.app.snapshot().items.map(row => row.id), [uuid(10), uuid(11), uuid(12)]);
  assert.deepEqual(await f.app.loadMore(), {kind: 'stopped'});
});

test('repeated load-more and retry clicks are single-flight', async t => {
  const pending = deferred();
  const f = setup(t, [page([item()], {total: 2, nextCursor: 'first'}), () => pending.promise]);
  await f.app.refresh();
  const work = f.app.loadMore();
  await tick();
  assert.deepEqual(await f.app.loadMore(), {kind: 'stopped'});
  assert.deepEqual(await f.app.retry(), {kind: 'stopped'});
  assert.equal(f.requests.length, 2);
  pending.resolve(page([item(11)], {total: 2}));
  await work;
});

test('filter transition drops rows immediately and ignores an old response even if abort is ignored', async t => {
  const pending = deferred();
  const f = setup(t, [() => pending.promise, page([item(11, {status_category: 'done'})])]);
  const old = f.app.refresh();
  await tick();
  const changed = f.app.setFilters({status: 'all'});
  assert.deepEqual(f.app.snapshot().items, []);
  assert.equal(f.requests[0].signal.aborted, true);
  await changed;
  pending.resolve(page([item(10)]));
  assert.deepEqual(await old, {kind: 'discarded'});
  assert.equal(f.app.snapshot().items[0].id, uuid(11));
  assert.equal(f.app.snapshot().filters.status, 'all');
});

test('unchanged and invalid filters do not discard a valid list', async t => {
  const f = setup(t);
  await f.app.refresh();
  assert.deepEqual(await f.app.setFilters({status: 'unresolved'}), {kind: 'unchanged'});
  assert.throws(() => f.app.setFilters({limit: 0}), /INVALID_FILTER/);
  assert.equal(f.app.snapshot().items.length, 1);
});

for (const field of ['principalId', 'workspaceId', 'workspaceEpoch', 'sessionId', 'authzVersion']) test(`changed verified ${field} between pages locks and clears the old workspace rows`, async t => {
  const f = setup(t, [page([item()], {total: 2, nextCursor: 'first'})]);
  await f.app.refresh();
  f.session[field] = field === 'authzVersion' ? 2 : uuid(99);
  assert.deepEqual(await f.app.loadMore(), {kind: 'locked', code: 'SESSION_CHANGED'});
  assert.equal(f.app.snapshot().items.length, 0);
  assert.equal(f.app.session, null);
  assert.equal(f.requests.length, 1);
});

test('session notification invalidates a pending read and then verifies the new session', async t => {
  const pending = deferred();
  const f = setup(t, [() => pending.promise, page([item(11)])]);
  const old = f.app.refresh();
  await tick();
  f.session.sessionId = uuid(77);
  await f.app.sessionChanged();
  pending.resolve(page([item(10)]));
  assert.equal((await old).kind, 'discarded');
  assert.equal(f.app.snapshot().items[0].id, uuid(11));
});

test('visibility hide synchronously drops all memory rows and prevents late resurrection', async t => {
  const pending = deferred();
  const f = setup(t, [page([item()], {total: 2, nextCursor: 'first'}), () => pending.promise, page([item(12)])]);
  await f.app.refresh();
  const old = f.app.loadMore();
  await tick();
  f.app.setVisible(false);
  assert.equal(f.app.snapshot().phase, 'locked');
  assert.deepEqual(f.app.items, []);
  assert.equal(f.app.session, null);
  assert.equal(f.app.meta, null);
  assert.deepEqual(await f.app.refresh(), {kind: 'stopped'});
  pending.resolve(page([item(11)], {total: 2}));
  assert.equal((await old).kind, 'discarded');
  await f.app.setVisible(true);
  assert.equal(f.app.snapshot().items[0].id, uuid(12));
  assert.equal(f.sessions, 3);
});

test('dispose fences pending work and removes data', async t => {
  const pending = deferred();
  const f = setup(t, [() => pending.promise]);
  const old = f.app.refresh();
  await tick();
  f.app.dispose();
  pending.resolve(page());
  assert.equal((await old).kind, 'discarded');
  assert.deepEqual(f.app.snapshot().items, []);
  assert.equal((await f.app.refresh()).kind, 'stopped');
});

for (const code of ['AUTH_REQUIRED', 'FORBIDDEN', 'EPOCH_MISMATCH', 'WORKSPACE_MISMATCH', 'BINDING_MISMATCH']) test(`${code} while loading another page locks and drops prior content`, async t => {
  const f = setup(t, [page([item()], {total: 2, nextCursor: 'first'}), error(code)]);
  await f.app.refresh();
  assert.deepEqual(await f.app.loadMore(), {kind: 'locked', code});
  assert.deepEqual(f.app.snapshot().items, []);
  assert.equal(f.app.snapshot().total, null);
  assert.equal(f.app.session, null);
});

test('expired verified session never sends the list request', async t => {
  const f = setup(t);
  f.session.expiresAt = 1000;
  assert.deepEqual(await f.app.refresh(), {kind: 'locked', code: 'AUTH_REQUIRED'});
  assert.equal(f.requests.length, 0);
});

test('session expiring during transport cannot unlock with a late success', async t => {
  const f = setup(t, [() => {f.now = 601001; return page();}]);
  assert.deepEqual(await f.app.refresh(), {kind: 'locked', code: 'AUTH_REQUIRED'});
  assert.equal(f.app.snapshot().items.length, 0);
});

test('session lease expiry locks an idle list without another network request', async t => {
  const f = setup(t);
  f.session.expiresAt = 1030;
  await f.app.refresh();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.app.snapshot().phase, 'locked');
  assert.equal(f.app.snapshot().code, 'AUTH_REQUIRED');
  assert.equal(f.app.snapshot().items.length, 0);
});

for (const change of [{refreshRequired: true}, {changeSeq: 1}, {visibilityVersion: 2}, {queryFingerprint: 'b'.repeat(64)}, {total: 3}]) test(`page change ${Object.keys(change)[0]} clears all accumulated rows and requires refresh`, async t => {
  const f = setup(t, [page([item()], {total: 2, nextCursor: 'first'}), page([item(11)], {total: 2, ...change}), page([item(12)])]);
  await f.app.refresh();
  assert.deepEqual(await f.app.loadMore(), {kind: 'stale'});
  const state = f.app.snapshot();
  assert.equal(state.refreshRequired, true);
  assert.equal(state.complete, false);
  assert.deepEqual(state.items, []);
  assert.equal(state.total, null);
  assert.equal((await f.app.loadMore()).kind, 'stopped');
  assert.equal((await f.app.refresh()).kind, 'ready');
});

test('expired/invalid cursor requests a new snapshot and cannot auto-retry the old cursor', async t => {
  const f = setup(t, [page([item()], {total: 2, nextCursor: 'first'}), error('REFRESH_REQUIRED')]);
  await f.app.refresh();
  assert.equal((await f.app.loadMore()).kind, 'stale');
  assert.equal(f.app.snapshot().nextCursor, null);
});

test('next-page network failure remains partial and explicit retry uses the same cursor', async t => {
  const f = setup(t, [page([item()], {total: 2, nextCursor: 'first'}), error('NETWORK_ERROR'), page([item(11)], {total: 2})]);
  await f.app.refresh();
  assert.deepEqual(await f.app.loadMore(), {kind: 'partial', code: 'NETWORK_ERROR'});
  assert.equal(f.app.snapshot().items.length, 1);
  assert.equal(f.app.snapshot().complete, false);
  assert.equal(f.app.snapshot().busy, false);
  assert.equal((await f.app.retry()).kind, 'ready');
  assert.equal(f.requests[1].cursor, f.requests[2].cursor);
});

test('initial failure is error, never empty, and explicit retry rechecks identity', async t => {
  const f = setup(t, [error('SERVER_UNAVAILABLE'), page()]);
  assert.equal((await f.app.refresh()).kind, 'error');
  assert.equal(f.app.snapshot().total, null);
  assert.equal(f.app.snapshot().complete, false);
  assert.equal((await f.app.retry()).kind, 'ready');
  assert.equal(f.sessions, 2);
});

const malformed = {
  'missing envelope': () => ({}),
  'error in success': value => ({...value, error: {code: 'FORBIDDEN'}}),
  'unexpected meta': value => {value.meta.token = 'unexpected'; return value;},
  'missing visibility version': value => {delete value.meta.visibilityVersion; return value;},
  'invalid visibility version': value => {value.meta.visibilityVersion = -1; return value;},
  'invalid fingerprint': value => {value.meta.queryFingerprint = 'opaque'; return value;},
  'nonstrict refresh flag': value => {value.meta.refreshRequired = 0; return value;},
  'invalid change sequence': value => {value.meta.changeSeq = Number.MAX_SAFE_INTEGER + 1; return value;},
  'negative total': value => {value.data.total = -1; return value;},
  'fractional total': value => {value.data.total = 1.5; return value;},
  'items not array': value => {value.data.items = {}; return value;},
  'invalid cursor': value => {value.data.nextCursor = 'new cursor'; return value;},
  'extra row fields': value => {value.data.items[0].secret = 'not selected'; return value;},
  'other assignee': value => {value.data.items[0].assignee_id = uuid(99); return value;},
  'wrong assignee kind': value => {value.data.items[0].assignee_kind = 'machine'; return value;},
  'unknown category': value => {value.data.items[0].status_category = 'completed'; return value;},
  'resolved in unresolved': value => {value.data.items[0].status_category = 'done'; return value;},
  'invalid priority': value => {value.data.items[0].priority = 5; return value;},
  'invalid created at': value => {value.data.items[0].created_at = '2026-10-08'; return value;},
  'invalid version': value => {value.data.items[0].version = 0; return value;},
  'invalid id': value => {value.data.items[0].id = 'not-an-id'; return value;},
  'blank title': value => {value.data.items[0].title = '   '; return value;},
  'oversize title': value => {value.data.items[0].title = 'あ'.repeat(1400); return value;},
  'ill-formed title': value => {value.data.items[0].title = '\ud800'; return value;},
  'duplicate rows': value => {value.data.items.push(item()); value.data.total = 2; return value;},
  'empty partial page': () => page([], {total: 2, nextCursor: 'next'}),
  'short final page': () => page([], {total: 2}),
  'next cursor at total': () => page([item()], {total: 1, nextCursor: 'next'}),
  'more rows than total': () => page([item(), item(11)], {total: 1}),
  'out-of-order rows': () => page([item(11), item(10)]),
};
for (const [name, mutate] of Object.entries(malformed)) test(`strict protocol rejects ${name} without claiming empty or complete`, async t => {
  const f = setup(t, [mutate(page())]);
  assert.deepEqual(await f.app.refresh(), {kind: 'error', code: 'PROTOCOL_ERROR'});
  assert.deepEqual(f.app.snapshot().items, []);
  assert.equal(f.app.snapshot().complete, false);
});

test('project filters must match every row and page limit is enforced', async t => {
  const f = setup(t, [page()], {projectId: uuid(99)});
  assert.equal((await f.app.refresh()).code, 'PROTOCOL_ERROR');
  const g = setup(t, [page([item(), item(11)])], {limit: 1});
  assert.equal((await g.app.refresh()).code, 'PROTOCOL_ERROR');
});

test('response identity and epoch mismatches lock rather than expose the payload', async t => {
  for (const [meta, code] of [[{actorId: uuid(99)}, 'BINDING_MISMATCH'], [{workspaceId: uuid(99)}, 'BINDING_MISMATCH'], [{workspaceEpoch: uuid(99)}, 'EPOCH_MISMATCH']]) {
    const f = setup(t, [page([item()], meta)]);
    assert.deepEqual(await f.app.refresh(), {kind: 'locked', code});
  }
});

for (const name of ['duplicate', 'descending', 'repeated cursor', 'cyclic cursor']) test(`${name} in continuation invalidates the entire list`, async t => {
  const first = page([item(10)], {total: 4, nextCursor: 'one'});
  const second = page([item(name === 'duplicate' ? 10 : name === 'descending' ? 9 : 11)], {total: 4, nextCursor: name === 'repeated cursor' ? 'one' : 'two'});
  const third = page([item(12)], {total: 4, nextCursor: 'one'});
  const f = setup(t, [first, second, third]);
  await f.app.refresh();
  let result = await f.app.loadMore();
  if (name === 'cyclic cursor') result = await f.app.loadMore();
  assert.equal(result.code, 'PROTOCOL_ERROR');
  assert.deepEqual(f.app.snapshot().items, []);
});

test('priority P0..P4 precedes no-priority; timestamp then id breaks ties', async t => {
  const rows = [item(10, {priority: 0, created_at: 99}), item(12, {priority: 1, created_at: 1}), item(13, {priority: 1, created_at: 1}), item(11, {priority: null, created_at: 0})];
  const f = setup(t, [page(rows)]);
  assert.equal((await f.app.refresh()).kind, 'ready');
});

test('snapshots cannot mutate controller items or filter state', async t => {
  const f = setup(t);
  await f.app.refresh();
  const snapshot = f.app.snapshot();
  snapshot.items[0].title = 'modified';
  snapshot.filters.status = 'all';
  assert.equal(f.app.snapshot().items[0].title, 'Issue 10');
  assert.equal(f.app.snapshot().filters.status, 'unresolved');
});

test('production adapters use same-origin GET/cookies and verified identity only', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({url: String(url), options});
    return Response.json(requests.length === 1 ? {...identity(), token: 'never-retained'} : page());
  };
  const session = await createVerifiedSessionAdapter({baseUrl: 'https://example.test/app', fetchImpl, now: () => 1000}).read();
  assert.equal(Object.hasOwn(session, 'token'), false);
  await createMyIssuesTransport({baseUrl: 'https://example.test', fetchImpl}).read({session, filters: {status: 'all', limit: 10, projectId: uuid(5)}, cursor: 'opaque/+='});
  assert.equal(requests[0].url, 'https://example.test/v1/session');
  const url = new URL(requests[1].url);
  assert.equal(url.pathname, `/v1/workspaces/${uuid(2)}/my-issues`);
  assert.equal(url.searchParams.get('workspaceEpoch'), uuid(3));
  assert.equal(url.searchParams.get('cursor'), 'opaque/+=');
  assert.equal(url.searchParams.get('projectId'), uuid(5));
  assert.equal(url.searchParams.has('actorId'), false);
  for (const {options} of requests) {
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.body, undefined);
  }
});

test('HTML, malformed JSON, oversized bodies and redirects fail as protocol errors', async () => {
  const responses = [new Response('<html>Login</html>', {headers: {'content-type': 'text/html'}}), new Response('{broken', {headers: {'content-type': 'application/json'}}), new Response('x'.repeat(1024 * 1024 + 1), {headers: {'content-type': 'application/json'}}), new Response('', {status: 302, headers: {location: '/login'}})];
  for (const response of responses) {
    const transport = createMyIssuesTransport({baseUrl: 'https://example.test', fetchImpl: async () => response});
    await assert.rejects(transport.read({session: identity(), filters: validateFilters()}), {code: 'PROTOCOL_ERROR'});
  }
});

test('401/403 lock based on headers without waiting for an HTML or stalled response body', async () => {
  for (const [status, code] of [[401, 'AUTH_REQUIRED'], [403, 'FORBIDDEN']]) {
    const transport = createMyIssuesTransport({baseUrl: 'https://example.test', fetchImpl: async () => new Response(new ReadableStream({}), {status}), deadlineMs: 50});
    await assert.rejects(transport.read({session: identity(), filters: validateFilters()}), {code});
  }
});

test('deadline includes fetch and JSON streaming, even if the implementation ignores abort', async () => {
  for (const fetchImpl of [() => new Promise(() => {}), async () => new Response(new ReadableStream({}), {headers: {'content-type': 'application/json'}})]) {
    const transport = createMyIssuesTransport({baseUrl: 'https://example.test', fetchImpl, deadlineMs: 20});
    await assert.rejects(transport.read({session: identity(), filters: validateFilters()}), {code: 'TIMEOUT'});
  }
});

test('external abort settles the bounded adapter promptly', async () => {
  const abort = new AbortController();
  const transport = createMyIssuesTransport({baseUrl: 'https://example.test', fetchImpl: () => new Promise(() => {}), deadlineMs: 5000});
  const result = transport.read({session: identity(), filters: validateFilters(), signal: abort.signal});
  abort.abort();
  await assert.rejects(result, {code: 'CANCELLED'});
});

test('HTTP epoch mismatch and invalid cursor retain their safe recovery categories', async () => {
  for (const [serverCode, expected] of [['EPOCH_MISMATCH', 'EPOCH_MISMATCH'], ['CURSOR_INVALID', 'REFRESH_REQUIRED']]) {
    const transport = createMyIssuesTransport({baseUrl: 'https://example.test', fetchImpl: async () => Response.json({error: {code: serverCode}}, {status: 409})});
    await assert.rejects(transport.read({session: identity(), filters: validateFilters()}), {code: expected});
  }
});

test('only the compact compatibility summary reaches rows; detail payload and malformed metadata fail closed',async t=>{
  const compatibility={statusId:'a'.repeat(32),statusKey:'review',statusName:'Synthetic review',isReviewStep:true,typeId:'b'.repeat(32),typeName:'Synthetic task'};
  const f=setup(t,[page([item(10,{compatibility,status_category:'in_progress'})])]);assert.equal((await f.app.refresh()).kind,'ready');assert.deepEqual(f.app.snapshot().items[0].compatibility,compatibility);
  for(const invalid of [{...compatibility,isReviewStep:'yes'},{...compatibility,dor:{missingRaw:'["Synthetic criterion"]'},statuses:[]}]){
    const bad=setup(t,[page([item(10,{compatibility:invalid})])]);assert.equal((await bad.app.refresh()).kind,'error');assert.equal(bad.app.snapshot().code,'PROTOCOL_ERROR');assert.deepEqual(bad.app.snapshot().items,[]);
  }
  const canonical=setup(t,[page([item(10,{compatibility:null})])]);assert.equal((await canonical.app.refresh()).kind,'ready');
});
