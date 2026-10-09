import test from 'node:test';
import assert from 'node:assert/strict';
import {createFetchTransport, SessionCoordinator, OperationCoordinator} from '../client/recovery.mjs';

const identity = overrides => ({principalId: 'principal-A', workspaceId: 'workspace-A', workspaceEpoch: 'epoch-A',
  actorKind: 'human', scopes: ['issue:read', 'issue:write'], expiresAt: Date.now() + 60000, token: 'fixture', ...overrides});
const command = overrides => ({schemaVersion: 1, workspaceId: 'workspace-A', workspaceEpoch: 'epoch-A',
  operationId: 'operation-A', commandType: 'Issue.UpdateTitle', entityId: 'issue-A', expectedVersion: 1,
  payload: {title: 'saved snapshot'}, ...overrides});
const committed = c => ({kind: 'committed', body: {data: {outcome: 'committed', effectApplied: true,
  entityId: c.entityId, committedVersion: 2, commitSeq: 1}, meta: {actorId: 'principal-A',
  workspaceId: c.workspaceId, operationId: c.operationId}}});
const absent = () => ({kind: 'not-observed', body: {data: {outcome: 'not_observed', absenceIsProofOfNonExecution: false}}});
const unavailable = () => ({kind: 'ambiguous', code: 'NETWORK_ERROR', outcome: 'unknown'});
const resource = c => ({kind: 'resource', body: {data: {id: c.entityId, project_id: 'project-A', title: 'current server title', version: 3}}});
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };
function fixture({initialSession = identity(), renewSession, transport = {}, ...options} = {}) {
  const session = new SessionCoordinator({initialSession, renewSession, deadlineMs: 20});
  const calls = [];
  const t = {
    submit: async args => { calls.push(['submit', args.command]); return committed(args.command); },
    readReceipt: async args => { calls.push(['receipt', args.command]); return absent(); },
    readResource: async args => { calls.push(['resource', args.command]); return resource(args.command); },
    ...transport,
  };
  const coordinator = new OperationCoordinator({session, transport: t, initialDraft: command().payload,
    retryDelaysMs: [0, 0, 0], attemptDeadlineMs: 40, resourceProjectId: 'project-A', ...options});
  return {session, coordinator, calls};
}

test('HTTP transport is a single attempt with canonical headers and no redirect/retry', async () => {
  const calls = [];
  const transport = createFetchTransport({baseUrl: 'https://example.test', fetchImpl: async (url, init) => {
    calls.push({url: String(url), init}); return Response.json(committed(command()).body);
  }});
  const result = await transport.submit({command: command(), session: identity({actorKind: 'machine'})});
  assert.equal(result.kind, 'committed'); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.test/machine/v1/workspaces/workspace-A/commands');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'operation-A');
  assert.equal(calls[0].init.headers['X-Requested-With'], 'XMLHttpRequest');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer fixture');
});

test('HTTP 401 and 403 settle without reading an unending response body', async () => {
  for (const [status, kind] of [[401, 'auth-required'], [403, 'forbidden']]) {
    let parsed = false;
    const transport = createFetchTransport({baseUrl: 'https://example.test', deadlineMs: 20,
      fetchImpl: async () => ({status, headers: new Headers(), json: () => { parsed = true; return new Promise(() => {}); }})});
    assert.equal((await transport.submit({command: command(), session: identity()})).kind, kind);
    assert.equal(parsed, false);
  }
});

test('generic HTML, invalid JSON, and network failures remain ambiguous, never auth-expired', async () => {
  for (const [response, code] of [
    [() => new Response('<html>maintenance</html>', {headers: {'content-type': 'text/html'}}), 'PROTOCOL_ERROR'],
    [() => new Response('no json', {headers: {'content-type': 'application/json'}}), 'PROTOCOL_ERROR'],
    [() => { throw new Error('offline'); }, 'NETWORK_ERROR'],
  ]) {
    const transport = createFetchTransport({baseUrl: 'https://example.test', fetchImpl: response});
    assert.deepEqual(await transport.submit({command: command(), session: identity()}), {kind: 'ambiguous', code, outcome: 'unknown'});
  }
});

