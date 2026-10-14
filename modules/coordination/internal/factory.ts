import {
  type Call,
  type Clock,
  type IdGenerator,
  type ModuleStore,
  PlatformError,
  type Row,
} from "../../../platform/public";
import type { AccessApi, RequestScope } from "../../access/public";
import type { IssuesApi } from "../../issues/public";
import type { ProjectsApi } from "../../projects/public";
import type {
  CoordinationApi,
  CoordinationEvent,
  CoordinationEventReader,
  CoordinationMaintenance,
  FileClaim,
  Lease,
  Progress,
  Session,
} from "../public";
import type { queries } from "../storage/queries";
import { createMaintenance } from "./maintenance";

type Name = keyof typeof queries;
type Statement = Call<Name>;
interface Dependencies {
  readonly store: ModuleStore<"coordination", Name>;
  readonly access: Pick<AccessApi, "authorize">;
  readonly issues: Pick<IssuesApi, "authorizeIssue">;
  readonly projects: Pick<ProjectsApi, "authorizeProject">;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly eventConsumer?: string;
}
function fail(
  code: "validation" | "not_found" | "forbidden" | "conflict" | "unknown",
  message: string,
): never {
  throw new PlatformError(code, message);
}
const id = (v: unknown): string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v) ? v : fail("validation", "Invalid ID");
const label = (v: unknown, max = 256): string =>
  typeof v === "string" && v.trim().length > 0 && v.length <= max
    ? v.trim()
    : fail("validation", "Invalid text");
const repo = (v: unknown): string =>
  typeof v === "string" && v.length <= 512 && /^[A-Za-z0-9._/:@-]+$/.test(v)
    ? v
    : fail("validation", "Invalid repo");
const path = (v: unknown): string =>
  typeof v === "string" &&
  v.length <= 1024 &&
  v.length > 0 &&
  !v.startsWith("/") &&
  !v.includes("\\") &&
  !v.split("/").some((x) => x === ".." || x === "." || x === "")
    ? v
    : fail("validation", "Invalid path");
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max
    ? v
    : fail("validation", "Invalid number");
const field = (r: Row, k: string): string =>
  typeof r[k] === "string" ? r[k] : fail("unknown", `Invalid ${k}`);
const num = (r: Row, k: string): number =>
  typeof r[k] === "number" ? r[k] : fail("unknown", `Invalid ${k}`);
