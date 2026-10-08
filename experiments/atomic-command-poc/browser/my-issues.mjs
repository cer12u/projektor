/**
 * Read-only My Issues slice. A verified same-origin session adapter supplies all
 * identity/workspace values. No identity input, decoded JWT, storage, or provider
 * login is implemented here. The companion HTML is an integration laboratory.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATUSES = new Set(['backlog', 'ready', 'in_progress', 'blocked', 'done', 'canceled']);
const RESOLVED = new Set(['done', 'canceled']);
const ITEM_FIELDS = ['id', 'project_id', 'title', 'version', 'assignee_id', 'assignee_kind', 'status_category', 'priority', 'created_at'];
const META_FIELDS = ['workspaceId', 'actorId', 'workspaceEpoch', 'changeSeq', 'visibilityVersion', 'refreshRequired', 'queryFingerprint'];
const copy = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const id = value => typeof value === 'string' && UUID.test(value);
const natural = value => Number.isSafeInteger(value) && value >= 0;
const opaque = value => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\s\u0000-\u001f\u007f]/u.test(value);
const fail = (code, status) => Object.assign(new Error(code), {code, status});
const protocol = () => { throw fail('PROTOCOL_ERROR'); };

export function validateFilters(value = {}) {
  if (!object(value) || Object.keys(value).some(key => !['status', 'limit', 'projectId'].includes(key))) throw fail('INVALID_FILTER');
  const result = {status: value.status === undefined ? 'unresolved' : value.status, limit: value.limit === undefined ? 50 : value.limit, projectId: value.projectId ?? null};
  if (!['unresolved', 'all'].includes(result.status) || !Number.isSafeInteger(result.limit) || result.limit < 1 || result.limit > 100 || result.projectId !== null && !id(result.projectId)) throw fail('INVALID_FILTER');
  return result;
}

/** Validates authenticated endpoint output; validation is not authentication. */
export function validateVerifiedSession(value, now = Date.now()) {
  if (!object(value) || !['principalId', 'workspaceId', 'workspaceEpoch', 'sessionId'].every(key => id(value[key])) || value.actorKind !== 'human' || !natural(value.authzVersion) || !natural(value.expiresAt)) protocol();
  if (value.expiresAt <= now) throw fail('AUTH_REQUIRED', 401);
  // Copy only the identity/lease boundary. Never retain a credential or token.
  return Object.fromEntries(['principalId', 'workspaceId', 'workspaceEpoch', 'sessionId', 'actorKind', 'authzVersion', 'expiresAt'].map(key => [key, value[key]]));
}

function sessionKey(session) {
  return JSON.stringify([session.principalId, session.workspaceId, session.workspaceEpoch, session.sessionId, session.authzVersion]);
}

function orderedBefore(left, right) {
  const priority = (left.priority ?? 5) - (right.priority ?? 5);
  if (priority !== 0) return priority < 0;
  if (left.created_at !== right.created_at) return left.created_at < right.created_at;
  return left.id < right.id;
}

async function readJSON(response) {
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') protocol();
  const maximum = 1024 * 1024;
  if (Number(response.headers.get('content-length')) > maximum) protocol();
  const reader = response.body?.getReader();
  if (!reader) protocol();
  const decoder = new TextDecoder('utf-8', {fatal: true});
  let text = '', length = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) { void reader.cancel().catch(() => {}); protocol(); }
      text += decoder.decode(value, {stream: true});
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    if (error.code) throw error;
    protocol();
  } finally { reader.releaseLock(); }
}

/** One bounded GET, including response body parsing; no redirects or auto-retry. */
async function requestJSON(fetchImpl, url, {signal, deadlineMs}) {
  const controller = new AbortController();
  let timer, stop;
  const cancelled = new Promise((_, reject) => {
    stop = () => { controller.abort(); reject(fail('CANCELLED')); };
    timer = setTimeout(() => { controller.abort(); reject(fail('TIMEOUT')); }, deadlineMs);
    if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, {once: true});
  });
  try {
    if (signal?.aborted) throw fail('CANCELLED');
    return await Promise.race([cancelled, (async () => {
      let response;
      try {
        response = await fetchImpl(url, {method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal, headers: {Accept: 'application/json'}});
      } catch (error) { throw error.code ? error : fail('NETWORK_ERROR'); }
      if (response.status === 401) throw fail('AUTH_REQUIRED', 401);
      if (response.status === 403) throw fail('FORBIDDEN', 403);
      if (response.redirected || response.status >= 300 && response.status < 400) protocol();
      if (response.status === 429 || response.status >= 500) throw fail('SERVER_UNAVAILABLE', response.status);
      const body = await readJSON(response);
      if (!response.ok) {
        const code = body?.error?.code;
        if (['EPOCH_MISMATCH', 'WORKSPACE_MISMATCH'].includes(code)) throw fail(code, response.status);
        if (typeof code === 'string' && /^(?:CURSOR_|QUERY_CHANGED|REFRESH_REQUIRED)/u.test(code)) throw fail('REFRESH_REQUIRED', response.status);
        throw fail('PROTOCOL_ERROR', response.status);
      }
      return body;
    })()]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}

function originURL(baseUrl) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw fail('INVALID_ORIGIN');
  if (globalThis.location && base.origin !== globalThis.location.origin) throw fail('CROSS_ORIGIN_ENDPOINT');
  return base.origin;
}