test('known auth redirect is evidence; generic redirects are not and neither is followed', async () => {
  for (const [location, kind] of [['https://idp.test/login', 'auth-required'], ['https://other.test/login', 'ambiguous']]) {
    const transport = createFetchTransport({baseUrl: 'https://example.test', authRedirectOrigins: ['https://idp.test'],
      fetchImpl: async () => new Response('', {status: 302, headers: {location}})});
    assert.equal((await transport.submit({command: command(), session: identity()})).kind, kind);
  }
});

test('auth infrastructure outage is unavailable, not expired authentication', async () => {
  const transport = createFetchTransport({baseUrl: 'https://example.test', fetchImpl: async () =>
    Response.json({error: {code: 'AUTH_INFRASTRUCTURE_UNAVAILABLE'}}, {status: 503})});
  const result = await transport.submit({command: command(), session: identity()});
  assert.equal(result.kind, 'ambiguous'); assert.equal(result.code, 'AUTH_INFRASTRUCTURE_UNAVAILABLE');
});

test('both stalled fetch and stalled JSON parsing meet the same whole-attempt deadline', async () => {
  for (const fetchImpl of [() => new Promise(() => {}), async () => ({status: 200, ok: true,
    headers: new Headers({'content-type': 'application/json'}), json: () => new Promise(() => {})})]) {
    const transport = createFetchTransport({baseUrl: 'https://example.test', fetchImpl, deadlineMs: 10});
    const result = await transport.submit({command: command(), session: identity()});
    assert.equal(result.code, 'TIMEOUT');
  }
});

test('no cross-origin endpoint receives the token', async () => {
  let fetched = false, tokenRead = false;
  const transport = createFetchTransport({baseUrl: 'https://example.test', paths: {submit: () => 'https://evil.test'},
    getToken: () => { tokenRead = true; return 'secret'; }, fetchImpl: () => { fetched = true; }});
  assert.equal((await transport.submit({command: command(), session: identity()})).code, 'CROSS_ORIGIN_ENDPOINT');
  assert.equal(fetched, false); assert.equal(tokenRead, false);
});

test('prepared but unsent command is never submitted by recovery', async () => {
  const {coordinator, calls} = fixture();
  assert.equal(coordinator.prepare(command()).kind, 'prepared');
  assert.equal((await coordinator.recover()).code, 'NO_SUBMITTED_OPERATION');
  assert.equal(calls.length, 0); assert.equal(coordinator.snapshot().operation.state, 'prepared');
});

test('submitted snapshot is immutable and late success acknowledges only its revision', async () => {
  const pending = deferred(); let sent;
  const {coordinator} = fixture({transport: {submit: args => { sent = args.command; return pending.promise; }}});
  const original = command(); const result = coordinator.submit(original);
  original.payload.title = 'external mutation';
  coordinator.edit({title: 'latest input'});
  await Promise.resolve();
  assert.equal(sent.payload.title, 'saved snapshot');
  pending.resolve(committed(command())); await result;
  const state = coordinator.snapshot();
  assert.equal(state.operation.state, 'committed');
  assert.equal(state.draft.value.title, 'latest input');
  assert.equal(state.draft.acknowledgedRevision, 0); assert.equal(state.draft.revision, 1); assert.equal(state.draft.dirty, true);
});

test('lost response reconciles commit before any retry and leaves newer edits untouched', async () => {
  const order = [];
  const {coordinator} = fixture({transport: {
    submit: async () => { order.push('submit'); return unavailable(); },
    readReceipt: async args => { order.push('receipt'); return committed(args.command); },
    readResource: async args => { order.push('resource'); return resource(args.command); },
  }});
  await coordinator.submit(command()); coordinator.edit({title: 'newer local input'});
  assert.equal((await coordinator.recover()).kind, 'committed');
  assert.deepEqual(order, ['submit', 'receipt', 'resource']);
  const state = coordinator.snapshot();
  assert.equal(state.draft.value.title, 'newer local input'); assert.equal(state.draft.dirty, true);
  assert.equal(state.operation.latestResource.version, 3);
});

test('not_observed resends exact original command and ID after receipt check', async () => {
  const order = []; let sends = 0;
  const {coordinator} = fixture({transport: {
    submit: async args => { order.push(['submit', args.command]); return ++sends === 1 ? unavailable() : committed(args.command); },
    readReceipt: async args => { order.push(['receipt', args.command]); return absent(); },
  }});
  await coordinator.submit(command()); coordinator.edit({title: 'unsent later edit'});
  assert.equal((await coordinator.recover()).kind, 'committed');
  assert.deepEqual(order.map(x => x[0]), ['submit', 'receipt', 'submit']);
  assert.deepEqual(order[0][1], order[2][1]); assert.equal(coordinator.snapshot().draft.value.title, 'unsent later edit');
});

