import {
  type Call,
  type Clock,
  type IdGenerator,
  type ModuleStore,
  PlatformError,
  type Row,
  type ScopedKV,
} from "../../../platform/public";
import type { AccessMaintenance } from "../public";
import {
  type AccessApi,
  type AccessEvent,
  type AuthenticatedPrincipal,
  type CommandResult,
  type EventReader,
  type EventType,
  OAuthInsufficientScope,
  type OperatorCapability,
  type Permission,
  type PrincipalSummary,
  type RequestScope,
} from "../public";
import type { queries } from "../storage/queries";
import { type AccessConfig, createAssertionVerifier, type JwksFetcher } from "./assertions";
import { type Identity, num, str } from "./identity";
import { createMaintenance } from "./maintenance";
import { createOAuth, type OAuthConfig } from "./oauth";
import {
  deny,
  hash,
  humanId,
  identifier,
  inputObject,
  manage,
  permission,
  role,
  textValue,
  valid,
  version,
} from "./rules";

type Name = keyof typeof queries;
type Statement = Call<Name>;
interface ScopeIdentity {
  readonly identity: Identity;
  readonly workspaceId: string;
  readonly requestId: string;
}
interface Dependencies {
  readonly store: ModuleStore<"access", Name>;
  readonly kv: ScopedKV;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly config: AccessConfig;
  readonly oauth?: OAuthConfig;
  readonly fetchJwks?: JwksFetcher;
  readonly enableBootstrap?: boolean;
  readonly eventConsumer?: string;
}
function result(row: Row): CommandResult {
  return { id: str(row, "result_id"), version: num(row, "result_version") };
}
/** Composition only: retain operator/event capabilities outside Gateway's API reference. */
export function createAccess(deps: Dependencies): {
  api: AccessApi;
  maintenance: AccessMaintenance;
  operator?: OperatorCapability;
  eventReader?: EventReader;
  background: {
    listActiveWorkspaceIds(
      cursor?: string,
      limit?: number,
    ): Promise<{ workspaceIds: readonly string[]; nextCursor: string | null }>;
  };
} {
  const { store, kv, clock, ids } = deps;
  if (store.owner !== "access") deny();
  const teamDomain = deps.config.teamDomain;
  const verify = createAssertionVerifier(deps.config, kv, clock, deps.fetchJwks);
  const principals = new WeakMap<AuthenticatedPrincipal, Identity>();
  const scopes = new WeakMap<RequestScope, ScopeIdentity>();
  const operator = deps.enableBootstrap ? (Object.freeze({}) as OperatorCapability) : undefined;
  const eventReader = deps.eventConsumer ? (Object.freeze({}) as EventReader) : undefined;
  const one = async (name: Name, values: Statement["values"]): Promise<Row | undefined> =>
    (await store.run(name, values)).rows[0];
  const receipt = (w: string, p: string, op: string) => one("readReceipt", [w, p, op]);
  const identity = (principal: AuthenticatedPrincipal): Identity => {
    const p = principals.get(principal);
    if (!p) deny();
    return p;
  };
  async function live(p: Identity): Promise<void> {
    if (p.expiresAt <= clock.now()) deny();
    if (p.clientId) await oauth.live(p);
    if (p.kind === "machine") {
      const c = await one("credential", [p.workspaceId ?? "", p.credentialId ?? ""]);
      if (
        c?.revoked !== 0 ||
        num(c, "expires_at") <= clock.now() ||
        c.token_hash !== p.tokenHash ||
        c.principal_id !== p.id
      )
        deny();
    }
  }
  async function admit(
    p: Identity,
    w: string,
    requestId: string,
    mode: Permission,
  ): Promise<RequestScope> {
    permission(mode);
    identifier(w);
    textValue(requestId);
    if (p.kind === "machine") {
      if (p.expiresAt <= clock.now()) deny();
    } else await live(p);
    if (p.workspaceId !== undefined && p.workspaceId !== w) deny();
    const member =
      p.kind === "machine"
        ? await one("machineAdmission", [w, p.credentialId ?? ""])
        : await one("admission", [w, p.id]);
    if (
      p.kind === "machine" &&
      (!member ||
        member.revoked !== 0 ||
        num(member, "expires_at") <= clock.now() ||
        member.token_hash !== p.tokenHash ||
        member.principal_id !== p.id)
    )
      deny();
    if (!member || member.role === null) deny();
    const memberRole = role(member.role);
    if (mode === "write") {
      if (p.clientId && p.oauthScope !== "write") throw new OAuthInsufficientScope();
      if (memberRole === "viewer") deny();
      if (p.kind === "machine") {
        if (member.scope !== "write") deny();
      }
    }
    const scope = Object.freeze({
      workspaceId: w,
      principalId: p.id,
      requestId,
      role: memberRole,
      kind: p.kind,
      ...(p.clientId ? { clientId: p.clientId } : {}),
    }) as RequestScope;
    scopes.set(scope, { identity: p, workspaceId: w, requestId });
    return scope;
  }
  async function authorize(scope: RequestScope, mode: Permission = "read"): Promise<RequestScope> {
    const state = scopes.get(scope);
    if (!state) deny();
    return admit(state.identity, state.workspaceId, state.requestId, mode);
  }
  async function manager(scope: RequestScope): Promise<RequestScope> {
    const current = await authorize(scope, "write");
    if (
      current.kind !== "human" ||
      current.clientId ||
      (current.role !== "owner" && current.role !== "admin")
    )
      deny();
    return current;
  }
  async function replay(
    w: string,
    p: string,
    op: string,
    fingerprint: string,
  ): Promise<CommandResult | undefined> {
    const saved = await receipt(w, p, op);
    if (!saved) return undefined;
    if (saved.fingerprint !== fingerprint)
      throw new PlatformError("conflict", "Operation ID reused with different input");
    return result(saved);
  }
  async function commit(
    w: string,
    p: string,
    op: string,
    fingerprint: string,
    output: CommandResult,
    type: EventType,
    calls: readonly Statement[],
    afterGuard: readonly Statement[] = [],
  ): Promise<CommandResult> {
    const guardId = ids.next();
    try {
      await store.batch([
        ...calls,
        { name: "guard", values: [w, guardId] },
        ...afterGuard,
        { name: "receipt", values: [w, p, op, fingerprint, output.id, output.version] },
        {
          name: "event",
          values: [w, w, ids.next(), output.id, output.version, type, clock.now(), p],
        },
        { name: "clearGuard", values: [w, guardId] },
      ]);
      return output;
    } catch (error) {
      // A concurrent duplicate or a lost response can already have committed.
      let saved: CommandResult | undefined;
      try {
        saved = await replay(w, p, op, fingerprint);
      } catch (recovery) {
        if (recovery instanceof PlatformError) throw recovery;
        throw new PlatformError(
          "unknown",
          "Operation outcome unknown; retry the same operation ID",
        );
      }
      if (saved) return saved;
      if (error instanceof Error && /scope frozen/i.test(error.message))
        throw new PlatformError("conflict", "Scope frozen");
      if (
        error instanceof Error &&
        /(?:CHECK|UNIQUE|FOREIGN KEY) constraint failed/i.test(error.message)
      )
        throw new PlatformError("conflict", "Version or invariant conflict");
      throw new PlatformError("unknown", "Operation outcome unknown; retry the same operation ID");
    }
  }
  async function fingerprint(kind: string, op: string, args: readonly unknown[]): Promise<string> {
    identifier(op);
    return hash(JSON.stringify([kind, ...args]));
  }
  function putPrincipal(p: PrincipalSummary): Statement {
    return { name: "putPrincipal", values: [p.id, p.kind, p.issuer, p.subject] };
  }
  async function workspace(
    principal: AuthenticatedPrincipal,
    input: { workspaceId: string; name: string; operationId: string },
    bootstrap: boolean,
  ): Promise<CommandResult> {
    const p = identity(principal);
    await live(p);
    if (p.kind !== "human" || p.clientId) deny();
    inputObject(input);
    const w = identifier(input.workspaceId);
    const name = textValue(input.name);
    const fp = await fingerprint(bootstrap ? "bootstrap" : "createWorkspace", input.operationId, [
      w,
      name,
    ]);
    const saved = await receipt(w, p.id, input.operationId);
    if (saved) {
      await admit(p, w, "workspace-retry", "read");
      return (await replay(w, p.id, input.operationId, fp)) ?? deny();
    }
    const calls: Statement[] = [];
    if (bootstrap) calls.push({ name: "bootstrap", values: [w] });
    calls.push(
      putPrincipal(p),
      { name: "createWorkspace", values: [w, name] },
      { name: "addMember", values: [w, p.id, "owner", 0] },
    );
    return commit(w, p.id, input.operationId, fp, { id: w, version: 1 }, "WorkspaceCreated", calls);
  }
  const oauth = createOAuth({
    store,
    clock,
    ids,
    config: deps.oauth,
    replay,
    commit,
    manager,
    async interactivePrincipal(principal) {
      const p = identity(principal);
      await live(p);
      if (p.kind !== "human" || p.clientId) deny();
      return p;
    },
    async interactiveScope(scope, mode) {
      const s = await authorize(scope, mode);
      if (s.kind !== "human" || s.clientId) deny();
      return s;
    },
  });
  async function current(p: Identity, cursor = "", limit = 50) {
    await live(p);
    if (p.kind === "human" && p.email) {
      await store.run("refreshProfile", [
        p.email,
        p.displayName ?? p.subject,
        p.id,
        p.email,
        p.displayName ?? p.subject,
      ]);
    }
    if (cursor) identifier(cursor);
    valid(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100);
    const rows = (
      await store.run("discoverWorkspaces", [
        p.id,
        p.workspaceId ?? null,
        p.workspaceId ?? null,
        cursor,
        limit + 1,
      ])
    ).rows;
    const client = p.clientId ? await one("oauthClient", [p.clientId]) : undefined;
    return {
      principal: {
        id: p.id,
        kind: p.clientId ? ("oauth" as const) : p.kind,
        displayName: p.displayName ?? p.subject,
        email: p.email ?? null,
        ...(client ? { clientName: str(client, "name") } : {}),
      },
      workspaces: rows.slice(0, limit).map((r) => ({
        id: str(r, "workspace_id"),
        name: str(r, "name"),
        version: num(r, "version"),
        role: role(r.role),
      })),
      nextCursor: rows.length > limit ? str(rows[limit - 1], "workspace_id") : null,
    };
  }
  const api: AccessApi = {
    ...oauth.api,
    async authenticate(input) {
      if (typeof input !== "object" || input === null || Array.isArray(input)) deny();
      let p: Identity;
      if (input.kind === "human") {
        const human = await verify(input.assertion);
        p = { id: await humanId(human.issuer, human.subject), kind: "human", ...human };
      } else if (input.kind === "oauth") {
        p = await oauth.authenticate(input.bearer, input.resource);
        await admit(p, p.workspaceId ?? "", "authenticate", "read");
      } else {
        if (
          input.kind !== "machine" ||
          typeof input.bearer !== "string" ||
          input.bearer.length > 1024
        )
          deny();
        const parts = input.bearer.split(".");
        if (
          parts.length !== 4 ||
          parts[0] !== "pt1" ||
          !/^[a-zA-Z0-9_-]{1,128}$/.test(parts[1]) ||
          !/^[a-zA-Z0-9_-]{1,128}$/.test(parts[2]) ||
          !/^[0-9a-f]{64}$/.test(parts[3])
        )
          deny();
        const [, w, credentialId, secret] = parts;
        const c = await one("credential", [w, credentialId]);
        const tokenHash = await hash(secret);
        if (
          !c ||
          c.token_hash !== tokenHash ||
          c.revoked !== 0 ||
          num(c, "expires_at") <= clock.now()
        )
          deny();
        const principal = await one("principal", [str(c, "principal_id")]);
        if (principal?.kind !== "machine" || principal.issuer !== `machine:${w}`) deny();
        p = {
          id: str(principal, "id"),
          kind: "machine",
          issuer: str(principal, "issuer"),
          subject: str(principal, "subject"),
          workspaceId: w,
          credentialId,
          tokenHash,
          expiresAt: num(c, "expires_at"),
        };
        await admit(p, w, "authenticate", "read");
      }
      const handle = Object.freeze({}) as AuthenticatedPrincipal;
      principals.set(handle, p);
      return handle;
    },
    async requireMembership(principal, w, requestId, mode = "read") {
      return admit(identity(principal), w, requestId, mode);
    },
    authorize,
    async getWorkspace(scope) {
      const s = await authorize(scope);
      const row = await one("workspace", [s.workspaceId]);
      if (!row || row.archived !== 0) deny();
      return {
        id: str(row, "workspace_id"),
        name: str(row, "name"),
        version: num(row, "version"),
        role: s.role,
      };
    },
    async listWorkspaces(principal) {
      const p = identity(principal);
      await live(p);
      const rows = (
        await store.run("listWorkspaces", [p.id, p.workspaceId ?? null, p.workspaceId ?? null])
      ).rows;
      return rows.map((r) => ({
        id: str(r, "workspace_id"),
        name: str(r, "name"),
        version: num(r, "version"),
        role: role(r.role),
      }));
    },
    async me(principal, cursor, limit) {
      return current(identity(principal), cursor, limit);
    },
    async meForScope(scope, cursor, limit) {
      const state = scopes.get(scope);
      if (!state) deny();
      await authorize(scope);
      return current(state.identity, cursor, limit);
    },
    async listMembers(scope, cursor = "", limit = 50) {
      const s = await authorize(scope);
      if (cursor) identifier(cursor);
      valid(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100);
      const rows = (await store.run("listMembers", [s.workspaceId, cursor, limit + 1])).rows;
      const items = rows.slice(0, limit).map((r) => ({
        principalId: str(r, "principal_id"),
        kind: r.kind === "machine" ? ("machine" as const) : ("human" as const),
        displayName: r.display_name === null ? str(r, "subject") : str(r, "display_name"),
        email: r.email === null ? null : str(r, "email"),
        role: role(r.role),
        version: num(r, "version"),
      }));
      return {
        items,
        nextCursor: rows.length > limit ? items[items.length - 1].principalId : null,
      };
    },
    async getPrincipalSummary(scope, id) {
      const s = await authorize(scope);
      const m = await one("membership", [s.workspaceId, textValue(id)]);
      const p = m?.active === 1 ? await one("principal", [id]) : undefined;
      if (!p) throw new PlatformError("not_found", "Principal not found");
      const kind = p.kind;
      if (kind !== "human" && kind !== "machine") deny();
      return { id: str(p, "id"), kind, issuer: str(p, "issuer"), subject: str(p, "subject") };
    },
    async getMembership(scope, id) {
      const s = await authorize(scope);
      const m = await one("membership", [s.workspaceId, textValue(id)]);
      if (!m) throw new PlatformError("not_found", "Membership not found");
      return { id, version: num(m, "version"), role: role(m.role), active: m.active === 1 };
    },
    async getCredential(scope, id) {
      const s = await manager(scope);
      const c = await one("credential", [s.workspaceId, identifier(id)]);
      if (!c) throw new PlatformError("not_found", "Credential not found");
      return {
        id,
        version: num(c, "version"),
        principalId: str(c, "principal_id"),
        scope: permission(c.scope),
        expiresAt: num(c, "expires_at"),
        revoked: c.revoked === 1,
      };
    },
    async listCredentials(scope, cursor = "", limit = 50) {
      const s = await authorize(scope);
      if (s.role !== "owner" && s.role !== "admin") deny();
      if (cursor) identifier(cursor);
      valid(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100);
      const rows = (await store.run("listCredentials", [s.workspaceId, cursor, limit + 1])).rows;
      const items = rows.slice(0, limit).map((r) => ({
        id: str(r, "id"),
        name: str(r, "name"),
        principalId: str(r, "principal_id"),
        scope: permission(r.scope),
        expiresAt: num(r, "expires_at"),
        createdAt: num(r, "created_at"),
        revoked: r.revoked === 1,
        version: num(r, "version"),
      }));
      return { items, nextCursor: rows.length > limit ? items[items.length - 1].id : null };
    },
    async bootstrap(cap, principal, input) {
      if (!operator || cap !== operator) deny();
      return workspace(principal, input, true);
    },
    createWorkspace(principal, input) {
      return workspace(principal, input, false);
    },
    async inviteMember(scope, input) {
      const s = await manager(scope);
      inputObject(input);
      valid(input.issuer === teamDomain);
      textValue(input.subject);
      role(input.role);
      version(input.expectedVersion);
      const id = await humanId(input.issuer, input.subject);
      const fp = await fingerprint("inviteMember", input.operationId, [
        input.issuer,
        input.subject,
        input.role,
        input.expectedVersion,
      ]);
      const saved = await replay(s.workspaceId, s.principalId, input.operationId, fp);
      if (saved) return saved;
      manage(s.role, undefined, input.role);
      const member: PrincipalSummary = {
        id,
        kind: "human",
        issuer: input.issuer,
        subject: input.subject,
      };
      const change: Statement =
        input.expectedVersion === 0
          ? { name: "addMember", values: [s.workspaceId, id, input.role, 0] }
          : {
              name: "restoreMember",
              values: [input.role, s.workspaceId, id, input.expectedVersion],
            };
      return commit(
        s.workspaceId,
        s.principalId,
        input.operationId,
        fp,
        { id, version: input.expectedVersion + 1 },
        "MembershipChanged",
        [putPrincipal(member), change],
      );
    },
    async changeRole(scope, input) {
      const s = await manager(scope);
      inputObject(input);
      role(input.role);
      version(input.expectedVersion);
      textValue(input.principalId);
      const fp = await fingerprint("changeRole", input.operationId, [
        input.principalId,
        input.role,
        input.expectedVersion,
      ]);
      const saved = await replay(s.workspaceId, s.principalId, input.operationId, fp);
      if (saved) return saved;
      const m = await one("membership", [s.workspaceId, input.principalId]);
      if (!m) throw new PlatformError("not_found", "Membership not found");
      manage(s.role, role(m.role), input.role);
      const p = await one("principal", [input.principalId]);
      if (p?.kind === "machine" && (input.role === "owner" || input.role === "admin")) deny();
      return commit(
        s.workspaceId,
        s.principalId,
        input.operationId,
        fp,
        { id: input.principalId, version: input.expectedVersion + 1 },
        "MembershipChanged",
        [
          {
            name: "changeRole",
            values: [
              input.role,
              s.workspaceId,
              input.principalId,
              input.expectedVersion,
              input.role,
              s.workspaceId,
              s.role,
            ],
          },
        ],
      );
    },
    async removeMember(scope, input) {
      const s = await manager(scope);
      inputObject(input);
      version(input.expectedVersion);
      textValue(input.principalId);
      const fp = await fingerprint("removeMember", input.operationId, [
        input.principalId,
        input.expectedVersion,
      ]);
      const saved = await replay(s.workspaceId, s.principalId, input.operationId, fp);
      if (saved) return saved;
      const m = await one("membership", [s.workspaceId, input.principalId]);
      if (!m) throw new PlatformError("not_found", "Membership not found");
      manage(s.role, role(m.role), undefined);
      return commit(
        s.workspaceId,
        s.principalId,
        input.operationId,
        fp,
        { id: input.principalId, version: input.expectedVersion + 1 },
        "MembershipChanged",
        [
          {
            name: "removeMember",
            values: [
              s.workspaceId,
              input.principalId,
              input.expectedVersion,
              s.workspaceId,
              s.role,
            ],
          },
        ],
        [{ name: "revokeMemberCredentials", values: [s.workspaceId, input.principalId] }],
      );
    },
    async provisionMachine(scope, input) {
      const s = await manager(scope);
      inputObject(input);
      identifier(input.principalId);
      valid(input.role === "member" || input.role === "viewer");
      const id = `m_${await hash(JSON.stringify([s.workspaceId, input.principalId]))}`;
      const fp = await fingerprint("provisionMachine", input.operationId, [
        input.principalId,
        input.role,
      ]);
      const saved = await replay(s.workspaceId, s.principalId, input.operationId, fp);
      if (saved) return saved;
      return commit(
        s.workspaceId,
        s.principalId,
        input.operationId,
        fp,
        { id, version: 1 },
        "MachineProvisioned",
        [
          putPrincipal({
            id,
            kind: "machine",
            issuer: `machine:${s.workspaceId}`,
            subject: input.principalId,
          }),
          { name: "addMember", values: [s.workspaceId, id, input.role, 0] },
        ],
      );
    },
    async issueCredential(scope, input) {
      const s = await manager(scope);
      inputObject(input);
      identifier(input.credentialId);
      textValue(input.principalId);
      permission(input.scope);
      valid(typeof input.secret === "string" && /^[0-9a-f]{64}$/.test(input.secret));
      valid(Number.isSafeInteger(input.expiresAt));
      if (input.name !== undefined)
        valid(typeof input.name === "string" && input.name.length <= 120);
      const tokenHash = await hash(input.secret);
      const fp = await fingerprint("issueCredential", input.operationId, [
        input.principalId,
        input.credentialId,
        tokenHash,
        input.scope,
        input.expiresAt,
        input.name ?? "",
      ]);
      const saved = await replay(s.workspaceId, s.principalId, input.operationId, fp);
      if (saved) return saved;
      valid(input.expiresAt > clock.now());
      const p = await one("principal", [input.principalId]);
      const m = await one("membership", [s.workspaceId, input.principalId]);
      if (p?.kind !== "machine" || p.issuer !== `machine:${s.workspaceId}` || m?.active !== 1)
        throw new PlatformError("not_found", "Machine not found");
      return commit(
        s.workspaceId,
        s.principalId,
        input.operationId,
        fp,
        { id: input.credentialId, version: 1 },
        "CredentialIssued",
        [
          {
            name: "issueCredential",
            values: [
              s.workspaceId,
              input.credentialId,
              input.principalId,
              tokenHash,
              input.scope,
              input.expiresAt,
              input.name ?? "",
              clock.now(),
            ],
          },
        ],
      );
    },
    async revokeCredential(scope, input) {
      const s = await manager(scope);
      inputObject(input);
      identifier(input.credentialId);
      version(input.expectedVersion);
      const fp = await fingerprint("revokeCredential", input.operationId, [
        input.credentialId,
        input.expectedVersion,
      ]);
      const saved = await replay(s.workspaceId, s.principalId, input.operationId, fp);
      if (saved) return saved;
      if (!(await one("credential", [s.workspaceId, input.credentialId])))
        throw new PlatformError("not_found", "Credential not found");
      return commit(
        s.workspaceId,
        s.principalId,
        input.operationId,
        fp,
        { id: input.credentialId, version: input.expectedVersion + 1 },
        "CredentialRevoked",
        [
          {
            name: "revokeCredential",
            values: [s.workspaceId, input.credentialId, input.expectedVersion],
          },
        ],
      );
    },
    async archiveWorkspace(scope, input) {
      const s = await manager(scope);
      inputObject(input);
      if (s.role !== "owner") deny();
      version(input.expectedVersion);
      const fp = await fingerprint("archiveWorkspace", input.operationId, [input.expectedVersion]);
      const saved = await replay(s.workspaceId, s.principalId, input.operationId, fp);
      if (saved) return saved;
      return commit(
        s.workspaceId,
        s.principalId,
        input.operationId,
        fp,
        { id: s.workspaceId, version: input.expectedVersion + 1 },
        "WorkspaceArchived",
        [{ name: "archiveWorkspace", values: [s.workspaceId, input.expectedVersion] }],
      );
    },
    async readOperation(scope, op) {
      const s = await authorize(scope);
      identifier(op);
      const r = await receipt(s.workspaceId, s.principalId, op);
      return r ? result(r) : null;
    },
    async readEvents(cap, w, cursor, limit) {
      if (!eventReader || cap !== eventReader) deny();
      identifier(w);
      version(cursor);
      valid(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100);
      const rows = (await store.run("events", [w, cursor, limit])).rows;
      return rows.map((r) => ({
        eventId: str(r, "event_id"),
        source: "access",
        schemaVersion: 1,
        workspaceId: w,
        aggregateId: str(r, "aggregate_id"),
        aggregateVersion: num(r, "aggregate_version"),
        type: str(r, "type") as AccessEvent["type"],
        occurredAt: num(r, "occurred_at"),
        payload: { actorId: str(r, "actor_id") },
        cursor: num(r, "sequence"),
      }));
    },
  };
  return {
    api: Object.freeze(api),
    maintenance: createMaintenance(store),
    operator,
    eventReader,
    background: Object.freeze({
      async listActiveWorkspaceIds(cursor = "", limit = 100) {
        if (cursor !== "") identifier(cursor);
        valid(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100);
        const rows = (await store.run("activeWorkspaceIds", [cursor, limit + 1])).rows;
        const workspaceIds = rows.slice(0, limit).map((r) => str(r, "workspace_id"));
        return {
          workspaceIds,
          nextCursor: rows.length > limit ? workspaceIds[workspaceIds.length - 1] : null,
        };
      },
    }),
  };
}
