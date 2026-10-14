import { type ModuleStore, PlatformError } from "../../../platform/public";
import type { AccessMaintenance } from "../public";
import type { queries } from "../storage/queries";

type Name = keyof typeof queries;
type Scope = Parameters<AccessMaintenance["freezeScope"]>[0];
function valid(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    throw new PlatformError("validation", "Invalid maintenance scope");
  return value;
}
export function createMaintenance(store: ModuleStore<"access", Name>): AccessMaintenance {
  function scopeIds(scope: Scope): [string, string] {
    const workspaceId = valid(scope.workspaceId);
    const projectId = scope.projectId === undefined ? "" : valid(scope.projectId);
    if (projectId) throw new PlatformError("validation", "Access accepts workspace scope only");
    return [workspaceId, projectId];
  }
  async function status(scope: Scope) {
    const [workspaceId, projectId] = scopeIds(scope);
    const marker = (await store.run("maintenanceMarker", [workspaceId, projectId])).rows[0];
    if (!marker) return null;
    const oauthforms = Number(
      (await store.run("maintenanceCountOauthForms", [workspaceId, projectId])).rows[0]?.n ?? 0,
    );
    const oauthtokens = Number(
      (await store.run("maintenanceCountOauthTokens", [workspaceId, projectId])).rows[0]?.n ?? 0,
    );
    const oauthcodes = Number(
      (await store.run("maintenanceCountOauthCodes", [workspaceId, projectId])).rows[0]?.n ?? 0,
    );
    const oauthfamilies = Number(
      (await store.run("maintenanceCountOauthFamilies", [workspaceId, projectId])).rows[0]?.n ?? 0,
    );
    const credentials = Number(
      (await store.run("maintenanceCountCredentials", [workspaceId, projectId])).rows[0]?.n ?? 0,
    );
    const oauthworkspaceclients = Number(
      (await store.run("maintenanceCountOauthWorkspaceClients", [workspaceId, projectId])).rows[0]
        ?.n ?? 0,
    );
    const memberships = Number(
      (await store.run("maintenanceCountMemberships", [workspaceId, projectId])).rows[0]?.n ?? 0,
    );
    const receipts = Number(
      (await store.run("maintenanceCountReceipts", [workspaceId, projectId])).rows[0]?.n ?? 0,
    );
    const events = Number(
      (await store.run("maintenanceCountEvents", [workspaceId, projectId])).rows[0]?.n ?? 0,
    );
    const guards = Number(
      (await store.run("maintenanceCountGuards", [workspaceId, projectId])).rows[0]?.n ?? 0,
    );
    const workspaces = Number(
      (await store.run("maintenanceCountWorkspaces", [workspaceId, projectId])).rows[0]?.n ?? 0,
    );
    const remaining =
      oauthforms +
      oauthtokens +
      oauthcodes +
      oauthfamilies +
      credentials +
      oauthworkspaceclients +
      memberships +
      receipts +
      events +
      guards +
      workspaces;
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
        { name: "maintenanceDeleteOauthForms", values: [workspaceId, projectId] },
        { name: "maintenanceDeleteOauthTokens", values: [workspaceId, projectId] },
        { name: "maintenanceDeleteOauthCodes", values: [workspaceId, projectId] },
        { name: "maintenanceDeleteOauthFamilies", values: [workspaceId, projectId] },
        { name: "maintenanceDeleteCredentials", values: [workspaceId, projectId] },
        { name: "maintenanceDeleteOauthWorkspaceClients", values: [workspaceId, projectId] },
        { name: "maintenanceDeleteMemberships", values: [workspaceId, projectId] },
        { name: "maintenanceDeleteReceipts", values: [workspaceId, projectId] },
        { name: "maintenanceDeleteEvents", values: [workspaceId, projectId] },
        { name: "maintenanceDeleteGuards", values: [workspaceId, projectId] },
        { name: "maintenanceDeleteWorkspaces", values: [workspaceId, projectId] },
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
