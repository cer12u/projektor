import {MachineWorkflowClient} from './agent-workflow.mjs';
import {commandTools} from '../src/adapters.mjs';

const MODERN = '2026-07-28', LEGACY = '2025-11-25';
const commandNames = Object.fromEntries(Object.entries(commandTools).map(([name, type]) => [type, name]));
const fail = code => Object.assign(new Error(code), {code});
const terminalAuth = new Set(['UNAUTHENTICATED', 'CREDENTIAL_EXPIRED', 'CREDENTIAL_REVOKED', 'FORBIDDEN', 'WORKSPACE_MISMATCH', 'SCOPE_CHANGED']);

/** Existing authorized provider only. Never reads env/files, enrolls, renews, or saves a token. */
export function createMachineTransport({baseUrl, getToken, fetchImpl = globalThis.fetch, protocol = 'rest', attemptDeadlineMs = 10000}) {
  const base = new URL(baseUrl);
  if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname))) || base.username || base.password || base.search || base.hash || typeof getToken !== 'function' || !['rest', 'mcp-modern', 'mcp-legacy'].includes(protocol)) throw fail('MACHINE_TRANSPORT_CONFIG');
  let sessionId = null, sessionWorkspace = null, initializeFlight = null, rpcId = 0;
  const root = args => `/machine/v1/workspaces/${encodeURIComponent(args.workspaceId)}`;
  async function request(path, {body, headers = {}, notification = false, method} = {}) {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        (async () => {
          let token;
          try { token = await getToken({signal: controller.signal}); } catch { throw fail('MACHINE_CREDENTIAL_UNAVAILABLE'); }
          if (controller.signal.aborted) throw fail('TIMEOUT');
          if (typeof token !== 'string' || !token || token.length > 8192 || !/^[\x21-\x7e]+$/.test(token)) throw fail('MACHINE_CREDENTIAL_UNAVAILABLE');
          const response = await fetchImpl(new URL(path, base.origin), {method: method ?? (body ? 'POST' : 'GET'), headers: {accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, ...(body ? {'content-type': 'application/json'} : {}), ...headers}, ...(body ? {body: JSON.stringify(body)} : {}), signal: controller.signal, redirect: 'manual', credentials: 'omit', cache: 'no-store'});
          if (response.status === 401) throw fail('MACHINE_CREDENTIAL_REJECTED');
          if (response.status === 403) throw fail('MACHINE_SCOPE_OR_CREDENTIAL_DENIED');
          if (response.status >= 300 && response.status < 400) throw fail('UNEXPECTED_AUTH_REDIRECT');
          if (notification && [202,204].includes(response.status)) return {response};
          const type = response.headers.get('content-type') ?? '';
          if (!type.includes('application/json')) throw fail('PROTOCOL_ERROR');
          const data = await response.json();
          if (protocol === 'mcp-legacy' && response.status === 404 && data?.error?.code === -32600 && data.error.message === 'Session not found') { sessionId = null; throw fail('MCP_PROTOCOL_SESSION_EXPIRED'); }
          if (response.status >= 500 || response.status === 429) {
            const error = fail('TRANSPORT_UNAVAILABLE');
            const retry = response.headers.get('retry-after');
            error.retryAt = /^\d+(\.\d+)?$/.test(retry ?? '') ? Date.now() + Number(retry) * 1000 : Date.parse(retry);
            throw error;
          }
          if (body?.jsonrpc && (data?.jsonrpc !== '2.0' || data.id !== body.id)) throw fail('RPC_BINDING_MISMATCH');
          if (body?.jsonrpc && data.error) throw fail(typeof data.error.data?.code === 'string' ? data.error.data.code : 'MCP_PROTOCOL_ERROR');
          if (!response.ok && !data?.error) throw fail('PROTOCOL_ERROR');
          return {response, data};
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(fail('TIMEOUT')); }, attemptDeadlineMs); }),
      ]);
    } catch (error) {
      if (error.code) throw error;
      throw fail('TRANSPORT_UNKNOWN'); // Never propagate provider or network secret-bearing text.
    } finally { clearTimeout(timer); }
  }
  async function initialize(args) {
    if (sessionId) return;
    if (initializeFlight) return initializeFlight;
    initializeFlight = (async () => {
      const result = await request(root(args) + '/mcp', {body: {jsonrpc: '2.0', id: ++rpcId, method: 'initialize', params: {protocolVersion: LEGACY, capabilities: {}, clientInfo: {name: 'projektor-runtime', version: '1'}}}, headers: {'mcp-protocol-version': LEGACY}});
      const candidate = result.response.headers.get('mcp-session-id');
      if (result.data?.result?.protocolVersion !== LEGACY || !candidate || !/^[\x21-\x7e]{1,128}$/.test(candidate)) throw fail('MCP_INITIALIZE_INVALID');
      await request(root(args) + '/mcp', {body: {jsonrpc: '2.0', method: 'notifications/initialized'}, headers: {'mcp-protocol-version': LEGACY, 'mcp-session-id': candidate}, notification: true});
      sessionId = candidate; sessionWorkspace = args.workspaceId;
    })().finally(() => { initializeFlight = null; });
    return initializeFlight;
  }
  async function call(name, args, mutation = false) {
    if (protocol === 'rest') {
      const tails = {capabilities_get: 'capabilities', operation_get: `operations/${encodeURIComponent(args.operationId)}`, issue_get: `issues/${encodeURIComponent(args.entityId)}`, claim_get: `issues/${encodeURIComponent(args.entityId)}/claim`, attempt_checkpoint_get: `issues/${encodeURIComponent(args.entityId)}/checkpoint`};
      if (!mutation && !Object.hasOwn(tails, name)) throw fail('REST_QUERY_UNSUPPORTED');
      const path = root(args) + (mutation ? '/commands' : `/${tails[name]}?workspaceEpoch=${encodeURIComponent(args.workspaceEpoch)}`);
      return (await request(path, mutation ? {body: args, headers: {'idempotency-key': args.operationId}} : {})).data;
    }
    if (protocol === 'mcp-legacy') await initialize(args);
    const params = {name, arguments: args};
    const headers = {'mcp-protocol-version': protocol === 'mcp-modern' ? MODERN : LEGACY, ...(mutation ? {'idempotency-key': args.operationId} : {})};
    if (protocol === 'mcp-modern') {
      params._meta = {'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientCapabilities': {}};
      Object.assign(headers, {'mcp-method': 'tools/call', 'mcp-name': name});
    } else headers['mcp-session-id'] = sessionId;
    const result = (await request(root(args) + '/mcp', {body: {jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params}, headers})).data?.result;
    if (!result || !Object.hasOwn(result, 'structuredContent')) throw fail('MCP_STRUCTURED_CONTENT_REQUIRED');
    return result.structuredContent;
  }
  return Object.freeze({
    async close() {
      if (protocol !== 'mcp-legacy' || !sessionId) return;
      const current = sessionId; sessionId = null;
      await request(root({workspaceId: sessionWorkspace}) + '/mcp', {method:'DELETE', headers:{'mcp-protocol-version':LEGACY,'mcp-session-id':current}, notification:true});
    },
    command(envelope) { if (!commandNames[envelope.commandType]) throw fail('COMMAND_UNSUPPORTED'); return call(commandNames[envelope.commandType], envelope, true); },
    async query(name, args) {
      try { return await call(name, args); }
      catch (error) { if (error.code !== 'MCP_PROTOCOL_SESSION_EXPIRED') throw error; return call(name, args); } // Only a read reconnects once; mutation is never silently replayed.
    },
  });
}

