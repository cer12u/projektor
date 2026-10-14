import { type ModuleStore, PlatformError, type Row } from "../../../platform/public";
import type {
  IntegrationsMaintenance,
  IntegrationsMaintenanceScope,
  IntegrationsPurgeStatus,
} from "../public";
import type { queries } from "../storage/queries";

type Name = keyof typeof queries;

function id(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new PlatformError("validation", "Invalid ID");
  return value;
}
function key(scope: IntegrationsMaintenanceScope): [string, string] {
  return [id(scope.workspaceId), scope.projectId === undefined ? "" : id(scope.projectId)];
}
function count(row: Row | undefined): number {
  if (!row || typeof row.n !== "number") throw new PlatformError("unknown", "Missing count");
  return row.n;
}

export function createIntegrationsMaintenance(
  store: ModuleStore<"integrations", Name>,
): IntegrationsMaintenance {
  if (store.owner !== "integrations")
    throw new PlatformError("forbidden", "Wrong Integrations store");
  async function status(
    scope: IntegrationsMaintenanceScope,
  ): Promise<IntegrationsPurgeStatus | null> {
    const [workspaceId, projectId] = key(scope);
    const marker = (await store.run("maintenanceMarker", [workspaceId, projectId])).rows[0];
    if (!marker) return null;
    const remaining = count(
      (await store.run("maintenanceCount", [workspaceId, projectId])).rows[0],
    );
    const pending = projectId
      ? count(
          (
            await store.run("maintenanceUnknown", [
              workspaceId,
              workspaceId,
              workspaceId,
              workspaceId,
              workspaceId,
            ])
          ).rows[0],
        )
      : 0;
    return {
      state:
        marker.state === "purging" ? (remaining + pending === 0 ? "purged" : "purging") : "frozen",
      remaining,
      pending,
    };
  }
  return {
    async freezeScope(scope) {
      const [workspaceId, projectId] = key(scope);
      await store.run("maintenanceFreeze", [workspaceId, projectId]);
      const result = await status(scope);
      if (!result) throw new PlatformError("unknown", "Missing marker");
      return result;
    },
    async purgeScope(scope) {
      const [workspaceId, projectId] = key(scope);
      if (!(await status(scope))) throw new PlatformError("conflict", "Scope is not frozen");
      await store.batch([
        { name: "maintenancePurging", values: [workspaceId, projectId] },
        ...(
          [
            "purgeLinks",
            "purgeFeedback",
            "purgeDeliveries",
            "purgeReceipts",
            "purgeHistory",
            "purgeEvents",
            "purgeSources",
          ] as const
        ).map((name) => ({ name, values: [workspaceId, projectId, projectId] })),
        { name: "purgeGuards", values: [workspaceId, projectId] },
      ]);
      const result = await status(scope);
      if (!result) throw new PlatformError("unknown", "Missing marker");
      return result;
    },
    purgeStatus: status,
  };
}
