import {
  type Call,
  type Clock,
  type IdGenerator,
  type ModuleStore,
  PlatformError,
  type Row,
} from "../../../platform/public";
import type { AccessApi, RequestScope } from "../../access/public";
import type { AssetEventReader, AssetsApi } from "../../assets/public";
import type { CoordinationApi, CoordinationEventReader } from "../../coordination/public";
import type { IssueEventReader, IssuesApi } from "../../issues/public";
import type { PlanningApi, PlanningEventReader } from "../../planning/public";
import type { ProjectEventReader, ProjectsApi } from "../../projects/public";
import type { WikiApi, WikiEventReader } from "../../wiki/public";
import type {
  ActivityItem,
  InsightsApi,
  InsightsMaintenance,
  InsightsMaintenanceScope,
  InsightsPurgeStatus,
  Notification,
  ProjectionLag,
  SourceOwner,
  SubscriptionResult,
} from "../public";
import type { queries } from "../storage/queries";
import { computeFlowMetrics, validateFlowMetrics } from "./flow-metrics";

type Name = keyof typeof queries;
type Statement = Call<Name>;
type Event = {
  readonly eventId: string;
  readonly source: SourceOwner;
  readonly schemaVersion: number;
  readonly workspaceId: string;
  readonly projectId?: string | null;
  readonly cursor: number;
  readonly occurredAt: number;
  readonly type: string;
  readonly aggregateId?: string;
  readonly subjectId?: string;
  readonly issueId?: string | null;
  readonly aggregateVersion?: number;
  readonly actorId?: string;
  readonly payload?: { readonly actorId: string; readonly clientId?: string | null };
};
type Reader<T> = {
  readonly api: {
    readEvents(
      reader: T,
      workspaceId: string,
      cursor: number,
      limit: number,
    ): Promise<readonly Event[]>;
  };
  readonly cap: T;
};
interface Dependencies {
  readonly store: ModuleStore<"insights", Name>;
  readonly access: Pick<AccessApi, "authorize">;
  readonly projects: Pick<ProjectsApi, "authorizeProject" | "getProject" | "listVisibleProjects">;
  readonly issues: Pick<
    IssuesApi,
    | "authorizeIssue"
    | "getHistory"
    | "listIssues"
    | "flowIssueRows"
    | "countDoneBefore"
    | "humanCommentCounts"
    | "listTaskTypes"
  >;
  readonly wiki: Pick<WikiApi, "authorizePage">;
  readonly coordination: Pick<CoordinationApi, "listLeases" | "projectSessions">;
  readonly planning: Pick<PlanningApi, "listSprints">;
  readonly assets: Pick<AssetsApi, "getMetadata">;
  readonly readers: {
    readonly projects: Reader<ProjectEventReader>;
    readonly issues: Reader<IssueEventReader>;
    readonly wiki: Reader<WikiEventReader>;
    readonly coordination: Reader<CoordinationEventReader>;
    readonly planning: Reader<PlanningEventReader>;
    readonly assets: Reader<AssetEventReader>;
  };
  readonly clock: Clock;
  readonly ids: IdGenerator;
}
const sources: readonly SourceOwner[] = [
  "projects",
  "issues",
  "wiki",
  "coordination",
  "planning",
  "assets",
];
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
function ver(v: unknown): number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0
    ? v
    : fail("validation", "Invalid version");
}
function str(r: Row, k: string): string {
  return typeof r[k] === "string" ? r[k] : fail("unknown", `Invalid ${k}`);
}
function num(r: Row, k: string): number {
  return typeof r[k] === "number" ? r[k] : fail("unknown", `Invalid ${k}`);
}
const visibleFailure = (e: unknown) =>
  e instanceof PlatformError && (e.code === "forbidden" || e.code === "not_found");