/** Durable recovery wrapper. All uncertain mutations are reconciled, never blindly resent. */
export class MachineRuntime {
  constructor({transport, journal, runtimeInstanceId, readBinding, now = Date.now, recoveryDeadlineMs = 60000, maxReceiptChecks = 4, retryDelaysMs = [1000, 3000, 10000], sleep = ms => new Promise(resolve => setTimeout(resolve, ms))}) {
    if (!journal?.load || !journal?.save || !journal?.listUnresolved || !journal?.takeRecoveryAttempt) throw fail('DURABLE_JOURNAL_REQUIRED');
    this.readBinding = readBinding ?? (context => transport.query('capabilities_get', {workspaceId: context.workspaceId, workspaceEpoch: context.workspaceEpoch}));
    const boundJournal = {load: id => journal.load(id), listUnresolved: () => journal.listUnresolved(), save: record => journal.save({...record, machineBinding: record.machineBinding ?? this.binding})};
    this.workflow = new MachineWorkflowClient({transport, journal: boundJournal, runtimeInstanceId});
    Object.assign(this, {transport, journal, runtimeInstanceId, now, recoveryDeadlineMs: Math.min(60000, Math.max(1, recoveryDeadlineMs)), maxReceiptChecks: Math.min(4, Math.max(1, maxReceiptChecks)), retryDelaysMs, sleep});
  }
  async connect(context, required = {}) {
    const previousBinding = this.binding;
    this.binding = null;
    this.workflow.pause();
    this.workflow.context = null;
    const response = await this.readBinding(structuredClone(context)), binding = response?.data;
    if (!binding || binding.actorKind !== 'machine' || typeof binding.credentialId !== 'string' || !binding.credentialId || !Array.isArray(binding.scopes) || binding.scopes.some(scope => typeof scope !== 'string')) throw fail('VERIFIED_MACHINE_BINDING_REQUIRED');
    if (['principalId','workspaceId','workspaceEpoch'].some(key => binding[key] !== context[key])) throw fail('MACHINE_BINDING_MISMATCH');
    if (previousBinding && (previousBinding.credentialId !== binding.credentialId || binding.scopes.some(scope => !previousBinding.scopes.includes(scope)))) throw fail('MACHINE_BINDING_CHANGED');
    this.binding = structuredClone(Object.fromEntries(['principalId','credentialId','workspaceId','workspaceEpoch','actorKind','scopes'].map(key => [key,binding[key]])));
    return this.workflow.discover(context, required);
  }
  submit(envelope) { if (!this.binding) throw fail('VERIFIED_MACHINE_BINDING_REQUIRED'); return this.workflow.submit(envelope); }
  async recover(operationId) {
    const record = await this.journal.load(operationId);
    if (!record) throw fail('JOURNAL_MISSING');
    if (!this.binding) throw fail('VERIFIED_MACHINE_BINDING_REQUIRED');
    if (!record.machineBinding || record.machineBinding.credentialId !== this.binding.credentialId || this.binding.scopes.some(scope => !record.machineBinding.scopes.includes(scope))) throw fail('MACHINE_BINDING_CHANGED');
    if (!this.workflow.context || record.principalId !== this.workflow.context.principalId || record.envelope.workspaceId !== this.workflow.context.workspaceId || record.envelope.workspaceEpoch !== this.workflow.context.workspaceEpoch) throw fail('RECOVERY_BINDING_MISMATCH');
    while (true) {
      const budget = await this.journal.takeRecoveryAttempt(operationId, {now: this.now(), deadlineMs: this.recoveryDeadlineMs, maxChecks: this.maxReceiptChecks});
      if (!budget.allowed) return {error: {code: budget.code, outcome: 'unknown'}};
      if (budget.nextAllowedAt > this.now()) await this.sleep(budget.nextAllowedAt - this.now());
      try {
        if (this.now() >= budget.deadline) return {error: {code: 'RECOVERY_DEADLINE_EXHAUSTED', outcome: 'unknown'}};
        let timer;
        let result;
        try {
          result = await Promise.race([this.workflow.reconcile(operationId), new Promise((_, reject) => { timer = setTimeout(() => reject(fail('RECOVERY_DEADLINE_EXHAUSTED')), budget.deadline - this.now()); })]);
        } finally { clearTimeout(timer); }
        if (result?.error?.code !== 'OUTCOME_UNKNOWN') return result;
        // not_observed is not proof of non-execution; keep the original ID unresolved.
        return result;
      } catch (error) {
        this.workflow.pause();
        if (error.code === 'RECOVERY_DEADLINE_EXHAUSTED') return {error: {code: error.code, outcome: 'unknown'}};
        if (terminalAuth.has(error.code) || /CREDENTIAL|SCOPE|AUTH|BINDING|PROTOCOL/.test(error.code ?? '')) throw error;
        const nextAllowedAt = Math.max(this.now() + (this.retryDelaysMs[budget.checks - 1] ?? 10000), Number.isFinite(error.retryAt) ? error.retryAt : 0);
        await this.journal.deferRecovery(operationId, nextAllowedAt);
      }
    }
  }
}