export function createVerifiedSessionAdapter({baseUrl = globalThis.location?.origin, fetchImpl = globalThis.fetch, deadlineMs = 8000, now = Date.now} = {}) {
  const origin = originURL(baseUrl);
  return {async read({signal} = {}) {
    return validateVerifiedSession(await requestJSON(fetchImpl, `${origin}/v1/session`, {signal, deadlineMs}), now());
  }};
}

export function createMyIssuesTransport({baseUrl = globalThis.location?.origin, fetchImpl = globalThis.fetch, deadlineMs = 8000} = {}) {
  const origin = originURL(baseUrl);
  return {async read({session, filters, cursor = null, signal}) {
    const url = new URL(`/v1/workspaces/${session.workspaceId}/my-issues`, origin);
    url.searchParams.set('workspaceEpoch', session.workspaceEpoch);
    url.searchParams.set('status', filters.status);
    url.searchParams.set('limit', String(filters.limit));
    if (filters.projectId) url.searchParams.set('projectId', filters.projectId);
    if (cursor) url.searchParams.set('cursor', cursor);
    return requestJSON(fetchImpl, url, {signal, deadlineMs});
  }};
}

/** Strict selected projection; unknown fields never reach the view. */
export function validateMyIssuesPage(body, {session, filters}) {
  if (!exact(body, ['data', 'meta']) || !exact(body.data, ['items', 'nextCursor', 'total']) || !exact(body.meta, META_FIELDS)) protocol();
  const {data, meta} = body;
  if (meta.workspaceId !== session.workspaceId || meta.actorId !== session.principalId) throw fail('BINDING_MISMATCH');
  if (meta.workspaceEpoch !== session.workspaceEpoch) throw fail('EPOCH_MISMATCH');
  if (!natural(meta.changeSeq) || !natural(meta.visibilityVersion) || typeof meta.refreshRequired !== 'boolean' || typeof meta.queryFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(meta.queryFingerprint) || !natural(data.total) || !Array.isArray(data.items) || data.items.length > filters.limit || data.nextCursor !== null && !opaque(data.nextCursor)) protocol();
  const seen = new Set();
  for (const item of data.items) {
    if (!exact(item, ITEM_FIELDS) || !id(item.id) || !id(item.project_id) || typeof item.title !== 'string' || !item.title.isWellFormed() || new TextEncoder().encode(item.title).byteLength > 4096 || item.title.trim().length === 0 || !Number.isSafeInteger(item.version) || item.version < 1 || item.assignee_id !== session.principalId || item.assignee_kind !== 'human' || !STATUSES.has(item.status_category) || item.priority !== null && (!Number.isSafeInteger(item.priority) || item.priority < 0 || item.priority > 4) || !natural(item.created_at) || seen.has(item.id)) protocol();
    if (filters.projectId && item.project_id !== filters.projectId || filters.status === 'unresolved' && RESOLVED.has(item.status_category)) protocol();
    seen.add(item.id);
  }
  if (!meta.refreshRequired && (data.items.length > data.total || data.nextCursor !== null && data.items.length === 0)) protocol();
  return copy(body);
}

export class MyIssuesController {
  constructor({sessionAdapter, transport, filters = {}, onChange = () => {}, now = Date.now} = {}) {
    if (typeof sessionAdapter?.read !== 'function' || typeof transport?.read !== 'function') throw fail('VERIFIED_ADAPTER_REQUIRED');
    this.sessionAdapter = sessionAdapter;
    this.transport = transport;
    this.filters = validateFilters(filters);
    this.onChange = onChange;
    this.now = now;
    this.generation = 0;
    this.visible = true;
    this.disposed = false;
    this.flight = null;
    this.session = null;
    this.phase = 'locked';
    this.code = 'VERIFY_SESSION';
    this.clearData();
  }

  clearData() {
    this.items = [];
    this.total = null;
    this.nextCursor = null;
    this.meta = null;
    this.cursors = new Set();
  }

  snapshot() {
    return copy({phase: this.phase, code: this.code, busy: !!this.flight, locked: this.phase === 'locked', filters: this.filters, items: this.items, total: this.total, nextCursor: this.nextCursor, complete: ['ready', 'empty'].includes(this.phase) && this.nextCursor === null, refreshRequired: this.phase === 'stale'});
  }