test('failed receipt lookup stops without blind retry', async () => {
  let sends = 0;
  const {coordinator} = fixture({transport: {submit: async () => { sends++; return unavailable(); }, readReceipt: async () => unavailable()}});
  await coordinator.submit(command()); assert.equal((await coordinator.recover()).code, 'RECEIPT_UNAVAILABLE');
  assert.equal(sends, 1); assert.equal(coordinator.snapshot().operation.state, 'unknown');
});

test('401 settles original request, locks retained draft, renews once then revalidates before unlock', async () => {
  const gate = deferred(); const order = []; let renewals = 0;
  const {coordinator, session} = fixture({renewSession: async () => { renewals++; order.push('renew'); await gate.promise;
    return {kind: 'authenticated', session: identity()}; }, transport: {
    submit: async () => ({kind: 'auth-required', code: 'EXPIRED', outcome: 'unknown'}),
    readReceipt: async args => { order.push('receipt'); return committed(args.command); },
    readResource: async args => { order.push('resource'); return resource(args.command); },
  }});
  const result = await coordinator.submit(command());
  assert.equal(result.kind, 'auth-required'); assert.equal(renewals, 0);
  assert.equal(coordinator.snapshot().busy, false); assert.equal(coordinator.snapshot().draft, null);
  const recovery = coordinator.recover(), again = coordinator.recover();
  assert.equal(recovery, again);
  const third = session.renew();
  gate.resolve(); await Promise.all([recovery, third]);
  assert.equal(renewals, 1); assert.deepEqual(order, ['renew', 'receipt', 'resource']);
  assert.equal(coordinator.snapshot().locked, false); assert.equal(coordinator.snapshot().draft.value.title, 'saved snapshot');
});

test('same-identity renewal without resource authorization leaves plaintext locked', async () => {
  const {coordinator} = fixture({renewSession: async () => ({kind: 'authenticated', session: identity()}), transport: {
    submit: async () => ({kind: 'auth-required'}), readReceipt: async () => absent(), readResource: undefined,
  }});
  await coordinator.submit(command());
  assert.equal((await coordinator.recover()).code, 'RESOURCE_REVALIDATION_REQUIRED');
  assert.equal(coordinator.snapshot().draft, null); assert.equal(coordinator.snapshot().locked, true);
});

test('principal, workspace, or kind renewal change stops and clears old plaintext', async () => {
  for (const changed of [{principalId: 'principal-B'}, {workspaceId: 'workspace-B'}, {actorKind: 'machine'}]) {
    let lookups = 0;
    const {coordinator} = fixture({renewSession: async () => ({kind: 'authenticated', session: identity(changed)}), transport: {
      submit: async () => ({kind: 'auth-required'}), readReceipt: async () => { lookups++; return absent(); },
    }});
    await coordinator.submit(command());
    assert.equal((await coordinator.recover()).code, 'SESSION_BINDING_CHANGED');
    const snapshot = coordinator.snapshot();
    assert.equal(snapshot.draft, null); assert.equal(snapshot.operation, null); assert.equal(lookups, 0);
    assert.equal(coordinator.edit({title: 'new login'}).code, 'EDITOR_LOCKED');
    assert.ok(!JSON.stringify(snapshot).includes('saved snapshot'));
  }
});

test('403 and rejected receipt do not enter login/retry loops', async () => {
  for (const result of [{kind: 'forbidden', code: 'FORBIDDEN', outcome: 'unknown'},
    {kind: 'rejected', code: 'VERSION_CONFLICT', body: {error: {code: 'VERSION_CONFLICT', outcome: 'rejected', effectApplied: false}}}]) {
    let renewal = 0, lookups = 0;
    const {coordinator} = fixture({renewSession: async () => { renewal++; }, transport: {
      submit: async () => result, readReceipt: async () => { lookups++; return absent(); },
    }});
    await coordinator.submit(command()); assert.equal((await coordinator.recover()).code, 'OPERATION_TERMINAL');
    assert.equal(renewal, 0); assert.equal(lookups, 0);
  }
});

