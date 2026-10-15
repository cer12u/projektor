import { type ModuleStore, PlatformError } from "../../../platform/public";
import type { IssuesMaintenance } from "../public";
import type { queries } from "../storage/queries";

type Name = keyof typeof queries;
type Scope = Parameters<IssuesMaintenance["freezeScope"]>[0];
function valid(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    throw new PlatformError("validation", "Invalid maintenance scope");
  return value;
}
export function createMaintenance(store: ModuleStore<"issues", Name>): IssuesMaintenance {
  function scopeIds(scope: Scope): [string, string] {
    const workspaceId = valid(scope.workspaceId);
    const projectId = scope.projectId === undefined ? "" : valid(scope.projectId);

    return [workspaceId, projectId];
  }
  async function status(scope: Scope) {
    const [workspaceId, projectId] = scopeIds(scope);
    const marker = (await store.run("maintenanceMarker", [workspaceId, projectId])).rows[0];
    if (!marker) return null;
    const search = Number(
      (await store.run("maintenanceCountSearch", [workspaceId, projectId, projectId])).rows[0]?.n ??
        0,
    );
    const comments = Number(
      (await store.run("maintenanceCountComments", [workspaceId, projectId, projectId])).rows[0]
        ?.n ?? 0,
    );
    const history = Number(
      (await store.run("maintenanceCountHistory", [workspaceId, projectId, projectId])).rows[0]
        ?.n ?? 0,
    );
    const receipts = Number(
      (await store.run("maintenanceCountReceipts", [workspaceId, projectId, projectId])).rows[0]
        ?.n ?? 0,
    );
    const events = Number(
      (await store.run("maintenanceCountEvents", [workspaceId, projectId, projectId])).rows[0]?.n ??
        0,
    );
    const guards = Number(
      (await store.run("maintenanceCountGuards", [workspaceId, projectId])).rows[0]?.n ?? 0,
    );
    const issues = Number(
      (await store.run("maintenanceCountIssues", [workspaceId, projectId, projectId])).rows[0]?.n ??
        0,
    );
    const counters = Number(
      (await store.run("maintenanceCountCounters", [workspaceId, projectId, projectId])).rows[0]
        ?.n ?? 0,
    );
    const additional = await Promise.all([
      store.run("maintenanceCountLinks", [workspaceId, projectId, projectId, projectId]),
      store.run("maintenanceCountStatuses", [workspaceId, projectId]),
      store.run("maintenanceCountTypes", [workspaceId, projectId]),
      store.run("maintenanceCountDefinitionHistory", [workspaceId, projectId]),
      store.run("maintenanceCountDefinitionReceipts", [workspaceId, projectId]),
    ]);
    const remaining =
      search +
      comments +
      history +
      receipts +
      events +
      guards +
      issues +
      counters +
      additional.reduce((sum, result) => sum + Number(result.rows[0]?.n ?? 0), 0);
    const state = marker.state;
    if (state !== "frozen" && state !== "purging" && state !== "purged")
      throw new PlatformError("unknown", "Invalid maintenance state");
    return { state, remaining, pending: 0 } as const;
  }
  return {
    async freezeScope(scope) {
      const [workspaceId, projectId] = scopeIds(scope);
      await store.run("maintenanceFreeze", [workspaceId, projectId]);
      const result = await status(scope);
      if (!result) throw new PlatformError("unknown", "Freeze marker missing");
      return result;
    },
    async purgeStatus(scope) {
      return status(scope);
    },
    async purgeScope(scope) {
      const [workspaceId, projectId] = scopeIds(scope);
      const current = await status(scope);
      if (!current) return null;
      if (current.state === "purged") return current;
      await store.run("maintenanceBegin", [workspaceId, projectId]);
      await store.batch([
        { name: "maintenanceBypass", values: [workspaceId, projectId] },
        { name: "maintenanceDeleteSearch", values: [workspaceId, projectId, projectId] },
        { name: "maintenanceDeleteLinks", values: [workspaceId, projectId, projectId, projectId] },
        { name: "maintenanceDeleteComments", values: [workspaceId, projectId, projectId] },
        { name: "maintenanceDeleteHistory", values: [workspaceId, projectId, projectId] },
        { name: "maintenanceDeleteReceipts", values: [workspaceId, projectId, projectId] },
        { name: "maintenanceDeleteEvents", values: [workspaceId, projectId, projectId] },
        { name: "maintenanceDeleteGuards", values: [workspaceId, projectId] },
        { name: "maintenanceDeleteIssues", values: [workspaceId, projectId, projectId] },
        { name: "maintenanceDeleteCounters", values: [workspaceId, projectId, projectId] },
        { name: "maintenanceDeleteStatuses", values: [workspaceId, projectId] },
        { name: "maintenanceDeleteTypes", values: [workspaceId, projectId] },
        { name: "maintenanceDeleteDefinitionHistory", values: [workspaceId, projectId] },
        { name: "maintenanceDeleteDefinitionReceipts", values: [workspaceId, projectId] },
        { name: "maintenanceUnbypass", values: [workspaceId, projectId] },
      ]);
      const next = await status(scope);
      if (next && next.remaining === 0) {
        await store.run("maintenanceDone", [workspaceId, projectId]);
        return status(scope);
      }
      return next;
    },
  };
}