  emit() { this.onChange(this.snapshot()); }

  invalidate() {
    this.generation++;
    this.flight?.abort.abort();
    this.flight = null;
    clearTimeout(this.expiryTimer);
  }

  lock(code = 'VERIFY_SESSION') {
    this.invalidate();
    this.clearData();
    this.session = null;
    this.phase = 'locked';
    this.code = code;
    this.emit();
    return {kind: 'locked', code};
  }

  setVisible(visible) {
    this.visible = !!visible;
    if (!visible) return this.lock('HIDDEN');
    return this.refresh();
  }

  sessionChanged() {
    this.lock('SESSION_CHANGED');
    return this.visible ? this.refresh() : Promise.resolve({kind: 'stopped'});
  }

  setFilters(value) {
    const filters = validateFilters({...this.filters, ...value});
    if (JSON.stringify(filters) === JSON.stringify(this.filters)) return Promise.resolve({kind: 'unchanged'});
    this.filters = filters;
    return this.refresh();
  }

  refresh() {
    if (this.disposed || !this.visible) return Promise.resolve({kind: 'stopped'});
    this.invalidate();
    this.clearData();
    this.session = null;
    return this.request(false);
  }

  loadMore() {
    if (this.disposed || !this.visible || this.flight || this.phase !== 'partial' || this.nextCursor === null) return Promise.resolve({kind: 'stopped'});
    return this.request(true);
  }

  retry() {
    if (this.flight) return Promise.resolve({kind: 'stopped'});
    return this.phase === 'partial' && this.code ? this.loadMore() : this.refresh();
  }

  current(flight) {
    return !this.disposed && this.visible && this.flight === flight && this.generation === flight.generation;
  }

  lease(session) {
    clearTimeout(this.expiryTimer);
    const remaining = session.expiresAt - this.now();
    if (remaining <= 0) { this.lock('AUTH_REQUIRED'); return false; }
    this.expiryTimer = setTimeout(() => this.lock('AUTH_REQUIRED'), Math.min(remaining, 2147483647));
    this.expiryTimer.unref?.();
    return true;
  }

  async request(append) {
    const flight = {generation: this.generation, abort: new AbortController()};
    this.flight = flight;
    this.phase = append ? 'partial' : 'loading';
    this.code = null;
    this.emit();
    const filters = copy(this.filters);
    const cursor = append ? this.nextCursor : null;
    const previousSession = this.session;
    try {
      const verified = await this.sessionAdapter.read({signal: flight.abort.signal});
      if (!this.current(flight)) return {kind: 'discarded'};
      const session = validateVerifiedSession(verified, this.now());
      if (append && sessionKey(previousSession) !== sessionKey(session)) return this.lock('SESSION_CHANGED');
      this.session = session;
      if (!this.lease(session)) return {kind: 'locked', code: 'AUTH_REQUIRED'};
      const result = await this.transport.read({session: copy(session), filters, cursor, signal: flight.abort.signal});
      if (!this.current(flight)) return {kind: 'discarded'};
      if (this.now() >= session.expiresAt) return this.lock('AUTH_REQUIRED');
      const body = validateMyIssuesPage(result, {session, filters});
      const {data, meta} = body;
      // An authorization/projection change can invalidate already displayed rows.
      // Drop the entire snapshot; never combine or display an old prefix as current.
      if (meta.refreshRequired || append && (meta.changeSeq !== this.meta.changeSeq || meta.visibilityVersion !== this.meta.visibilityVersion || meta.queryFingerprint !== this.meta.queryFingerprint || data.total !== this.total)) {
        this.clearData(); this.phase = 'stale'; this.code = 'REFRESH_REQUIRED';
        return {kind: 'stale'};
      }
      const items = append ? [...this.items, ...data.items] : data.items;
      if (new Set(items.map(item => item.id)).size !== items.length || data.nextCursor !== null && (this.cursors.has(data.nextCursor) || data.nextCursor === cursor) || items.length > data.total || data.nextCursor === null && items.length !== data.total || data.nextCursor !== null && items.length >= data.total) protocol();
      if (items.some((item, index) => index > 0 && !orderedBefore(items[index - 1], item))) protocol();
      if (cursor) this.cursors.add(cursor);
      this.items = items;
      this.total = data.total;
      this.nextCursor = data.nextCursor;
      this.meta = meta;
      this.phase = data.nextCursor ? 'partial' : items.length ? 'ready' : 'empty';
      return {kind: this.phase};
    } catch (error) {
      if (!this.current(flight)) return {kind: 'discarded'};
      const code = error.code ?? 'NETWORK_ERROR';
      if (['AUTH_REQUIRED', 'FORBIDDEN', 'EPOCH_MISMATCH', 'WORKSPACE_MISMATCH', 'BINDING_MISMATCH'].includes(code) || [401, 403].includes(error.status)) return this.lock(code);
      if (code === 'REFRESH_REQUIRED') {
        this.clearData(); this.phase = 'stale'; this.code = code;
      } else if (append && ['NETWORK_ERROR', 'SERVER_UNAVAILABLE', 'TIMEOUT'].includes(code)) {
        this.phase = 'partial'; this.code = code;
      } else {
        this.clearData(); this.phase = 'error'; this.code = code;
      }
      return {kind: this.phase, code};
    } finally {
      if (this.current(flight)) { this.flight = null; this.emit(); }
    }
  }