test('receipt 403 preserves unknown original outcome and never claims effectApplied=false', async () => {
  const {coordinator} = fixture({transport: {submit: async () => unavailable(),
    readReceipt: async () => ({kind: 'forbidden', code: 'FORBIDDEN', outcome: 'unknown'})}});
  await coordinator.submit(command());
  const result = await coordinator.recover(); assert.equal(result.outcome, 'unknown');
  assert.equal(Object.hasOwn(result, 'effectApplied'), false); assert.equal(coordinator.snapshot().draft, null);
});

test('machine expiry cannot invoke human provider renewal', async () => {
  let renewals = 0;
  const {coordinator} = fixture({initialSession: identity({actorKind: 'machine'}), renewSession: async () => { renewals++; },
    transport: {submit: async () => ({kind: 'auth-required'})}});
  await coordinator.submit(command()); assert.equal((await coordinator.recover()).code, 'MACHINE_CREDENTIAL_REQUIRED');
  assert.equal(renewals, 0); assert.equal(coordinator.snapshot().draft, null);
});

test('known expiry locks without sending and late response cannot cross auth epoch', async () => {
  let now = 100; const session = new SessionCoordinator({initialSession: identity({expiresAt: 200}), now: () => now});
  const pending = deferred(); let sends = 0;
  const coordinator = new OperationCoordinator({session, transport: {submit: () => { sends++; return pending.promise; }}, initialDraft: command().payload});
  const submitted = coordinator.submit(command()); await Promise.resolve();
  now = 201; assert.equal(coordinator.snapshot().locked, true);
  pending.resolve(committed(command())); assert.equal((await submitted).code, 'AUTH_EPOCH_CHANGED');
  assert.equal(coordinator.snapshot().operation.state, 'auth-paused'); assert.equal(coordinator.snapshot().draft, null);
  assert.equal(sends, 1); assert.equal(coordinator.prepare(command({operationId: 'next'})).code, 'EDITOR_LOCKED');
});

test('renewal timeout clears busy state, retains operation, and does not retry provider indefinitely', async () => {
  let renewals = 0;
  const {coordinator, session} = fixture({renewSession: () => { renewals++; return new Promise(() => {}); },
    transport: {submit: async () => ({kind: 'auth-required'})}});
  await coordinator.submit(command()); assert.equal((await coordinator.recover()).code, 'TIMEOUT');
  assert.equal(coordinator.snapshot().busy, false); assert.equal(session.snapshot().busy, false);
  assert.equal(coordinator.snapshot().operation.operationId, 'operation-A');
  assert.equal((await coordinator.recover()).code, 'RENEWAL_ALREADY_ATTEMPTED'); assert.equal(renewals, 1);
});

test('cancel releases busy state and late receipt does not acknowledge the draft', async () => {
  const gate = deferred(); const started = deferred();
  const {coordinator} = fixture({transport: {submit: async () => unavailable(), readReceipt: async () => { started.resolve(); return gate.promise; }}});
  await coordinator.submit(command()); const recovery = coordinator.recover(); await started.promise;
  coordinator.cancelRecovery(); assert.equal((await recovery).code, 'CANCELLED');
  assert.equal(coordinator.snapshot().busy, false); gate.resolve(committed(command()));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(coordinator.snapshot().draft.acknowledgedRevision, -1);
  assert.equal(coordinator.snapshot().operation.state, 'unknown');
});

test('retry budget survives repeated recover calls and every retry follows receipt lookup', async () => {
  const order = [];
  const {coordinator} = fixture({transport: {
    submit: async () => { order.push('submit'); return unavailable(); },
    readReceipt: async () => { order.push('receipt'); return absent(); },
  }});
  await coordinator.submit(command()); assert.equal((await coordinator.recover()).code, 'RETRY_BUDGET_EXHAUSTED');
  assert.equal(coordinator.snapshot().operation.attempts, 4);
  assert.deepEqual(order, ['submit', 'receipt', 'submit', 'receipt', 'submit', 'receipt', 'submit', 'receipt']);
  await coordinator.recover(); assert.equal(coordinator.snapshot().operation.attempts, 4);
});

test('long Retry-After stops instead of sending before server minimum', async () => {
  let sends = 0;
  const {coordinator} = fixture({transport: {submit: async () => { sends++; return {...unavailable(), retryAfterMs: 120000}; }}});
  await coordinator.submit(command()); assert.equal((await coordinator.recover()).code, 'RETRY_AFTER_EXCEEDS_BUDGET');
  assert.equal(sends, 1); assert.ok(coordinator.snapshot().operation.nextAllowedAt > Date.now() + 60000);
});