async function hash(v: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(v)));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
function pageLimit(v: number | undefined): number {
  const n = v ?? 30;
  return Number.isSafeInteger(n) && n > 0 && n <= 50 ? n : fail("validation", "Invalid limit");
}
function decodeCursor(v: string | undefined): { at: number; source: string; seq: number } {
  if (!v) return { at: Number.MAX_SAFE_INTEGER, source: "", seq: Number.MAX_SAFE_INTEGER };
  const match = v.match(/^(\d+):(projects|issues|wiki|coordination|planning|assets):(\d+)$/);
  if (!match) fail("validation", "Invalid cursor");
  return { at: Number(match[1]), source: match[2], seq: Number(match[3]) };
}
export function createInsights(d: Dependencies): {
  api: InsightsApi;
  background: { consumeEvents(workspaceId: string, limit?: number): Promise<number> };
  maintenance: InsightsMaintenance;
} {
  if (d.store.owner !== "insights") fail("forbidden", "Wrong Insights store");
  const { store, access, projects, issues, wiki, coordination, planning, assets, clock, ids } = d;
  const one = async (name: Name, values: Statement["values"]) =>
    (await store.run(name, values)).rows[0];
  async function frozen(workspaceId: string, projectId?: string): Promise<boolean> {
    if (await one("maintenanceMarker", [workspaceId, ""])) return true;
    return projectId ? Boolean(await one("maintenanceMarker", [workspaceId, projectId])) : false;
  }
  async function lag(ws: string): Promise<readonly ProjectionLag[]> {
    const rows = (await store.run("cursors", [ws])).rows;
    return sources.map((source) => {
      const r = rows.find((row) => row.source === source);
      return {
        source,
        sequence: r ? num(r, "sequence") : 0,
        consumedAt: r && num(r, "sequence") > 0 ? num(r, "consumed_at") : null,
      };
    });
  }
  async function seed(ws: string) {
    for (const source of sources) await store.run("seedCursor", [ws, source, 0]);
  }
  async function consume(ws: string, limit = 30): Promise<number> {
    id(ws);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      fail("validation", "Invalid limit");
    if (await frozen(ws)) return 0;
    await seed(ws);
    let total = 0;
    for (const source of sources) {
      const cursor = await one("cursor", [ws, source]);
      const before = cursor ? num(cursor, "sequence") : 0;
      const events =
        source === "projects"
          ? await d.readers.projects.api.readEvents(d.readers.projects.cap, ws, before, limit)
          : source === "issues"
            ? await d.readers.issues.api.readEvents(d.readers.issues.cap, ws, before, limit)
            : source === "wiki"
              ? await d.readers.wiki.api.readEvents(d.readers.wiki.cap, ws, before, limit)
              : source === "coordination"
                ? await d.readers.coordination.api.readEvents(
                    d.readers.coordination.cap,
                    ws,
                    before,
                    limit,
                  )
                : source === "planning"
                  ? await d.readers.planning.api.readEvents(
                      d.readers.planning.cap,
                      ws,
                      before,
                      limit,
                    )
                  : await d.readers.assets.api.readEvents(d.readers.assets.cap, ws, before, limit);
      if (events.length === 0) continue;
      let last = before;
      const calls: Statement[] = [];
      for (const event of events) {
        if (
          event.workspaceId !== ws ||
          event.source !== source ||
          (event.schemaVersion !== 1 &&
            !(
              event.schemaVersion === 2 &&
              ["projects", "coordination", "planning", "assets"].includes(source)
            )) ||
          event.cursor > last + 1
        )
          fail("unknown", "Producer event sequence gap");
        if (event.cursor <= last) continue;
        last = event.cursor;
        if (event.projectId && (await frozen(ws, event.projectId))) continue;
        calls.push({
          name: "activity",
          values: [
            ws,
            source,
            event.cursor,
            event.eventId,
            (source === "coordination" && event.type === "FileClaimForced"
              ? event.issueId
              : (event.aggregateId ?? event.subjectId)) ?? "",
            event.aggregateVersion ?? 0,
            event.type,
            event.payload?.actorId ?? event.actorId ?? "",
            event.payload?.clientId ?? null,
            event.occurredAt,
            event.projectId === null
              ? source === "coordination" && event.type === "FileClaimForced" && !event.issueId
                ? ""
                : null
              : (event.projectId ?? (source === "projects" ? (event.aggregateId ?? null) : null)),
          ],
        });
      }
      const g = ids.next();
      calls.push(
        { name: "advanceCursor", values: [last, clock.now(), ws, source, before] },
        { name: "guard", values: [ws, g] },
        { name: "clearGuard", values: [ws, g] },
      );
      try {
        await store.batch(calls);
        total += events.length;
      } catch (error) {
        const current = await one("cursor", [ws, source]);
        if (current && num(current, "sequence") >= last) continue;
        throw error;
      }
    }
    return total;
  }
  async function authorized(s: RequestScope) {
    await access.authorize(s, "read");
    return id(s.workspaceId);
  }
  async function catchUp(s: RequestScope) {
    const ws = await authorized(s);
    await consume(ws, 30);
    return ws;
  }
  async function locate(
    s: RequestScope,
    source: SourceOwner,
    entityId: string,
  ): Promise<{ projectId: string; title: string } | null> {
    // Legacy forced claims have only a path subject, not an authorizable issue.
    if (source === "coordination" && !/^[A-Za-z0-9_-]{1,128}$/.test(entityId)) return null;
    try {
      if (source === "issues" || source === "coordination") {
        const issue = await issues.authorizeIssue(s, entityId);
        return { projectId: issue.projectId, title: issue.title };
      }
      if (source === "wiki") {
        const page = await wiki.authorizePage(s, entityId);
        return { projectId: page.projectId ?? "", title: page.title };
      }
      if (source === "assets") {
        const asset = await assets.getMetadata(s, entityId);
        return { projectId: asset.projectId, title: asset.filename };
      }
      if (source === "projects") {
        const project = await projects.getProject(s, entityId);
        return { projectId: project.id, title: project.name };
      }
      let cursor: string | undefined;
      do {
        const page = await projects.listVisibleProjects(s, cursor, 100);
        for (const project of page.projects) {
          const sprint = (await planning.listSprints(s, project.id)).find(
            (item) => item.id === entityId,
          );
          if (sprint && !sprint.archived) return { projectId: project.id, title: sprint.name };
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return null;
    } catch (e) {
      if (visibleFailure(e)) return null;
      throw e;
    }
  }
  async function replay(s: RequestScope, op: string, fp: string): Promise<Row | null> {
    const r = await one("readReceipt", [id(s.workspaceId), id(s.principalId), id(op)]);
    if (!r) return null;
    if (str(r, "fingerprint") !== fp) fail("conflict", "Operation ID reused");
    return r;
  }
  async function commit(
    s: RequestScope,
    op: string,
    fp: string,
    resultId: string,
    resultVersion: number,
    active: number | null,
    projectId: string,
    change: Statement,
  ): Promise<Row> {
    const g = ids.next();
    try {
      await store.batch([
        change,
        { name: "guard", values: [s.workspaceId, g] },
        { name: "clearGuard", values: [s.workspaceId, g] },
        {
          name: "receipt",
          values: [
            s.workspaceId,
            s.principalId,
            op,
            fp,
            resultId,
            projectId,
            resultVersion,
            active,
          ],
        },
      ]);
    } catch (e) {
      const saved = await replay(s, op, fp);
      if (saved) return saved;
      if (e instanceof Error && /(?:CHECK|UNIQUE) constraint failed/i.test(e.message))
        fail("conflict", "Version conflict");
      fail("unknown", "Outcome unknown; retry operation ID");
    }
    const saved = await replay(s, op, fp);
    if (!saved) fail("unknown", "Outcome unknown; retry operation ID");
    return saved;
  }
  async function subscription(
    s: RequestScope,
    input: { operationId: string; issueId: string; expectedVersion: number },
    active: boolean,
  ): Promise<SubscriptionResult> {
    await access.authorize(s, "write");
    const op = id(input.operationId),
      issueId = id(input.issueId),
      expected = ver(input.expectedVersion);
    const issue = await issues.authorizeIssue(s, issueId);
    const fp = await hash([active ? "subscribe" : "unsubscribe", issueId, expected]);
    const saved = await replay(s, op, fp);
    if (saved)
      return {
        id: str(saved, "result_id"),
        version: num(saved, "result_version"),
        active: saved.active === 1,
      };
    const current = await one("subscription", [s.workspaceId, s.principalId, issueId]);
    const currentVersion = current ? num(current, "version") : 0;
    if (
      expected !== currentVersion ||
      (!current && !active) ||
      (current && (current.active === 1) === active)
    )
      fail("conflict", "Subscription version conflict");
    const change: Statement = current
      ? {
          name: "updateSubscription",
          values: [active ? 1 : 0, s.workspaceId, s.principalId, issueId, expected, active ? 0 : 1],
        }
      : {
          name: "createSubscription",
          values: [s.workspaceId, s.principalId, issueId, issue.projectId],
        };
    const r = await commit(
      s,
      op,
      fp,
      issueId,
      expected + 1,
      active ? 1 : 0,
      issue.projectId,
      change,
    );
    return { id: str(r, "result_id"), version: num(r, "result_version"), active: r.active === 1 };
  }
  async function hydrateNotifications(s: RequestScope, ws: string) {
    let cursor = decodeCursor(undefined);
    let rows: readonly Row[];
    do {
      rows = (
        await store.run("feed", [
          ws,
          cursor.at,
          cursor.at,
          cursor.source,
          cursor.source,
          cursor.seq,
          100,
        ])
      ).rows;
      for (const row of rows) {
        cursor = {
          at: num(row, "occurred_at"),
          source: str(row, "source"),
          seq: num(row, "sequence"),
        };
        const source = str(row, "source");
        if (source !== "issues" && source !== "coordination") continue;
        const issueId = str(row, "entity_id");
        const located = await locate(s, source, issueId);
        if (!located) continue;
        const seq = num(row, "sequence");
        const notificationId = `${source}_${seq}`;
        const recipients: { principalId: string; kind: "assigned" | "comment" | "lease" }[] = [];
        if (source === "issues") {
          const history = (await issues.getHistory(s, issueId)).find(
            (h) => h.version === num(row, "aggregate_version"),
          );
          if (history?.action === "assign") {
            const detail: unknown = JSON.parse(history.detail);
            if (
              typeof detail === "object" &&
              detail !== null &&
              "assigneeId" in detail &&
              typeof detail.assigneeId === "string"
            )
              recipients.push({ principalId: detail.assigneeId, kind: "assigned" });
          }
          if (history?.action === "comment")
            for (const sub of (await store.run("subscriptionsForIssue", [ws, issueId])).rows)
              recipients.push({ principalId: str(sub, "principal_id"), kind: "comment" });
        } else if (str(row, "type") === "LeaseChanged") {
          const issue = await issues.authorizeIssue(s, issueId);
          if (issue.assigneeId) recipients.push({ principalId: issue.assigneeId, kind: "lease" });
        }
        for (const recipient of recipients)
          if (recipient.principalId === s.principalId && str(row, "actor_id") !== s.principalId)
            if (!(await frozen(ws, located.projectId)))
              await store.run("insertNotification", [
                ws,
                recipient.principalId,
                notificationId,
                issueId,
                located.projectId,
                recipient.kind,
                num(row, "occurred_at"),
              ]);
      }
    } while (rows.length === 100);
  }
  const api: InsightsApi = {
    async getFlowMetrics(s, input) {
      await access.authorize(s, "read");
      const projectId = id(input.projectId);
      await projects.authorizeProject(s, projectId);
      const now = Math.floor(clock.now());
      validateFlowMetrics(input, now);
      const createdUntil = input.until ?? now;
      const doneBefore = input.since === undefined ? null : input.since - (input.since % 86400);
      const loaded = await issues.flowIssueRows(s, projectId, createdUntil, doneBefore);
      const done = loaded.filter(
        (i) =>
          i.doneAt !== null &&
          (input.since === undefined || i.doneAt >= input.since) &&
          (input.until === undefined || i.doneAt <= input.until),
      );
      const comments = await issues.humanCommentCounts(
        s,
        projectId,
        done.map((i) => i.id),
      );
      const doneBeforeWindow =
        doneBefore === null
          ? 0
          : await issues.countDoneBefore(s, projectId, createdUntil, doneBefore);
      const bugTypeTracked = (await issues.listTaskTypes(s)).some((t) => t.key === "bug");
      return computeFlowMetrics(
        input,
        {
          loaded,
          comments,
          leaseSeconds: {},
          bugTypeTracked,
          doneBeforeWindow,
          factoryHealth: {
            leaseExpiries: 0,
            abandonedClaims: 0,
            gateRejections: 0,
            wipCapPressure: 0,
          },
        },
        now,
      );
    },
    async getSubscription(s, issueId) {
      await authorized(s);
      const iid = id(issueId);
      await issues.authorizeIssue(s, iid);
      const row = await one("subscription", [s.workspaceId, s.principalId, iid]);
      return row ? { id: iid, version: num(row, "version"), active: row.active === 1 } : null;
    },
    subscribe: (s, input) => subscription(s, input, true),
    unsubscribe: (s, input) => subscription(s, input, false),
    async markRead(s, input) {
      await access.authorize(s, "write");
      const op = id(input.operationId),
        notificationId = id(input.notificationId),
        expected = ver(input.expectedVersion);
      const fp = await hash(["markRead", notificationId, expected]);
      const saved = await replay(s, op, fp);
      const row = await one("notification", [s.workspaceId, s.principalId, notificationId]);
      if (!row) fail("not_found", "Notification not found");
      const issue = await issues.authorizeIssue(s, str(row, "issue_id"));
      if (saved) return { id: str(saved, "result_id"), version: num(saved, "result_version") };
      if (num(row, "version") !== expected || row.read !== 0)
        fail("conflict", "Notification version conflict");
      const r = await commit(s, op, fp, notificationId, expected + 1, null, issue.projectId, {
        name: "markRead",
        values: [s.workspaceId, s.principalId, notificationId, expected],
      });
      return { id: str(r, "result_id"), version: num(r, "result_version") };
    },
    async getActivity(s, input = {}) {
      const ws = await catchUp(s),
        limit = pageLimit(input.limit);
      const projectId = input.projectId ? id(input.projectId) : null;
      if (projectId) await projects.authorizeProject(s, projectId);
      const principalId = input.principalId ? id(input.principalId) : null;
      const clientId = input.clientId ? id(input.clientId) : null;
      let cursor = decodeCursor(input.cursor),
        exhausted = false;
      const items: ActivityItem[] = [];
      while (items.length < limit && !exhausted) {
        const rows = (
          await store.run("feed", [
            ws,
            cursor.at,
            cursor.at,
            cursor.source,
            cursor.source,
            cursor.seq,
            100,
          ])
        ).rows;
        exhausted = rows.length < 100;
        for (const [index, row] of rows.entries()) {
          const source = str(row, "source") as SourceOwner;
          cursor = { at: num(row, "occurred_at"), source, seq: num(row, "sequence") };
          if (
            (principalId && principalId !== row.actor_id) ||
            (clientId && clientId !== row.client_id)
          )
            continue;
          const entityId = str(row, "entity_id");
          const found = await locate(s, source, entityId);
          if (!found || (projectId && found.projectId !== projectId)) continue;
          items.push({
            source,
            sequence: cursor.seq,
            type: str(row, "type"),
            entityId,
            projectId: found.projectId,
            title: found.title,
            actorId: str(row, "actor_id"),
            clientId: row.client_id === null ? null : str(row, "client_id"),
            occurredAt: cursor.at,
          });
          if (items.length === limit) {
            if (index < rows.length - 1) exhausted = false;
            break;
          }
        }
      }
      return {
        items,
        nextCursor: exhausted ? null : `${cursor.at}:${cursor.source}:${cursor.seq}`,
        lag: await lag(ws),
      };
    },
    async getMetrics(s, projectId) {
      const ws = await catchUp(s),
        pid = id(projectId);
      await projects.authorizeProject(s, pid);
      const counts = { todo: 0, inProgress: 0, done: 0 };
      const seven = new Map<
        string,
        { principalId: string; clientId: string | null; count: number }
      >();
      const thirty = new Map<
        string,
        { principalId: string; clientId: string | null; count: number }
      >();
      let cursor: string | undefined;
      do {
        const page = await issues.listIssues(s, { projectId: pid, cursor, limit: 100 });
        for (const issue of page.issues) {
          if (issue.state === "todo") counts.todo++;
          else if (issue.state === "in_progress") counts.inProgress++;
          else if (issue.state === "done") counts.done++;
          const history = await issues.getHistory(s, issue.id);
          for (const h of history)
            if (h.action === "transition") {
              const detail: unknown = JSON.parse(h.detail);
              if (
                typeof detail !== "object" ||
                detail === null ||
                !("to" in detail) ||
                detail.to !== "done"
              )
                continue;
              const key = `${h.actorId}:${h.clientId ?? ""}`;
              for (const [days, map] of [
                [7, seven],
                [30, thirty],
              ] as const)
                if (h.occurredAt >= clock.now() - days * 86400 && h.occurredAt <= clock.now()) {
                  const prev = map.get(key);
                  map.set(key, {
                    principalId: h.actorId,
                    clientId: h.clientId,
                    count: (prev?.count ?? 0) + 1,
                  });
                }
            }
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      const leases = await coordination.listLeases(s, pid);
      let sessionCursor: string | undefined;
      let activeSessions = 0;
      do {
        const page = await coordination.projectSessions(s, pid, sessionCursor, 100);
        activeSessions += page.items.filter((x) => x.live).length;
        sessionCursor = page.nextCursor ?? undefined;
      } while (sessionCursor);
      const result = {
        projectId: pid,
        ...counts,
        completed7Days: [...seven.values()],
        completed30Days: [...thirty.values()],
        activeLeases: leases.filter((x) => x.expiresAt > clock.now()).length,
        activeSessions,
        lag: await lag(ws),
      };
      if (!(await frozen(ws, pid)))
        await store.run("saveMetrics", [
          ws,
          pid,
          clock.now(),
          counts.todo,
          counts.inProgress,
          counts.done,
          result.activeLeases,
          result.activeSessions,
        ]);
      return result;
    },
    async listNotifications(s, cursor, limit) {
      const ws = await catchUp(s);
      await hydrateNotifications(s, ws);
      const n = pageLimit(limit);
      const parsed = cursor ? cursor.match(/^(\d+):([A-Za-z0-9_-]+)$/) : null;
      if (cursor && !parsed) fail("validation", "Invalid cursor");
      const at = parsed ? Number(parsed[1]) : Number.MAX_SAFE_INTEGER;
      const key = parsed ? parsed[2] : "~";
      const items: Notification[] = [];
      let scanAt = Number.MAX_SAFE_INTEGER,
        scanKey = "~",
        rows: readonly Row[];
      do {
        rows = (await store.run("notifications", [ws, s.principalId, scanAt, scanAt, scanKey, 100]))
          .rows;
        for (const row of rows) {
          scanAt = num(row, "occurred_at");
          scanKey = str(row, "id");
          try {
            await issues.authorizeIssue(s, str(row, "issue_id"));
          } catch (e) {
            if (visibleFailure(e)) continue;
            throw e;
          }
          items.push({
            id: str(row, "id"),
            issueId: str(row, "issue_id"),
            kind: str(row, "kind") as Notification["kind"],
            occurredAt: num(row, "occurred_at"),
            version: num(row, "version"),
            read: row.read === 1,
          });
        }
      } while (rows.length === 100);
      const unread = items.filter((item) => !item.read).length;
      const after = items.filter(
        (item) => item.occurredAt < at || (item.occurredAt === at && item.id < key),
      );
      const selected = after.slice(0, n);
      const last = selected.at(-1);
      return {
        items: selected,
        nextCursor: after.length > n && last ? `${last.occurredAt}:${last.id}` : null,
        unread,
        lag: await lag(ws),
      };
    },
  };
  function key(scope: InsightsMaintenanceScope): [string, string] {
    return [id(scope.workspaceId), scope.projectId === undefined ? "" : id(scope.projectId)];
  }
  async function status(scope: InsightsMaintenanceScope): Promise<InsightsPurgeStatus | null> {
    const [workspaceId, projectId] = key(scope);
    const marker = await one("maintenanceMarker", [workspaceId, projectId]);
    if (!marker) return null;
    const count = await one("maintenanceCount", [workspaceId, projectId]);
    const remaining = num(count ?? fail("unknown", "Missing count"), "n");
    const pending = projectId
      ? num(
          (await one("maintenanceUnknown", [workspaceId, workspaceId, workspaceId, workspaceId])) ??
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
  const maintenance: InsightsMaintenance = {
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
        ...(
          [
            "purgeActivity",
            "purgeMetrics",
            "purgeSubscriptions",
            "purgeNotifications",
            "purgeReceipts",
          ] as const
        ).map((name) => ({ name, values: [workspaceId, projectId, projectId] })),
        { name: "purgeCursors", values: [workspaceId, projectId] },
        { name: "purgeGuards", values: [workspaceId, projectId] },
      ]);
      return (await status(scope)) ?? fail("unknown", "Missing marker");
    },
    purgeStatus: status,
  };
  return { api, background: Object.freeze({ consumeEvents: consume }), maintenance };
}