  dispose() { this.disposed = true; this.lock('DISPOSED'); }
}

const statusText = state => {
  if (state.phase === 'locked') return state.code === 'HIDDEN' ? 'List hidden. Your session must be checked again.' : 'List locked. Verify your session to continue.';
  if (state.phase === 'loading') return 'Checking your session and loading issues…';
  if (state.phase === 'stale') return 'Issues or access changed. Refresh to load the current list.';
  if (state.phase === 'error') return 'Could not load a trustworthy list. Retry to check again.';
  if (state.phase === 'empty') return 'No issues match this filter.';
  if (state.phase === 'partial') return `${state.items.length} of ${state.total} issues loaded. ${state.busy ? 'Loading more…' : state.code ? 'Previously loaded issues may be out of date. The next page failed. Retry to continue.' : 'More issues are available.'}`;
  return `${state.total} ${state.total === 1 ? 'issue' : 'issues'} loaded.`;
};

export function mountMyIssues({root = document.querySelector('[data-my-issues]'), sessionAdapter = createVerifiedSessionAdapter(), transport = createMyIssuesTransport(), filters} = {}) {
  if (!root) throw fail('VIEW_REQUIRED');
  const document = root.ownerDocument;
  const window = document.defaultView;
  const list = root.querySelector('[data-issues]');
  const status = root.querySelector('[data-status]');
  const refresh = root.querySelector('[data-refresh]');
  const more = root.querySelector('[data-more]');
  const retry = root.querySelector('[data-retry]');
  const filter = root.querySelector('[data-status-filter]');
  const count = root.querySelector('[data-count]');
  const render = state => {
    root.setAttribute('aria-busy', String(state.busy));
    status.textContent = statusText(state);
    status.dataset.phase = state.phase;
    count.textContent = state.total === null ? '' : `${state.items.length} / ${state.total}`;
    filter.value = state.filters.status;
    refresh.disabled = state.busy;
    more.hidden = state.phase !== 'partial' || !!state.code;
    more.disabled = state.busy;
    retry.hidden = !['error', 'locked'].includes(state.phase) && !(state.phase === 'partial' && state.code);
    retry.disabled = state.busy;
    const fragment = document.createDocumentFragment();
    for (const item of state.items) {
      const row = document.createElement('li');
      const title = document.createElement('strong');
      title.textContent = item.title;
      const detail = document.createElement('span');
      detail.className = 'issue-detail';
      detail.textContent = `${item.status_category.replaceAll('_', ' ')} · ${item.priority === null ? 'No priority' : `Priority ${item.priority}`} · Project ${item.project_id}`;
      row.append(title, detail);
      fragment.append(row);
    }
    list.replaceChildren(fragment);
  };
  const controller = new MyIssuesController({sessionAdapter, transport, filters, onChange: render});
  const onRefresh = () => controller.refresh();
  const onMore = () => controller.loadMore();
  const onRetry = () => controller.retry();
  const onFilter = () => controller.setFilters({status: filter.value});
  const onVisibility = () => controller.setVisible(document.visibilityState !== 'hidden');
  const onPageHide = () => controller.setVisible(false);
  const onPageShow = () => controller.setVisible(document.visibilityState !== 'hidden');
  const onSession = () => controller.sessionChanged();
  refresh.addEventListener('click', onRefresh);
  more.addEventListener('click', onMore);
  retry.addEventListener('click', onRetry);
  filter.addEventListener('change', onFilter);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);
  const channel = typeof window.BroadcastChannel === 'function' ? new window.BroadcastChannel('projektor-session') : null;
  channel?.addEventListener('message', onSession);
  const dispose = controller.dispose.bind(controller);
  controller.dispose = () => {
    refresh.removeEventListener('click', onRefresh);
    more.removeEventListener('click', onMore);
    retry.removeEventListener('click', onRetry);
    filter.removeEventListener('change', onFilter);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', onPageShow);
    channel?.close();
    dispose();
  };
  render(controller.snapshot());
  controller.setVisible(document.visibilityState !== 'hidden');
  return controller;
}

if (typeof document !== 'undefined' && document.querySelector('[data-my-issues]')) {
  window.myIssues = mountMyIssues();
}