test('wrong receipt actor/operation/entity cannot acknowledge or overwrite local draft', async () => {
  for (const alter of [r => { r.body.meta.actorId = 'other'; }, r => { r.body.meta.operationId = 'other'; },
    r => { r.body.data.entityId = 'other'; }]) {
    const result = committed(command()); alter(result);
    const {coordinator} = fixture({transport: {submit: async () => result}});
    assert.equal((await coordinator.submit(command())).code, 'RECEIPT_BINDING_MISMATCH');
    assert.equal(coordinator.snapshot().draft.acknowledgedRevision, -1);
  }
});

test('all navigation protection requests honestly fail for volatile drafts and journal', async () => {
  const {coordinator} = fixture(); coordinator.prepare(command());
  assert.deepEqual(await coordinator.prepareRecovery(), {kind: 'protection-failed', code: 'MEMORY_ONLY', mayNavigate: false});
  assert.equal(coordinator.snapshot().storage, 'memory-only'); assert.equal(coordinator.snapshot().mayNavigate, false);
});

test('unreceipted ingress rejection blocks unknown operation instead of authorizing a new ID', async () => {
  const transport = createFetchTransport({baseUrl: 'https://example.test', fetchImpl: async () =>
    Response.json({error: {code: 'KEY_REUSE', outcome: 'unknown'}}, {status: 409})});
  const {coordinator} = fixture({transport});
  const result = await coordinator.submit(command());
  assert.equal(result.kind, 'blocked'); assert.equal(result.outcome, 'unknown');
  assert.equal(coordinator.snapshot().operation.state, 'blocked');
  assert.equal(coordinator.prepare(command({operationId: 'fresh-ID'})).code, 'OPERATION_PENDING');
  assert.equal((await coordinator.recover()).code, 'OPERATION_TERMINAL');
});

test('stale input cannot be bound to or acknowledge the newest editor revision', async () => {
  const {coordinator, calls} = fixture(); coordinator.edit({title: 'newer input'});
  assert.equal((await coordinator.submit(command())).code, 'INPUT_SNAPSHOT_MISMATCH');
  assert.equal(calls.length, 0); assert.equal(coordinator.snapshot().draft.dirty, true);
  assert.equal(coordinator.snapshot().draft.acknowledgedRevision, -1);
});

test('preparing first then editing retains the old prepared snapshot with its own revision', async () => {
  const {coordinator, calls} = fixture(); coordinator.prepare(command()); coordinator.edit({title: 'later input'});
  await coordinator.submit();
  assert.equal(calls[0][1].payload.title, 'saved snapshot');
  assert.equal(coordinator.snapshot().draft.value.title, 'later input');
  assert.equal(coordinator.snapshot().draft.dirty, true);
});

test('renewal may reduce scopes but cannot re-expand a previously removed scope', async () => {
  let renewals = 0;
  const session = new SessionCoordinator({initialSession: identity(), renewSession: async () =>
    ({kind: 'authenticated', session: identity({scopes: ++renewals === 1 ? ['issue:read'] : ['issue:read', 'issue:write']})})});
  session.requireRenewal(); assert.equal((await session.renew()).kind, 'authenticated');
  session.requireRenewal(); assert.equal((await session.renew()).code, 'SCOPE_EXPANSION');
  assert.equal(session.current(), null);
});

test('same-identity scope or workspace epoch change preserves unresolved ID under a locked prior binding', async () => {
  for (const [changed, code] of [
    [{scopes: ['issue:read', 'issue:write', 'admin']}, 'SCOPE_EXPANSION'],
    [{workspaceEpoch: 'restored-epoch'}, 'WORKSPACE_EPOCH_CHANGED'],
  ]) {
    let reads = 0;
    const {coordinator, session} = fixture({renewSession: async () => ({kind: 'authenticated', session: identity(changed)}), transport: {
      submit: async () => ({kind: 'auth-required'}), readReceipt: async () => { reads++; return absent(); },
    }});
    await coordinator.submit(command()); assert.equal((await coordinator.recover()).code, code);
    const state = coordinator.snapshot();
    assert.equal(state.operation.operationId, 'operation-A'); assert.equal(state.operation.attempts, 1);
    assert.equal(state.draft, null); assert.equal(state.locked, true); assert.equal(session.current(), null);
    await coordinator.recover(); assert.equal(reads, 0);
  }
});