const nullable = (r: Row, k: string): string | null => (r[k] === null ? null : field(r, k));
const digest = async (v: unknown): Promise<string> =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(v))),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
export function createCoordination(d: Dependencies): {
  api: CoordinationApi;
  maintenance: CoordinationMaintenance;
  eventReader?: CoordinationEventReader;
} {
  if (d.store.owner !== "coordination") fail("forbidden", "Wrong Coordination store");
  const { store, access, issues, projects, clock, ids } = d;
  const reader = d.eventConsumer ? (Object.freeze({}) as CoordinationEventReader) : undefined;
  const one = async (
    name: Name,
    values: readonly (string | number | null)[],
  ): Promise<Row | undefined> => (await store.run(name, values)).rows[0];
  const pageLimit = (limit = 50) => integer(limit, 1, 100);
  const w = (s: RequestScope) => id(s.workspaceId),
    actor = (s: RequestScope) => id(s.principalId);
  const sessionRow = (r: Row, now = clock.now()): Session => ({
    id: field(r, "id"),
    agentLabel: field(r, "agent_label"),
    clientKind: field(r, "client_kind"),
    repo: nullable(r, "repo"),
    principalId: field(r, "principal_id"),
    expiresAt: num(r, "expires_at"),
    live: r.ended === 0 && num(r, "expires_at") > now,
  });
  const leaseRow = (r: Row): Lease => ({
    issueId: field(r, "issue_id"),
    projectId: field(r, "project_id"),
    sessionId: nullable(r, "session_id"),
    fencingToken: num(r, "fencing_token"),
    expiresAt: num(r, "expires_at"),
    releaseReason: nullable(r, "release_reason"),
  });
  const claimRow = (r: Row): FileClaim => ({
    repo: field(r, "repo"),
    path: field(r, "path"),
    sessionId: field(r, "session_id"),
    leaseIssueId: nullable(r, "lease_issue_id"),
    expiresAt: num(r, "expires_at"),
  });
  const reportRow = (r: Row): Progress => ({
    issueId: field(r, "issue_id"),
    sessionId: field(r, "session_id"),
    fencingToken: num(r, "fencing_token"),
    text: field(r, "text"),
    status: field(r, "status"),
    reportedAt: num(r, "reported_at"),
  });
  async function authorized(scope: RequestScope, write = false): Promise<void> {
    await access.authorize(scope, write ? "write" : "read");
  }
  async function active(
    scope: RequestScope,
    sessionId: string,
  ): Promise<{ ttl: number; expires: number }> {
    await authorized(scope, true);
    const r = await one("session", [w(scope), id(sessionId)]);
    if (
      !r ||
      r.principal_id !== actor(scope) ||
      r.ended !== 0 ||
      num(r, "expires_at") <= clock.now()
    )
      fail("conflict", "Session expired or not owned");
    const now = clock.now(),
      ttl = num(r, "ttl_seconds");
    // Every admitted session call extends liveness, including a contention response.
    const guardId = ids.next();
    try {
      await store.batch([
        { name: "touch", values: [now + ttl, w(scope), sessionId, actor(scope), now] },
        { name: "guard", values: [w(scope), guardId] },
        { name: "touchClaims", values: [now + ttl, w(scope), sessionId, now] },
        { name: "clearGuard", values: [w(scope), guardId] },
      ]);
    } catch {
      fail("conflict", "Session expired or scope frozen");
    }
    return { ttl, expires: now + ttl };
  }
  async function issue(
    scope: RequestScope,
    issueId: string,
    permission: "read" | "write" = "read",
  ) {
    return issues.authorizeIssue(scope, id(issueId), permission);
  }
  async function replay(scope: RequestScope, op: string, fp: string): Promise<unknown | null> {
    const r = await one("readReceipt", [w(scope), actor(scope), id(op)]);
    if (!r) return null;
    if (r.fingerprint !== fp) fail("conflict", "Operation ID reused");
    return JSON.parse(field(r, "result_json"));
  }
  function guarded(scope: RequestScope, call: Statement): Statement[] {
    const guardId = ids.next();
    return [
      call,
      { name: "guard", values: [w(scope), guardId] },
      { name: "clearGuard", values: [w(scope), guardId] },
    ];
  }
  async function commit<T>(
    scope: RequestScope,
    op: string,
    fp: string,
    result: T,
    calls: readonly Statement[],
    events: readonly {
      type: CoordinationEvent["type"];
      subject: string;
      other?: string | null;
      issueId?: string | null;
      projectId?: string | null;
    }[] = [],
  ): Promise<T> {
    const at = clock.now();
    try {
      await store.batch([
        ...calls,
        { name: "receipt", values: [w(scope), actor(scope), op, fp, JSON.stringify(result)] },
        ...events.map((e) => ({
          name: "event" as const,
          values: [
            w(scope),
            w(scope),
            ids.next(),
            e.type,
            e.subject,
            actor(scope),
            e.other ?? null,
            at,
            scope.clientId ?? null,
            e.issueId ?? null,
            e.projectId ?? null,
            w(scope),
            e.issueId ?? e.subject,
          ],
        })),
      ]);
    } catch (error) {
      const saved = await replay(scope, op, fp);
      if (saved !== null) return saved as T;
      if (error instanceof Error && /scope frozen/i.test(error.message))
        fail("conflict", "Scope frozen");
      if (
        error instanceof Error &&
        /(?:CHECK|UNIQUE|FOREIGN KEY) constraint failed/i.test(error.message)
      )
        fail("conflict", "Coordination contention or stale version");
      fail("unknown", "Operation outcome unknown; retry same operation ID");
    }
    return result;
  }
  async function fp(kind: string, op: string, values: unknown[]): Promise<string> {
    id(op);
    return digest([kind, ...values]);
  }
  async function fenced(
    scope: RequestScope,
    sessionId: string,
    issueId: string,
    token: number,
  ): Promise<Lease> {
    const current = await one("lease", [w(scope), id(issueId)]);
    if (!current) fail("conflict", "Lease missing");
    const lease = leaseRow(current);
    if (
      lease.sessionId !== sessionId ||
      lease.fencingToken !== integer(token, 1) ||
      lease.expiresAt <= clock.now()
    )
      fail("conflict", "Stale fencing token");
    await issue(scope, issueId, "write");
    return lease;
  }
  const api: CoordinationApi = {
    async startSession(scope, input) {
      await authorized(scope, true);
      const sid = id(input.sessionId),
        name = label(input.agentLabel),
        kind = label(input.clientKind, 64),
        repository = input.repo === undefined ? null : repo(input.repo),
        ttl = integer(input.ttlSeconds ?? 120, 30, 3600);
      const fingerprint = await fp("start", input.operationId, [sid, name, kind, repository, ttl]);
      const saved = await replay(scope, input.operationId, fingerprint);
      if (saved) return saved as Session;
      const expiry = clock.now() + ttl;
      const result: Session = {
        id: sid,
        agentLabel: name,
        clientKind: kind,
        repo: repository,
        principalId: actor(scope),
        expiresAt: expiry,
        live: true,
      };
      return commit(scope, input.operationId, fingerprint, result, [
        {
          name: "start",
          values: [w(scope), sid, actor(scope), name, kind, repository, ttl, expiry],
        },
      ]);
    },
    async heartbeat(scope, input) {
      const sid = id(input.sessionId),
        { expires } = await active(scope, sid),
        fingerprint = await fp("heartbeat", input.operationId, [sid]);
      const saved = await replay(scope, input.operationId, fingerprint);
      if (saved) return saved as Session;
      const r = await one("session", [w(scope), sid]);
      if (!r) fail("unknown", "Session missing");
      return commit(
        scope,
        input.operationId,
        fingerprint,
        { ...sessionRow(r), expiresAt: expires, live: true },
        [],
      );
    },
    async endSession(scope, input) {
      const sid = id(input.sessionId);
      await authorized(scope, true);
      const fingerprint = await fp("end", input.operationId, [sid]);
      const saved = await replay(scope, input.operationId, fingerprint);
      if (saved) return saved as Session;
      await active(scope, sid);
      const r = await one("session", [w(scope), sid]);
      if (!r) fail("unknown", "Session missing");
      const now = clock.now(),
        result = { ...sessionRow(r), expiresAt: now, live: false };
      return commit(scope, input.operationId, fingerprint, result, [
        ...guarded(scope, { name: "end", values: [now, w(scope), sid, actor(scope), now] }),
        { name: "dropSessionClaims", values: [w(scope), sid] },
        { name: "releaseSessionLeases", values: [now, w(scope), sid] },
      ]);
    },
    async acquireLease(scope, input) {
      const sid = id(input.sessionId),
        { expires } = await active(scope, sid),
        iid = id(input.issueId),
        target = await issue(scope, iid, "write"),
        projectId = id(target.projectId);
      const fingerprint = await fp("acquire", input.operationId, [sid, iid]);
      const saved = await replay(scope, input.operationId, fingerprint);
      if (saved) return saved as Lease;
      const now = clock.now(),
        old = await one("lease", [w(scope), iid]);
      const previous = old ? leaseRow(old) : null;
      if (previous && previous.sessionId !== null && previous.expiresAt > now)
        fail("conflict", `Lease held by ${previous.sessionId}`);
      const result: Lease = {
        issueId: iid,
        projectId,
        sessionId: sid,
        fencingToken: (previous?.fencingToken ?? 0) + 1,
        expiresAt: expires,
        releaseReason: previous?.sessionId ? "expired" : (previous?.releaseReason ?? null),
      };
      const call: Statement = previous
        ? {
            name: "acquireCap",
            values: [
              sid,
              expires,
              w(scope),
              iid,
              now,
              w(scope),
              projectId,
              now,
              w(scope),
              projectId,
            ],
          }
        : {
            name: "acquire",
            values: [
              w(scope),
              iid,
              projectId,
              sid,
              expires,
              w(scope),
              projectId,
              now,
              w(scope),
              projectId,
            ],
          };
      return commit(scope, input.operationId, fingerprint, result, guarded(scope, call), [
        { type: "LeaseChanged", subject: iid, other: previous?.sessionId },
      ]);
    },
    async renewLease(scope, input) {
      const sid = id(input.sessionId),
        iid = id(input.issueId),
        token = integer(input.fencingToken, 1);
      await issue(scope, iid, "write");
      const fingerprint = await fp("renew", input.operationId, [sid, iid, token]);
      const saved = await replay(scope, input.operationId, fingerprint);
      if (saved) return saved as Lease;
      const { expires } = await active(scope, sid);
      await fenced(scope, sid, iid, token);
      const old = await one("lease", [w(scope), iid]);
      if (!old) fail("conflict", "Lease missing");
      return commit(
        scope,
        input.operationId,
        fingerprint,
        { ...leaseRow(old), expiresAt: expires },
        guarded(scope, {
          name: "renew",
          values: [expires, w(scope), iid, sid, token, clock.now()],
        }),
      );
    },
    async releaseLease(scope, input) {
      const sid = id(input.sessionId),
        iid = id(input.issueId),
        token = integer(input.fencingToken, 1);
      await issue(scope, iid, "write");
      const fingerprint = await fp("release", input.operationId, [sid, iid, token]);
      const saved = await replay(scope, input.operationId, fingerprint);
      if (saved) return saved as Lease;
      await active(scope, sid);
      const old = await fenced(scope, sid, iid, token);
      const now = clock.now();
      return commit(
        scope,
        input.operationId,
        fingerprint,
        { ...old, sessionId: null, expiresAt: now, releaseReason: "released" },
        guarded(scope, { name: "release", values: [now, w(scope), iid, sid, token, now] }),
        [{ type: "LeaseChanged", subject: iid }],
      );
    },
    async setProjectLimit(scope, input) {
      const pid = id(input.projectId),
        cap = integer(input.cap, 1, 100),
        version = integer(input.expectedVersion);
      const current = await access.authorize(scope, "write");
      if (current.clientId || (current.role !== "owner" && current.role !== "admin"))
        fail("forbidden", "Workspace admin required");
      await projects.authorizeProject(scope, pid, "manage");
      const fingerprint = await fp("limit", input.operationId, [pid, cap, version]);
      const saved = await replay(scope, input.operationId, fingerprint);
      if (saved) return saved as { projectId: string; cap: number; version: number };
      const result = { projectId: pid, cap, version: version + 1 };
      return commit(
        scope,
        input.operationId,
        fingerprint,
        result,
        guarded(scope, {
          name: "setLimit",
          values: [
            w(scope),
            pid,
            cap,
            version,
            w(scope),
            pid,
            clock.now(),
            cap,
            version,
            w(scope),
            pid,
            clock.now(),
            cap,
          ],
        }),
      );
    },
    async getProjectLimit(scope, projectId) {
      const pid = id(projectId);
      await projects.authorizeProject(scope, pid);
      const row = await one("limit", [w(scope), pid]);
      return {
        projectId: pid,
        cap: row ? num(row, "cap") : 3,
        version: row ? num(row, "version") : 0,
      };
    },
    async projectSessions(scope, projectId, cursor = "", limit = 50) {
      const pid = id(projectId);
      await projects.authorizeProject(scope, pid);
      if (cursor) id(cursor);
      const size = pageLimit(limit);
      const now = clock.now();
      const rows = (await store.run("projectSessions", [w(scope), cursor, now, pid, now, size + 1]))
        .rows;
      const items = rows.slice(0, size).map((r) => sessionRow(r, now));
      return { items, nextCursor: rows.length > size ? items[items.length - 1].id : null };
    },
    async projectLeases(scope, projectId, cursor = "", limit = 50) {
      const pid = id(projectId);
      await projects.authorizeProject(scope, pid);
      if (cursor) id(cursor);
      const size = pageLimit(limit);
      const now = clock.now();
      const rows = (await store.run("projectLeases", [w(scope), pid, cursor, now, now, size + 1]))
        .rows;
      const items = rows.slice(0, size).map((r) => ({
        ...leaseRow(r),
        holderPrincipalId: field(r, "principal_id"),
        agentLabel: field(r, "agent_label"),
        clientKind: field(r, "client_kind"),
      }));
      return { items, nextCursor: rows.length > size ? items[items.length - 1].issueId : null };
    },
    async projectProgress(scope, projectId, cursor = "", limit = 50) {
      const pid = id(projectId);
      await projects.authorizeProject(scope, pid);
      const size = pageLimit(limit);
      let time = Number.MAX_SAFE_INTEGER;
      let issueId = "~";
      if (cursor) {
        const match = cursor.match(/^(\d+):([A-Za-z0-9_-]{1,128})$/);
        if (!match) fail("validation", "Invalid cursor");
        time = integer(Number(match[1]));
        issueId = id(match[2]);
      }
      const rows = (
        await store.run("projectProgress", [w(scope), pid, time, time, issueId, size + 1])
      ).rows;
      const items = rows
        .slice(0, size)
        .map((r) => ({ ...reportRow(r), projectId: field(r, "project_id") }));
      const last = items[items.length - 1];
      return {
        items,
        nextCursor: rows.length > size ? `${last.reportedAt}:${last.issueId}` : null,
      };
    },
    async projectClaims(scope, projectId, cursor = "", limit = 50) {
      const pid = id(projectId);
      await projects.authorizeProject(scope, pid);
      const size = pageLimit(limit);
      const [afterRepo, afterPath, extra] = cursor ? cursor.split("\u001f") : ["", "", undefined];
      if (extra !== undefined || (cursor && (!afterRepo || !afterPath)))
        fail("validation", "Invalid cursor");
      if (afterRepo) repo(afterRepo);
      if (afterPath) path(afterPath);
      const now = clock.now();
      const rows = (
        await store.run("projectClaims", [
          w(scope),
          pid,
          now,
          now,
          afterRepo,
          afterRepo,
          afterPath,
          size + 1,
        ])
      ).rows;
      const items = rows.slice(0, size).map(claimRow);
      const last = items[items.length - 1];
      return { items, nextCursor: rows.length > size ? `${last.repo}\u001f${last.path}` : null };
    },
    async claimFiles(scope, input) {
      const sid = id(input.sessionId),
        { expires } = await active(scope, sid),
        repository = repo(input.repo),
        paths = input.paths;
      if (!Array.isArray(paths) || paths.length < 1 || paths.length > 20)
        fail("validation", "Invalid paths");
      const normalized = paths.map(path);
      if (new Set(normalized).size !== normalized.length) fail("validation", "Duplicate path");
      const linked = input.leaseIssueId === undefined ? null : id(input.leaseIssueId);
      if (linked) await fenced(scope, sid, linked, integer(input.fencingToken, 1));
      else if (input.fencingToken !== undefined) fail("validation", "Unexpected fencing token");
      const forced = input.force === true;
      if (input.force !== undefined && typeof input.force !== "boolean")
        fail("validation", "Invalid force");
      let forcedProject: string | null = null;
      if (forced) {
        if (!linked) fail("validation", "Force requires lease");
        const lease = await fenced(scope, sid, linked, input.fencingToken ?? 0);
        await projects.authorizeProject(scope, lease.projectId, "manage");
        forcedProject = lease.projectId;
      }
      const fingerprint = await fp("claim", input.operationId, [
        sid,
        repository,
        normalized,
        linked,
        input.fencingToken ?? null,
        forced,
      ]);
      const saved = await replay(scope, input.operationId, fingerprint);
      if (saved) return saved as FileClaim[];
      const previous = await Promise.all(
        normalized.map((p) => one("claim", [w(scope), repository, p])),
      );
      const contention = previous.flatMap((r, i) =>
        r && r.session_id !== sid && num(r, "expires_at") > clock.now()
          ? [{ path: normalized[i], holder: field(r, "session_id") }]
          : [],
      );
      if (contention.length && !forced)
        fail("conflict", `Files held: ${JSON.stringify(contention)}`);
      const calls: Statement[] = normalized.flatMap((p, index) =>
        guarded(scope, {
          name: "putClaim",
          values: [
            w(scope),
            repository,
            p,
            sid,
            linked,
            expires,
            w(scope),
            linked,
            linked,
            w(scope),
            linked,
            sid,
            input.fencingToken ?? null,
            clock.now(),
            clock.now(),
            sid,
            forced ? 1 : 0,
            previous[index] ? field(previous[index], "session_id") : null,
          ],
        }),
      );
      const result = normalized.map((p) => ({
        repo: repository,
        path: p,
        sessionId: sid,
        leaseIssueId: linked,
        expiresAt: expires,
      }));
      return commit(
        scope,
        input.operationId,
        fingerprint,
        result,
        calls,
        contention.map((c) => ({
          type: "FileClaimForced",
          subject: `${repository}/${c.path}`,
          issueId: linked,
          projectId: forcedProject,
          other: c.holder,
        })),
      );
    },
    async releaseFiles(scope, input) {
      const sid = id(input.sessionId);
      await active(scope, sid);
      const repository = repo(input.repo),
        paths = input.paths;
      if (!Array.isArray(paths) || paths.length < 1 || paths.length > 20)
        fail("validation", "Invalid paths");
      const normalized = paths.map(path);
      if (new Set(normalized).size !== normalized.length) fail("validation", "Duplicate path");
      const fingerprint = await fp("releaseFiles", input.operationId, [
        sid,
        repository,
        normalized,
      ]);
      const saved = await replay(scope, input.operationId, fingerprint);
      if (saved) return saved as string[];
      return commit(
        scope,
        input.operationId,
        fingerprint,
        normalized,
        normalized.flatMap((p) =>
          guarded(scope, { name: "dropClaim", values: [w(scope), repository, p, sid] }),
        ),
      );
    },
    async reportProgress(scope, input) {
      const sid = id(input.sessionId),
        iid = id(input.issueId),
        token = integer(input.fencingToken, 1);
      await issue(scope, iid, "write");
      const content = label(input.text, 4000),
        status = label(input.status, 64),
        fingerprint = await fp("progress", input.operationId, [sid, iid, token, content, status]);
      const saved = await replay(scope, input.operationId, fingerprint);
      if (saved) return saved as Progress;
      await active(scope, sid);
      await fenced(scope, sid, iid, token);
      const result: Progress = {
        issueId: iid,
        sessionId: sid,
        fencingToken: token,
        text: content,
        status,
        reportedAt: clock.now(),
      };
      return commit(
        scope,
        input.operationId,
        fingerprint,
        result,
        [
          ...guarded(scope, {
            name: "report",
            values: [
              w(scope),
              iid,
              sid,
              token,
              content,
              status,
              result.reportedAt,
              w(scope),
              iid,
              w(scope),
              iid,
              sid,
              token,
              result.reportedAt,
            ],
          }),
          { name: "appendReport", values: [w(scope), iid, w(scope), iid] },
          { name: "trimReports", values: [w(scope), iid, w(scope), iid] },
        ],
        [{ type: "ProgressReported", subject: iid }],
      );
    },
    async getLease(scope, issueId) {
      await issue(scope, issueId);
      const r = await one("lease", [w(scope), id(issueId)]);
      return r ? leaseRow(r) : null;
    },
    async listLeases(scope, projectId) {
      const pid = id(projectId);
      await projects.authorizeProject(scope, pid);
      return (await store.run("leases", [w(scope), pid])).rows.map(leaseRow);
    },
    async listClaims(scope, repository, sessionId) {
      await active(scope, id(sessionId));
      return (await store.run("claims", [w(scope), repo(repository)])).rows.map(claimRow);
    },
    async getProgress(scope, issueId) {
      await issue(scope, issueId);
      const r = await one("progress", [w(scope), id(issueId)]);
      return r ? reportRow(r) : null;
    },
    async listProgress(scope, issueId, input = {}) {
      await issue(scope, issueId);
      const cursor =
        input.cursor === undefined ? Number.MAX_SAFE_INTEGER : integer(input.cursor, 1);
      const limit = input.limit === undefined ? 50 : integer(input.limit, 1, 100);
      const rows = (await store.run("progressHistory", [w(scope), id(issueId), cursor, limit + 1]))
        .rows;
      const items = rows
        .slice(0, limit)
        .map((r) => ({ ...reportRow(r), sequence: num(r, "sequence") }));
      return { items, nextCursor: rows.length > limit ? items[items.length - 1].sequence : null };
    },
    async listSessions(scope) {
      const live = await access.authorize(scope);
      return (await store.run("sessions", [w(scope)])).rows
        .filter(
          (r) => r.principal_id === actor(scope) || live.role === "owner" || live.role === "admin",
        )
        .map((r) => sessionRow(r));
    },
    async readOperation(scope, operationId) {
      await authorized(scope);
      const r = await one("readReceipt", [w(scope), actor(scope), id(operationId)]);
      if (!r) return null;
      const result: unknown = JSON.parse(field(r, "result_json"));
      if (result && typeof result === "object" && !Array.isArray(result)) {
        if ("issueId" in result && typeof result.issueId === "string")
          await issue(scope, result.issueId);
        else if ("projectId" in result && typeof result.projectId === "string")
          await projects.authorizeProject(scope, result.projectId);
      }
      return result;
    },
    async readAgentEvents(scope, cursor, limit) {
      await authorized(scope);
      const workspaceId = w(scope);
      const rows = (
        await store.run("agentEvents", [
          workspaceId,
          integer(cursor),
          actor(scope),
          workspaceId,
          actor(scope),
          integer(limit, 1, 100),
        ])
      ).rows;
      return rows.map((r) => ({
        eventId: field(r, "event_id"),
        source: "coordination" as const,
        schemaVersion: num(r, "schema_version") as 1 | 2,
        workspaceId,
        type: field(r, "type") as CoordinationEvent["type"],
        subjectId: field(r, "subject_id"),
        actorId: field(r, "actor_id"),
        payload: {
          actorId: field(r, "actor_id"),
          clientId: r.client_id === null ? null : field(r, "client_id"),
        },
        issueId: nullable(r, "issue_id"),
        projectId: nullable(r, "project_id"),
        otherSessionId: nullable(r, "other_session_id"),
        occurredAt: num(r, "occurred_at"),
        cursor: num(r, "sequence"),
      }));
    },
    async readEvents(cap, workspaceId, cursor, limit) {
      if (!reader || cap !== reader) fail("forbidden", "Event reader required");
      const wId = id(workspaceId);
      const rows = (await store.run("events", [wId, integer(cursor), integer(limit, 1, 100)])).rows;
      return rows.map((r) => ({
        eventId: field(r, "event_id"),
        source: "coordination" as const,
        schemaVersion: num(r, "schema_version") as 1 | 2,
        workspaceId: wId,
        type: field(r, "type") as CoordinationEvent["type"],
        subjectId: field(r, "subject_id"),
        actorId: field(r, "actor_id"),
        payload: {
          actorId: field(r, "actor_id"),
          clientId: r.client_id === null ? null : field(r, "client_id"),
        },
        issueId: nullable(r, "issue_id"),
        projectId: nullable(r, "project_id"),
        otherSessionId: nullable(r, "other_session_id"),
        occurredAt: num(r, "occurred_at"),
        cursor: num(r, "sequence"),
      }));
    },
  };
  return { api: Object.freeze(api), eventReader: reader, maintenance: createMaintenance(store) };
}
