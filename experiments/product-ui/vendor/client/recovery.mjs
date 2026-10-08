/**
 * Local, MEMORY-ONLY recovery contract experiment. No storage, provider adapter,
 * DOM, navigation, encrypted DraftVault, reload survival, or cross-tab claim.
 * Session values must come from an authenticated session endpoint, never a JWT
 * decoded by the UI. Share one SessionCoordinator within this client context.
 */
const clone = value => structuredClone(value);
const frozen = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
};
const canonical = value => value && typeof value === 'object'
  ? Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  : JSON.stringify(value);
const stopped = code => ({kind: 'stopped', code});
const ambiguous = code => ({kind: 'ambiguous', code, outcome: 'unknown'});
const delay = (ms, signal) => new Promise((resolve, reject) => {
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(); };
  const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new Error('CANCELLED')); };
  const timer = setTimeout(done, ms);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, {once: true});
});

/** Race the complete operation (including response parsing) even if I/O ignores abort. */
export async function boundedAttempt(run, deadlineMs, signal) {
  const controller = new AbortController();
  let timer, abort;
  const interruption = new Promise(resolve => {
    abort = () => { controller.abort(); resolve(ambiguous('CANCELLED')); };
    timer = setTimeout(() => { controller.abort(); resolve(ambiguous('TIMEOUT')); }, Math.max(0, deadlineMs));
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, {once: true});
  });
  try {
    if (signal?.aborted) return ambiguous('CANCELLED');
    return await Promise.race([
      Promise.resolve().then(() => run(controller.signal)).catch(() => ambiguous('NETWORK_ERROR')),
      interruption,
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

const definitive = new Set(['POLICY_VERSION_CONFLICT','POLICY_MIGRATION_REQUIRED','POLICY_STATE_INCOMPLETE','VERSION_LIMIT_REACHED','PRINCIPAL_INVALID','VALIDATION', 'SCHEMA_UNSUPPORTED', 'TITLE_EMPTY', 'PRECONDITION_REQUIRED',
  'NOT_FOUND', 'VERSION_CONFLICT', 'KEY_REUSE', 'EPOCH_MISMATCH', 'WORKSPACE_MISMATCH',
  'BODY_TOO_LARGE', 'CONTENT_EMPTY', 'ASSIGNEE_INVALID', 'PARENT_INVALID', 'ENTITY_EXISTS',
  'COMMENT_EXISTS', 'COMMENT_FORBIDDEN', 'PROJECT_NOT_FOUND', 'LINK_INTEGRATION_UNAVAILABLE','LINK_MAPPING_INVALID','ALIAS_CONFLICT','PARENT_OR_ALIAS_CONFLICT','TREE_CONFLICT','TREE_ACCESS_OR_ALIAS_CONFLICT','ACTIVE_CHILDREN']);

/** One HTTP attempt only: never refresh, redirect, or retry a command here. */
export function createFetchTransport({baseUrl, fetchImpl = globalThis.fetch, prefix = '/machine/v1',
  getToken = session => session.token, paths = {}, authRedirectOrigins = [],
  deadlineMs = {submit: 15000, receipt: 5000, resource: 10000}}) {
  const base = new URL(baseUrl);
  const authOrigins = new Set(authRedirectOrigins.map(value => new URL(value).origin));
  const defaultPaths = {
    submit: c => `${prefix}/workspaces/${encodeURIComponent(c.workspaceId)}/commands`,
    receipt: c => `${prefix}/workspaces/${encodeURIComponent(c.workspaceId)}/operations/${encodeURIComponent(c.operationId)}?workspaceEpoch=${encodeURIComponent(c.workspaceEpoch)}`,
    resource: c => `${prefix}/workspaces/${encodeURIComponent(c.workspaceId)}/issues/${encodeURIComponent(c.entityId)}?workspaceEpoch=${encodeURIComponent(c.workspaceEpoch)}`,
  };
  async function request(kind, {command, session, signal}) {
    return boundedAttempt(async attemptSignal => {
      const url = new URL((paths[kind] ?? defaultPaths[kind])(command), base);
      if (url.origin !== base.origin) return stopped('CROSS_ORIGIN_ENDPOINT');
      const token = session.actorKind === 'machine' ? await getToken(session) : null;
      const headers = {'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest'};
      if (token) headers.Authorization = `Bearer ${token}`;
      if (kind === 'submit') Object.assign(headers, {'Content-Type': 'application/json', 'Idempotency-Key': command.operationId});
      if (kind === 'submit' && session.actorKind === 'human') headers['X-Projektor-Csrf'] = 'same-origin';
      const response = await fetchImpl(url, {method: kind === 'submit' ? 'POST' : 'GET', headers,
        ...(kind === 'submit' ? {body: JSON.stringify(command)} : {}), signal: attemptSignal,
        redirect: 'manual', credentials: 'same-origin', cache: 'no-store'});
      // Status alone settles these branches. Never wait for a login/denial HTML body.
      if (response.status === 401) return {kind: 'auth-required', code: 'UNAUTHENTICATED', outcome: 'unknown'};
      if (response.status === 403) return {kind: 'forbidden', code: 'FORBIDDEN', outcome: 'unknown'};
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        const destination = new URL(location, url);
        return authOrigins.has(destination.origin)
          ? {kind: 'auth-required', code: 'UNEXPECTED_AUTH_RESPONSE', outcome: 'unknown'}
          : ambiguous('PROTOCOL_ERROR');
      }
      const retryAfter = response.headers.get('retry-after');
      const seconds = retryAfter !== null && /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) : null;
      const date = seconds === null && retryAfter ? Date.parse(retryAfter) : NaN;
      const retryInfo = response.status >= 500 || response.status === 429
        ? seconds !== null ? {retryAfterMs: seconds * 1000} : Number.isFinite(date) ? {retryAt: date} : {} : {};
      // Once an overload response supplies its retry floor, the headers alone
      // suffice. Waiting for any error body could let this or the coordinator's
      // outer deadline discard that already-observed floor and resend too early.
      if (Object.keys(retryInfo).length) return {...ambiguous('SERVER_UNAVAILABLE'), ...retryInfo};
      const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (type !== 'application/json' && !type?.endsWith('+json')) return {...ambiguous('PROTOCOL_ERROR'), ...retryInfo};
      let body;
      try { body = await response.json(); } catch { return {...ambiguous('PROTOCOL_ERROR'), ...retryInfo}; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return {...ambiguous('PROTOCOL_ERROR'), ...retryInfo};
      const code = body.error?.code;
      if (response.status >= 500 || response.status === 429) {
        return {...ambiguous(code === 'AUTH_INFRASTRUCTURE_UNAVAILABLE' ? code : 'SERVER_UNAVAILABLE'),
          ...retryInfo};
      }
      if (definitive.has(code)) return body.error.outcome === 'rejected' && body.error.effectApplied === false
        ? {kind: 'rejected', code, body} : {kind: 'blocked', code, outcome: 'unknown', body};
      if (!response.ok || code) return ambiguous('PROTOCOL_ERROR');
      if (kind === 'resource' && body.data && typeof body.data === 'object') return {kind: 'resource', body};
      if (body.data?.outcome === 'committed') return {kind: 'committed', body};
      if (kind === 'receipt' && body.data?.outcome === 'not_observed'
        && body.data.absenceIsProofOfNonExecution === false) return {kind: 'not-observed', body};
      return ambiguous('PROTOCOL_ERROR');
    }, typeof deadlineMs === 'number' ? deadlineMs : deadlineMs[kind], signal);
  }
  return {
    submit: args => request('submit', args),
    readReceipt: args => request('receipt', args),
    readResource: args => request('resource', args),
  };
}

function validSession(value) {
  return value && ['principalId', 'workspaceId', 'workspaceEpoch'].every(k => typeof value[k] === 'string' && value[k])
    && ['human', 'machine'].includes(value.actorKind) && Number.isFinite(value.expiresAt)
    && Array.isArray(value.scopes) && value.scopes.every(s => typeof s === 'string');
}
const sameIdentity = (a, b) => ['principalId', 'workspaceId', 'actorKind'].every(k => a[k] === b[k]);

export class SessionCoordinator {
  #value; #binding; #state = 'authenticated'; #epoch = 0; #listeners = new Set();
  #flight = null; #attemptedEpoch = null; #renew; #deadline; #now;
  constructor({initialSession, renewSession, deadlineMs = 5000, now = Date.now}) {
    if (!validSession(initialSession)) throw new TypeError('A verified initial session with binding, kind, expiry and scopes is required');
    this.#value = frozen(clone(initialSession));
    this.#binding = frozen(Object.fromEntries(['principalId', 'workspaceId', 'workspaceEpoch', 'actorKind', 'scopes'].map(k => [k, clone(initialSession[k])])));
    this.#renew = renewSession; this.#deadline = deadlineMs; this.#now = now;
    this.current();
  }
  #change(state, event = state) { this.#state = state; this.#epoch++; for (const fn of this.#listeners) fn(event); }
  subscribe(fn) { this.#listeners.add(fn); return () => this.#listeners.delete(fn); }
  current() {
    if (this.#state === 'authenticated' && this.#now() >= this.#value.expiresAt) this.requireRenewal();
    return this.#state === 'authenticated' ? this.#value : null;
  }
  snapshot() { this.current(); return {state: this.#state, epoch: this.#epoch, busy: this.#flight !== null}; }
  requireRenewal() {
    if (this.#state === 'authenticated') this.#change('renewal-required');
  }
  deny() { if (this.#state !== 'denied') this.#change('denied'); }
  renew() {
    this.current();
    if (this.#flight) return this.#flight;
    if (this.#state === 'authenticated') return Promise.resolve({kind: 'authenticated'});
    if (['denied', 'identity-changed', 'scope-changed', 'binding-changed'].includes(this.#state)) return Promise.resolve(stopped(this.#state.toUpperCase().replaceAll('-', '_')));
    if (this.#binding.actorKind === 'machine') return Promise.resolve(stopped('MACHINE_CREDENTIAL_REQUIRED'));
    if (!this.#renew) return Promise.resolve(stopped('PROVIDER_ADAPTER_UNAVAILABLE'));
    if (this.#attemptedEpoch === this.#epoch) return Promise.resolve(stopped('RENEWAL_ALREADY_ATTEMPTED'));
    this.#state = 'checking';
    this.#attemptedEpoch = this.#epoch;
    const epoch = this.#epoch;
    this.#flight = (async () => {
      const result = await boundedAttempt(signal => this.#renew({previousSession: this.#value, signal}), this.#deadline);
      if (epoch !== this.#epoch) return stopped('AUTH_EPOCH_CHANGED');
      if (result?.kind === 'forbidden') { this.deny(); return result; }
      const candidate = result?.session;
      if (result?.kind !== 'authenticated' || !validSession(candidate) || candidate.expiresAt <= this.#now()) {
        this.#state = result?.kind === 'interaction-required' ? 'awaiting-user' : 'recovery-stopped';
        return stopped(result?.code ?? (result?.kind === 'interaction-required' ? 'INTERACTION_REQUIRED' : 'RENEWAL_UNAVAILABLE'));
      }
      if (!sameIdentity(this.#binding, candidate)) {
        this.#value = null;
        this.#change('identity-changed');
        return stopped('SESSION_BINDING_CHANGED');
      }
      if (candidate.workspaceEpoch !== this.#binding.workspaceEpoch) {
        this.#change('binding-changed');
        return stopped('WORKSPACE_EPOCH_CHANGED');
      }
      if (candidate.scopes.some(s => !this.#binding.scopes.includes(s))) {
        this.#change('scope-changed');
        return stopped('SCOPE_EXPANSION');
      }
      this.#value = frozen(clone(candidate));
      // A reduction becomes the new ceiling; a later token cannot silently add it back.
      this.#binding = frozen({...this.#binding, scopes: clone(candidate.scopes)});
      this.#change('authenticated');
      return {kind: 'authenticated'};
    })().finally(() => { this.#flight = null; });
    return this.#flight;
  }
}

/** One editor/operation lane; user edits and submitted snapshots are separate. */
export class OperationCoordinator {
  #session; #transport; #draft; #revision = 0; #ack = -1; #journal = null;
  #locked = false; #destroyed = false; #flight = null; #controller = null;
  #now; #sleep; #delays; #deadline; #attemptDeadline; #maxRetries; #maxReceipts;
  #used = new Set(); #unsub; #resourceProject; #resourceEntity; #random;
  constructor({session, transport, initialDraft = null, now = Date.now, sleep = delay,
    retryDelaysMs = [1000, 3000, 10000], recoveryDeadlineMs = 60000,
    attemptDeadlineMs = 15000, maxRetries = 3, maxReceipts = 6, resourceProjectId, resourceEntityId, random = Math.random}) {
    this.#session = session; this.#transport = transport; this.#draft = clone(initialDraft);
    this.#now = now; this.#sleep = sleep; this.#delays = retryDelaysMs;
    this.#deadline = recoveryDeadlineMs; this.#attemptDeadline = attemptDeadlineMs;
    this.#resourceProject = resourceProjectId; this.#resourceEntity = resourceEntityId; this.#random = random;
    this.#maxRetries = Math.min(3, Math.max(0, maxRetries)); this.#maxReceipts = Math.min(6, Math.max(0, maxReceipts));
    this.#unsub = session.subscribe(event => {
      if (event !== 'authenticated') this.#locked = true;
      if (event === 'identity-changed') {
        this.#draft = null; this.#journal = null; this.#used.clear(); this.#destroyed = true;
        this.#controller?.abort();
      }
    });
    this.#locked = !session.current();
  }
  edit(value) {
    if (!this.#session.current() || this.#locked || this.#destroyed) return stopped('EDITOR_LOCKED');
    this.#draft = clone(value); this.#revision++;
    return {kind: 'edited', revision: this.#revision};
  }
  prepare(command) {
    const session = this.#session.current();
    if (!session || this.#locked || this.#destroyed) return stopped('EDITOR_LOCKED');
    if (this.#journal && !['committed', 'rejected'].includes(this.#journal.state)) return stopped('OPERATION_PENDING');
    if (!command || typeof command.operationId !== 'string' || !command.operationId) return stopped('OPERATION_ID_REQUIRED');
    if (this.#used.has(command.operationId)) return stopped('KEY_REUSE');
    if (command.workspaceId !== session.workspaceId || command.workspaceEpoch !== session.workspaceEpoch) return stopped('WORKSPACE_MISMATCH');
    if (canonical(command.payload) !== canonical(this.#draft)) return stopped('INPUT_SNAPSHOT_MISMATCH');
    const copy = frozen(clone(command));
    this.#journal = {command: copy, canonical: canonical(copy), binding: session, revision: this.#revision,
      state: 'prepared', attempts: 0, receipts: 0, firstSubmittedAt: null, nextAllowedAt: null, result: null};
    this.#used.add(command.operationId);
    return {kind: 'prepared', operationId: command.operationId};
  }
  async submit(command) {
    if (this.#flight) return stopped('OPERATION_BUSY');
    if (command) { const prepared = this.prepare(command); if (prepared.kind !== 'prepared') return prepared; }
    const journal = this.#journal;
    if (!journal || journal.state !== 'prepared') return stopped('NOT_PREPARED');
    const session = this.#session.current();
    if (!session || this.#locked) return stopped('AUTH_REQUIRED');
    journal.firstSubmittedAt = this.#now();
    this.#controller = new AbortController();
    this.#flight = this.#send(journal, this.#controller.signal).finally(() => { this.#flight = null; this.#controller = null; });
    return this.#flight;
  }
  #valid(journal, epoch) {
    return !this.#destroyed && this.#journal === journal && this.#session.snapshot().epoch === epoch && this.#session.current();
  }
  #apply(journal, result) {
    if (result.kind === 'committed') {
      const {data, meta} = result.body ?? {};
      const noOp = ['Issue.UpdateBody','Issue.Assign','Issue.SetPriority','Issue.EditComment'].includes(journal.command.commandType)
        && data?.effectApplied === false && data.committedVersion === journal.command.expectedVersion;
      if (meta?.actorId !== journal.binding.principalId || meta.workspaceId !== journal.command.workspaceId
        || meta.operationId !== journal.command.operationId || data?.entityId !== journal.command.entityId
        || data.outcome !== 'committed' || (data.effectApplied !== true && !noOp)
        || !Number.isSafeInteger(data.committedVersion) || data.committedVersion < 1
        || !Number.isSafeInteger(data.commitSeq) || data.commitSeq < (noOp ? 0 : 1)) result = ambiguous('RECEIPT_BINDING_MISMATCH');
    }
    if (result.kind === 'committed') {
      journal.state = 'committed'; this.#ack = Math.max(this.#ack, journal.revision);
    } else if (result.kind === 'rejected') journal.state = result.body?.error?.outcome === 'rejected'
      && result.body?.error?.effectApplied === false ? 'rejected' : 'blocked';
    else if (result.kind === 'blocked') journal.state = 'blocked';
    else if (result.kind === 'auth-required') { journal.state = 'auth-paused'; this.#session.requireRenewal(); }
    else if (result.kind === 'forbidden') { journal.state = 'denied'; this.#session.deny(); }
    else journal.state = 'unknown';
    if (result.retryAfterMs !== undefined) journal.nextAllowedAt = this.#now() + result.retryAfterMs;
    if (result.retryAt !== undefined) journal.nextAllowedAt = result.retryAt;
    journal.result = result;
    return result;
  }
  async #send(journal, signal) {
    const session = this.#session.current(), epoch = this.#session.snapshot().epoch;
    if (!session) return stopped('AUTH_REQUIRED');
    journal.state = 'submitted'; journal.attempts++;
    const result = await boundedAttempt(attemptSignal => this.#transport.submit({command: clone(journal.command), session, signal: attemptSignal}), this.#attemptDeadline, signal);
    if (!this.#valid(journal, epoch)) {
      if (this.#journal === journal) journal.state = 'auth-paused';
      return stopped('AUTH_EPOCH_CHANGED');
    }
    return this.#apply(journal, result);
  }
  recover() {
    if (this.#flight) return this.#flight;
    const journal = this.#journal;
    if (!journal || journal.attempts === 0) return Promise.resolve(stopped('NO_SUBMITTED_OPERATION'));
    if (['committed', 'rejected', 'blocked', 'denied'].includes(journal.state)) return Promise.resolve(stopped('OPERATION_TERMINAL'));
    if (this.#destroyed) return Promise.resolve(stopped('SESSION_BINDING_CHANGED'));
    const remaining = journal.firstSubmittedAt + this.#deadline - this.#now();
    if (remaining <= 0) return Promise.resolve(stopped('RECOVERY_BUDGET_EXHAUSTED'));
    this.#controller = new AbortController();
    this.#flight = boundedAttempt(signal => this.#recover(journal, signal), remaining, this.#controller.signal)
      .then(result => {
        if (this.#destroyed) return stopped('SESSION_BINDING_CHANGED');
        if (this.#journal === journal && result.kind === 'ambiguous') journal.result = result;
        return result;
      }).finally(() => { this.#flight = null; this.#controller = null; });
    return this.#flight;
  }
  async #recover(journal, signal) {
    let renewed = false;
    if (!this.#session.current()) {
      const renewal = await this.#session.renew();
      if (signal.aborted) return stopped('CANCELLED');
      if (renewal.kind !== 'authenticated') return renewal;
      renewed = true;
    }
    if (this.#journal !== journal || this.#destroyed) return stopped('SESSION_BINDING_CHANGED');
    while (!signal.aborted) {
      const session = this.#session.current(), epoch = this.#session.snapshot().epoch;
      if (!session) return stopped('AUTH_REQUIRED');
      if (this.#now() >= journal.firstSubmittedAt + this.#deadline) return stopped('RECOVERY_BUDGET_EXHAUSTED');
      if (journal.receipts >= this.#maxReceipts) return stopped('RECEIPT_BUDGET_EXHAUSTED');
      journal.receipts++;
      const receipt = await boundedAttempt(s => this.#transport.readReceipt({command: clone(journal.command), session, signal: s}), Math.min(5000, this.#attemptDeadline), signal);
      if (signal.aborted) return stopped('CANCELLED');
      if (!this.#valid(journal, epoch)) return stopped('AUTH_EPOCH_CHANGED');
      if (['auth-required', 'forbidden', 'blocked'].includes(receipt.kind)) return this.#apply(journal, receipt);
      if (!['committed', 'rejected', 'not-observed'].includes(receipt.kind)) { this.#apply(journal, receipt); return stopped('RECEIPT_UNAVAILABLE'); }
      // Same identity is necessary but not enough to display retained content.
      // Revalidate this resource before unlocking any local draft after auth loss.
      if (renewed || this.#locked || (['committed', 'rejected'].includes(receipt.kind) && this.#transport.readResource)) {
        this.#locked = true;
        if (!this.#resourceProject) { this.#locked = true; return stopped('RESOURCE_SCOPE_UNVERIFIED'); }
        if (!this.#transport.readResource) return stopped('RESOURCE_REVALIDATION_REQUIRED');
        // Comment receipts remain bound to the comment; current authorization is
        // checked on its explicitly supplied parent Issue. Never mutate journal.
        const resourceCommand = {...clone(journal.command), entityId: this.#resourceEntity ?? journal.command.entityId};
        const resource = await boundedAttempt(s => this.#transport.readResource({command: resourceCommand, session, signal: s}), Math.min(10000, this.#attemptDeadline), signal);
        if (signal.aborted) return stopped('CANCELLED');
        if (!this.#valid(journal, epoch)) return stopped('AUTH_EPOCH_CHANGED');
        if (resource.kind !== 'resource') {
          if (['auth-required', 'forbidden'].includes(resource.kind)) this.#apply(journal, resource);
          return stopped('RESOURCE_REVALIDATION_FAILED');
        }
        if (resource.body?.data?.id !== resourceCommand.entityId) return stopped('RESOURCE_BINDING_MISMATCH');
        if (resource.body.data.project_id !== this.#resourceProject) {
          this.#locked = true;
          return stopped('RESOURCE_SCOPE_CHANGED');
        }
        journal.latestResource = clone(resource.body.data);
        this.#locked = false; renewed = false;
      }
      if (['committed', 'rejected'].includes(receipt.kind)) return this.#apply(journal, receipt);
      journal.state = 'unknown'; // not_observed is never proof of non-execution.
      if (journal.attempts - 1 >= this.#maxRetries) return stopped('RETRY_BUDGET_EXHAUSTED');
      const baseDelay = Math.max(0, Math.min(1, this.#random())) * (this.#delays[journal.attempts - 1] ?? 10000);
      const next = Math.max(this.#now() + baseDelay, journal.nextAllowedAt ?? 0);
      journal.nextAllowedAt = next;
      if (next >= journal.firstSubmittedAt + this.#deadline) return stopped('RETRY_AFTER_EXCEEDS_BUDGET');
      await this.#sleep(Math.max(0, next - this.#now()), signal);
      if (signal.aborted) return stopped('CANCELLED');
      if (!this.#valid(journal, epoch)) return stopped('AUTH_EPOCH_CHANGED');
      const result = await this.#send(journal, signal);
      if (result.kind !== 'ambiguous') return result;
    }
    return stopped('CANCELLED');
  }
  cancelRecovery() { this.#controller?.abort(); }
  prepareRecovery() {
    // Deliberately never claim that volatile memory survives a navigation.
    return Promise.resolve({kind: 'protection-failed', code: 'MEMORY_ONLY', mayNavigate: false});
  }
  snapshot() {
    const auth = this.#session.snapshot(), journal = this.#journal;
    if (auth.state !== 'authenticated') this.#locked = true;
    return {auth, busy: this.#flight !== null, locked: this.#locked,
      storage: 'memory-only', protection: 'unavailable', mayNavigate: false,
      draft: this.#locked || this.#destroyed ? null : {value: clone(this.#draft), revision: this.#revision,
        acknowledgedRevision: this.#ack, dirty: this.#revision > this.#ack},
      operation: journal ? {operationId: journal.command.operationId, state: journal.state,
        submittedRevision: journal.revision, attempts: journal.attempts, receiptChecks: journal.receipts,
        firstSubmittedAt: journal.firstSubmittedAt, nextAllowedAt: journal.nextAllowedAt,
        outcome: this.#locked ? null : clone(journal.result),
        latestResource: this.#locked ? null : clone(journal.latestResource ?? null)} : null};
  }
  dispose() { this.#controller?.abort(); this.#unsub(); this.#draft = null; this.#journal = null; this.#destroyed = true; this.#locked = true; }
}