test('transient renewal failure and explicit interaction requirement are distinct', async () => {
  for (const [renewSession, state, code] of [
    [async () => { throw new Error('provider network failure'); }, 'recovery-stopped', 'NETWORK_ERROR'],
    [async () => ({kind: 'ambiguous', code: 'AUTH_INFRASTRUCTURE_UNAVAILABLE'}), 'recovery-stopped', 'AUTH_INFRASTRUCTURE_UNAVAILABLE'],
    [async () => ({kind: 'interaction-required'}), 'awaiting-user', 'INTERACTION_REQUIRED'],
  ]) {
    const session = new SessionCoordinator({initialSession: identity(), renewSession});
    session.requireRenewal(); assert.equal((await session.renew()).code, code);
    assert.equal(session.snapshot().state, state); assert.equal(session.snapshot().busy, false);
  }
});

test('rejected receipt after renewal revalidates project and restores dirty draft for conflict resolution', async () => {
  let reads = 0;
  const {coordinator} = fixture({renewSession: async () => ({kind: 'authenticated', session: identity()}), transport: {
    submit: async () => ({kind: 'auth-required'}),
    readReceipt: async () => ({kind: 'rejected', code: 'VERSION_CONFLICT', body: {error: {code: 'VERSION_CONFLICT', outcome: 'rejected', effectApplied: false}}}),
    readResource: async args => { reads++; return resource(args.command); },
  }});
  await coordinator.submit(command()); assert.equal((await coordinator.recover()).kind, 'rejected');
  const state = coordinator.snapshot();
  assert.equal(reads, 1); assert.equal(state.locked, false); assert.equal(state.operation.state, 'rejected');
  assert.equal(state.draft.value.title, 'saved snapshot'); assert.equal(state.draft.dirty, true);
  assert.equal(state.operation.latestResource.title, 'current server title');
});

test('moved resource or missing original project cannot unlock old draft after renewal', async () => {
  for (const [resourceProjectId, project_id, code] of [
    [undefined, 'project-A', 'RESOURCE_SCOPE_UNVERIFIED'], ['project-A', 'project-B', 'RESOURCE_SCOPE_CHANGED'],
  ]) {
    let writes = 0;
    const {coordinator} = fixture({resourceProjectId, renewSession: async () => ({kind: 'authenticated', session: identity()}), transport: {
      submit: async () => { writes++; return {kind: 'auth-required'}; }, readReceipt: async () => absent(),
      readResource: async args => ({kind: 'resource', body: {data: {id: args.command.entityId, project_id}}}),
    }});
    await coordinator.submit(command()); assert.equal((await coordinator.recover()).code, code);
    assert.equal(coordinator.snapshot().draft, null); assert.equal(coordinator.snapshot().locked, true);
    assert.equal(writes, 1); assert.equal(coordinator.snapshot().operation.operationId, 'operation-A');
  }
});

test('current resource permission denial never reveals retained input or retries', async () => {
  let writes = 0;
  const {coordinator} = fixture({renewSession: async () => ({kind: 'authenticated', session: identity()}), transport: {
    submit: async () => { writes++; return {kind: 'auth-required'}; }, readReceipt: async () => absent(),
    readResource: async () => ({kind: 'forbidden', code: 'FORBIDDEN', outcome: 'unknown'}),
  }});
  await coordinator.submit(command()); assert.equal((await coordinator.recover()).code, 'RESOURCE_REVALIDATION_FAILED');
  assert.equal(coordinator.snapshot().auth.state, 'denied'); assert.equal(coordinator.snapshot().draft, null); assert.equal(writes, 1);
});

test('resource revalidation locks immediately even when auth session has never expired', async () => {
  for (const outcome of [
    {kind: 'blocked', code: 'NOT_FOUND', outcome: 'unknown'},
    unavailable(),
    {kind: 'resource', body: {data: {id: 'other', project_id: 'project-A'}}},
  ]) {
    const entered = deferred(), gate = deferred();
    const {coordinator} = fixture({transport: {
      submit: async () => unavailable(), readReceipt: async args => committed(args.command),
      readResource: async () => { entered.resolve(); await gate.promise; return outcome; },
    }});
    await coordinator.submit(command()); const recovered = coordinator.recover(); await entered.promise;
    assert.equal(coordinator.snapshot().locked, true); assert.equal(coordinator.snapshot().draft, null);
    gate.resolve(); await recovered;
    assert.equal(coordinator.snapshot().locked, true); assert.equal(coordinator.snapshot().draft, null);
    assert.equal(coordinator.snapshot().operation.state, 'unknown');
  }
});

