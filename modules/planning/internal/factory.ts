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
  PlanningApi,
  PlanningEvent,
  PlanningEventReader,
  PlanningMaintenance,
  PlanningMaintenanceScope,
  PlanningPurgeStatus,
  PlanningResult,
  Sprint,
} from "../public";
import type { queries } from "../storage/queries";

type Name = keyof typeof queries;
type Statement = Call<Name>;
interface Dependencies {
  readonly store: ModuleStore<"planning", Name>;
  readonly access: Pick<AccessApi, "authorize">;
  readonly issues: Pick<IssuesApi, "authorizeIssue" | "getIssueIncludingArchived">;
  readonly projects: Pick<ProjectsApi, "authorizeProject" | "getProjectIncludingArchived">;
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
function id(v: unknown): string {
  return typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v)
    ? v
    : fail("validation", "Invalid ID");
}
function version(v: unknown): number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 1
    ? v
    : fail("validation", "Invalid version");
}
function str(r: Row, k: string): string {
  return typeof r[k] === "string" ? r[k] : fail("unknown", `Invalid ${k}`);
}
function num(r: Row, k: string): number {
  return typeof r[k] === "number" ? r[k] : fail("unknown", `Invalid ${k}`);
}
async function fingerprint(action: string, values: unknown[]): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([action, ...values])),
  );
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
export function createPlanning(d: Dependencies): {
  api: PlanningApi;
  eventReader?: PlanningEventReader;
  maintenance: PlanningMaintenance;
} {
  if (d.store.owner !== "planning") fail("forbidden", "Wrong Planning store");
  const { store, access, issues, projects, clock, ids } = d;
  const eventReader = d.eventConsumer ? (Object.freeze({}) as PlanningEventReader) : undefined;
  const one = async (name: Name, values: Statement["values"]) =>
    (await store.run(name, values)).rows[0];
  const ws = (s: RequestScope) => id(s.workspaceId),
    actor = (s: RequestScope) => id(s.principalId);
  const sprint = (r: Row): Sprint => ({
    id: str(r, "id"),
    projectId: str(r, "project_id"),
    name: str(r, "name"),
    version: num(r, "version"),
    closed: r.closed === 1,
    archived: false,
  });
  async function readSprint(s: RequestScope, sprintId: string, mode: "read" | "write" = "read") {
    const r = await one("sprint", [ws(s), id(sprintId)]);
    if (!r) fail("not_found", "Sprint not found");
    const project =
      mode === "read"
        ? await projects.getProjectIncludingArchived(s, str(r, "project_id"))
        : await projects.authorizeProject(s, str(r, "project_id"), mode);
    return { ...sprint(r), archived: project.archived };
  }
  async function replay(s: RequestScope, op: string, fp: string): Promise<PlanningResult | null> {
    const r = await one("readReceipt", [ws(s), actor(s), id(op)]);
    if (!r) return null;
    if (str(r, "fingerprint") !== fp) fail("conflict", "Operation ID reused");
    await readSprint(s, str(r, "result_id"));
    return { id: str(r, "result_id"), version: num(r, "result_version") };
  }
  function guarded(s: RequestScope, change: Statement): Statement[] {
    const g = ids.next();
    return [
      change,
      { name: "guard", values: [ws(s), g] },
      { name: "clearGuard", values: [ws(s), g] },
    ];
  }
  async function commit(
    s: RequestScope,
    op: string,
    fp: string,
    sprintId: string,
    next: number,
    action: string,
    issueId: string | null,
    change: Statement[],
  ): Promise<PlanningResult> {
    const at = clock.now();
    const type: PlanningEvent["type"] =
      action === "schedule" || action === "unschedule" ? "IssueScheduled" : "SprintChanged";
    try {
      await store.batch([
        ...change,
        { name: "history", values: [action, issueId, actor(s), at, ws(s), sprintId] },
        { name: "receipt", values: [ws(s), actor(s), op, fp, ws(s), sprintId] },
        {
          name: "event",
          values: [
            ws(s),
            ws(s),
            ids.next(),
            next,
            type,
            issueId,
            actor(s),
            at,
            s.clientId ?? null,
            ws(s),
            sprintId,
          ],
        },
      ]);
    } catch (e) {
      try {
        const saved = await replay(s, op, fp);
        if (saved) return saved;
      } catch (recovery) {
        if (recovery instanceof PlatformError) throw recovery;
        fail("unknown", "Outcome unknown; retry operation ID");
      }
      if (e instanceof Error && /(?:CHECK|UNIQUE|FOREIGN KEY) constraint failed/i.test(e.message))
        fail("conflict", "Version or invariant conflict");
      fail("unknown", "Outcome unknown; retry operation ID");
    }
    const saved = await replay(s, op, fp);
    if (!saved) fail("unknown", "Outcome unknown; retry operation ID");
    return saved;
  }
  const api: PlanningApi = {
    async createSprint(s, input) {
      const op = id(input.operationId),
        sid = id(input.sprintId),
        pid = id(input.projectId);
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (!name || name.length > 120) fail("validation", "Invalid sprint name");
      await access.authorize(s, "write");
      await projects.authorizeProject(s, pid, "write");
      const fp = await fingerprint("create", [sid, pid, name]);
      const saved = await replay(s, op, fp);
      if (saved) return saved;
      return commit(
        s,
        op,
        fp,
        sid,
        1,
        "create",
        null,
        guarded(s, { name: "create", values: [ws(s), sid, pid, name] }),
      );
    },
    async scheduleIssue(s, input) {
      const op = id(input.operationId),
        sid = id(input.sprintId),
        iid = id(input.issueId),
        expected = version(input.expectedVersion);
      await access.authorize(s, "write");
      const fp = await fingerprint("schedule", [sid, iid, expected]);
      const saved = await replay(s, op, fp);
      if (saved) return saved;
      const current = await readSprint(s, sid, "write");
      if (current.closed || current.version !== expected)
        fail("conflict", "Sprint version conflict");
      const issue = await issues.authorizeIssue(s, iid, "read");
      if (issue.projectId !== current.projectId || issue.archived)
        fail("not_found", "Issue not available in project");
      return commit(s, op, fp, sid, expected + 1, "schedule", iid, [
        ...guarded(s, { name: "bump", values: [ws(s), sid, expected] }),
        ...guarded(s, { name: "addItem", values: [ws(s), sid, iid] }),
      ]);
    },
    async unscheduleIssue(s, input) {
      const op = id(input.operationId),
        sid = id(input.sprintId),
        iid = id(input.issueId),
        expected = version(input.expectedVersion);
      await access.authorize(s, "write");
      const fp = await fingerprint("unschedule", [sid, iid, expected]);
      const saved = await replay(s, op, fp);
      if (saved) return saved;
      const current = await readSprint(s, sid, "write");
      if (current.closed || current.version !== expected)
        fail("conflict", "Sprint version conflict");
      const issue = await issues.getIssueIncludingArchived(s, iid);
      if (issue.archived || current.archived) fail("not_found", "Archived item is read-only");
      return commit(s, op, fp, sid, expected + 1, "unschedule", iid, [
        ...guarded(s, { name: "removeItem", values: [ws(s), sid, iid] }),
        ...guarded(s, { name: "bump", values: [ws(s), sid, expected] }),
      ]);
    },
    async closeSprint(s, input) {
      const op = id(input.operationId),
        sid = id(input.sprintId),
        expected = version(input.expectedVersion);
      await access.authorize(s, "write");
      const fp = await fingerprint("close", [sid, expected]);
      const saved = await replay(s, op, fp);
      if (saved) return saved;
      const current = await readSprint(s, sid, "write");
      if (current.closed || current.version !== expected)
        fail("conflict", "Sprint version conflict");
      return commit(s, op, fp, sid, expected + 1, "close", null, [
        ...guarded(s, { name: "close", values: [ws(s), sid, expected] }),
        { name: "closeItems", values: [ws(s), sid] },
      ]);
    },
    async listSprints(s, projectId) {
      await access.authorize(s, "read");
      const project = await projects.getProjectIncludingArchived(s, id(projectId));
      return (await store.run("list", [ws(s), projectId])).rows.map((r) => ({
        ...sprint(r),
        archived: project.archived,
      }));
    },
    async getSprintItems(s, sprintId, page = {}) {
      const limit = page.limit === undefined ? 50 : page.limit;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        fail("validation", "Invalid page size");
      const cursor = page.cursor === undefined ? "" : id(page.cursor);
      await access.authorize(s, "read");
      const current = await readSprint(s, sprintId);
      const rows = (await store.run("items", [ws(s), current.id, cursor, limit + 1])).rows;
      const items = await Promise.all(
        rows.slice(0, limit).map(async (r) => {
          const issueId = str(r, "issue_id");
          try {
            const issue = await issues.getIssueIncludingArchived(s, issueId);
            return { issueId, issue, archived: issue.archived || current.archived };
          } catch (e) {
            if (e instanceof PlatformError && e.code === "not_found")
              return { issueId, issue: null, archived: true };
            throw e;
          }
        }),
      );
      return {
        sprint: current,
        items,
        nextCursor: rows.length > limit ? items[items.length - 1].issueId : null,
      };
    },
    async readOperation(s, operationId) {
      await access.authorize(s, "read");
      const r = await one("readReceipt", [ws(s), actor(s), id(operationId)]);
      if (!r) return null;
      await readSprint(s, str(r, "result_id"));
      return { id: str(r, "result_id"), version: num(r, "result_version") };
    },
    async readEvents(reader, workspaceId, cursor, limit) {
      if (!eventReader || reader !== eventReader) fail("forbidden", "Invalid event reader");
      if (
        !Number.isSafeInteger(cursor) ||
        cursor < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        fail("validation", "Invalid page");
      return (await store.run("events", [id(workspaceId), cursor, limit])).rows.map((r) => ({
        eventId: str(r, "event_id"),
        source: "planning" as const,
        schemaVersion: num(r, "schema_version") as 1 | 2,
        workspaceId,
        projectId: r.project_id === null ? null : str(r, "project_id"),
        aggregateId: str(r, "aggregate_id"),
        aggregateVersion: num(r, "aggregate_version"),
        type: str(r, "type") as PlanningEvent["type"],
        issueId: r.issue_id === null ? null : str(r, "issue_id"),
        actorId: str(r, "actor_id"),
        payload: {
          actorId: str(r, "actor_id"),
          clientId: r.client_id === null ? null : str(r, "client_id"),
        },
        occurredAt: num(r, "occurred_at"),
        cursor: num(r, "sequence"),
      }));
    },
  };
  function key(scope: PlanningMaintenanceScope): [string, string] {
    return [id(scope.workspaceId), scope.projectId === undefined ? "" : id(scope.projectId)];
  }
  async function status(scope: PlanningMaintenanceScope): Promise<PlanningPurgeStatus | null> {
    const [workspaceId, projectId] = key(scope);
    const marker = await one("maintenanceMarker", [workspaceId, projectId]);
    if (!marker) return null;
    const remaining = num(
      (await one("maintenanceCount", [workspaceId, projectId])) ?? fail("unknown", "Missing count"),
      "n",
    );
    const pending = projectId
      ? num(
          (await one("maintenanceUnknown", [workspaceId, workspaceId, workspaceId])) ??
            fail("unknown", "Missing pending count"),
          "n",
        )
      : 0;
    return {
      state:
        marker.state === "purging" ? (remaining + pending === 0 ? "purged" : "purging") : "frozen",
      remaining,
      pending,
    };
  }
  const maintenance: PlanningMaintenance = {
    async freezeScope(scope) {
      const [workspaceId, projectId] = key(scope);
      await store.run("maintenanceFreeze", [workspaceId, projectId]);
      return (await status(scope)) ?? fail("unknown", "Missing marker");
    },
    async purgeScope(scope) {
      const [workspaceId, projectId] = key(scope);
      if (!(await status(scope))) fail("conflict", "Scope is not frozen");
      await store.batch([
        { name: "maintenancePurging", values: [workspaceId, projectId] },
        { name: "purgeItems", values: [workspaceId, projectId, workspaceId, projectId] },
        { name: "purgeHistory", values: [workspaceId, projectId, projectId] },
        { name: "purgeReceipts", values: [workspaceId, projectId, projectId] },
        { name: "purgeEvents", values: [workspaceId, projectId, projectId] },
        { name: "purgeSprints", values: [workspaceId, projectId, projectId] },
      ]);
      return (await status(scope)) ?? fail("unknown", "Missing marker");
    },
    purgeStatus: status,
  };
  return { api, eventReader, maintenance };
}
