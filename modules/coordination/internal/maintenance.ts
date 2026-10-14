import { type ModuleStore, PlatformError } from "../../../platform/public";
import type { CoordinationMaintenance } from "../public";
import type { queries } from "../storage/queries";

type Name = keyof typeof queries;
type Scope = Parameters<CoordinationMaintenance["freezeScope"]>[0];
function valid(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    throw new PlatformError("validation", "Invalid maintenance scope");
  return value;
}
export function createMaintenance(
  store: ModuleStore<"coordination", Name>,
): CoordinationMaintenance {
  function scopeIds(scope: Scope): [string, string] {
    const workspaceId = valid(scope.workspaceId);
    const projectId = scope.projectId === undefined ? "" : valid(scope.projectId);

    return [workspaceId, projectId];
  }
  async function status(scope: Scope) {
    const [workspaceId, projectId] = scopeIds(scope);
    const marker = (await store.run("maintenanceMarker", [workspaceId, projectId])).rows[0];
    if (!marker) return null;
    const fileClaims = Number(
      (await store.run("maintenanceCountFileClaims", [workspaceId, projectId, projectId])).rows[0]
        ?.n ?? 0,
    );
    const reportHistory = Number(
      (await store.run("maintenanceCountReportHistory", [workspaceId, projectId, projectId]))
        .rows[0]?.n ?? 0,
    );
    const reports = Number(
      (await store.run("maintenanceCountReports", [workspaceId, projectId, projectId])).rows[0]
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
    const limits = Number(
      (await store.run("maintenanceCountLimits", [workspaceId, projectId, projectId])).rows[0]?.n ??
        0,
    );
    const leases = Number(
      (await store.run("maintenanceCountLeases", [workspaceId, projectId, projectId])).rows[0]?.n ??
        0,
    );
    const sessions = Number(
      (await store.run("maintenanceCountSessions", [workspaceId, projectId])).rows[0]?.n ?? 0,
    );
    const remaining =
      fileClaims +
      reportHistory +
      reports +
      receipts +
      events +
      guards +
      limits +
      leases +
      sessions;
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
        { name: "maintenanceDeleteFileClaims", values: [workspaceId, projectId, projectId] },
        { name: "maintenanceDeleteReportHistory", values: [workspaceId, projectId, projectId] },
        { name: "maintenanceDeleteReports", values: [workspaceId, projectId, projectId] },
        { name: "maintenanceDeleteReceipts", values: [workspaceId, projectId, projectId] },
        { name: "maintenanceDeleteEvents", values: [workspaceId, projectId, projectId] },
        { name: "maintenanceDeleteGuards", values: [workspaceId, projectId] },
        { name: "maintenanceDeleteLimits", values: [workspaceId, projectId, projectId] },
        { name: "maintenanceDeleteLeases", values: [workspaceId, projectId, projectId] },
        { name: "maintenanceDeleteSessions", values: [workspaceId, projectId] },
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