test('invalid committed receipt sequence/version cannot acknowledge a draft', async () => {
  for (const invalid of [{committedVersion: 0}, {committedVersion: -1}, {commitSeq: 0}, {commitSeq: undefined}]) {
    const result = committed(command()); Object.assign(result.body.data, invalid);
    const {coordinator} = fixture({transport: {submit: async () => result}});
    assert.equal((await coordinator.submit(command())).code, 'RECEIPT_BINDING_MISMATCH');
    assert.equal(coordinator.snapshot().draft.acknowledgedRevision, -1);
  }
});

test('human transport uses cookie profile CSRF header and never sends machine bearer token', async () => {
  let observed, tokenRead = false;
  const transport = createFetchTransport({baseUrl: 'https://example.test', prefix: '/v1', getToken: () => { tokenRead = true; return 'secret'; },
    fetchImpl: async (url, init) => { observed = {url: String(url), init}; return Response.json(committed(command()).body); }});
  await transport.submit({command: command(), session: identity()});
  assert.equal(observed.url, 'https://example.test/v1/workspaces/workspace-A/commands');
  assert.equal(observed.init.headers['X-Projektor-Csrf'], 'same-origin');
  assert.equal(observed.init.headers.Authorization, undefined); assert.equal(tokenRead, false);
  assert.equal(observed.init.credentials, 'same-origin');
});

test('HTML/invalid-JSON overload responses still preserve Retry-After minimum', async () => {
  for (const type of ['text/html', 'application/json']) {
    const transport = createFetchTransport({baseUrl: 'https://example.test', fetchImpl: async () => new Response('<html>busy</html>',
      {status: 503, headers: {'content-type': type, 'retry-after': '120'}})});
    const result = await transport.submit({command: command(), session: identity()});
    assert.equal(result.kind, 'ambiguous'); assert.equal(result.retryAfterMs, 120000);
  }
});

test('wrong-shape JSON overload bodies cannot discard observed Retry-After', async () => {
  for (const status of [429, 503]) for (const value of [null, [], 'error', 42]) {
    const transport = createFetchTransport({baseUrl: 'https://example.test', fetchImpl: async () =>
      Response.json(value, {status, headers: {'retry-after': '120'}})});
    const result = await transport.submit({command: command(), session: identity()});
    assert.equal(result.kind, 'ambiguous'); assert.equal(result.retryAfterMs, 120000);
  }
});

test('overload headers settle without parsing an indefinitely hanging body', async () => {
  let parsed = false;
  const transport = createFetchTransport({baseUrl: 'https://example.test', deadlineMs: 10,
    fetchImpl: async () => ({status: 503, headers: new Headers({'content-type': 'application/json', 'retry-after': '120'}),
      json: () => { parsed = true; return new Promise(() => {}); }})});
  const result = await transport.submit({command: command(), session: identity()});
  assert.equal(result.code, 'SERVER_UNAVAILABLE'); assert.equal(result.retryAfterMs, 120000);
  assert.equal(parsed, false);
});

test('nested coordinator deadline cannot lose overload retry floor to hanging response parsing', async () => {
  let writes = 0;
  const transport = createFetchTransport({baseUrl: 'https://example.test', deadlineMs: 10,
    fetchImpl: async (_url, init) => {
      if (init.method === 'POST') {
        writes++;
        return {status: 503, headers: new Headers({'content-type': 'application/json', 'retry-after': '120'}),
          json: () => new Promise(() => {})};
      }
      return Response.json(absent().body);
    }});
  const {coordinator} = fixture({transport, attemptDeadlineMs: 10});
  assert.equal((await coordinator.submit(command())).retryAfterMs, 120000);
  assert.equal((await coordinator.recover()).code, 'RETRY_AFTER_EXCEEDS_BUDGET');
  assert.equal(writes, 1); assert.equal(coordinator.snapshot().operation.attempts, 1);
});
