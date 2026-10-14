import {
  type Call,
  type ModuleStore,
  PlatformError,
  type ScopedBucket,
} from "../../../platform/public";
import type { AssetsMaintenance, AssetsPurgeStatus } from "../public";
import type { queries } from "../storage/queries";

type Name = keyof typeof queries;
type Scope = Parameters<AssetsMaintenance["freezeScope"]>[0];
export function createMaintenance(
  store: ModuleStore<"assets", Name>,
  bucketFor: (workspaceId: string) => ScopedBucket,
): AssetsMaintenance {
  function values(s: Scope): [string, string, string] {
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(s.workspaceId) ||
      (s.projectId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(s.projectId))
    )
      throw new PlatformError("validation", "Invalid purge scope");
    return [s.workspaceId, s.projectId ?? "", s.projectId ?? ""];
  }
  async function status(s: Scope): Promise<AssetsPurgeStatus | null> {
    const v = values(s);
    const marker = (await store.run("maintenanceMarker", v.slice(0, 2))).rows[0];
    if (!marker) return null;
    let remaining = 0;
    for (const name of [
      "maintenanceCountLinks",
      "maintenanceCountHistory",
      "maintenanceCountGcJobs",
      "maintenanceCountBlobs",
      "maintenanceCountReceipts",
      "maintenanceCountEvents",
    ] as const)
      remaining += Number((await store.run(name, v)).rows[0]?.n ?? 0);
    let pending = Number((await store.run("maintenancePending", v)).rows[0]?.n ?? 0);
    if (s.projectId)
      pending += Number(
        (await store.run("maintenanceUnattributed", [s.workspaceId, s.workspaceId])).rows[0]?.n ??
          0,
      );
    return { state: marker.state as AssetsPurgeStatus["state"], remaining, pending };
  }
  async function batch(ws: string, calls: Call<Name>[]) {
    await store.batch([
      { name: "maintenanceBypass", values: [ws] },
      ...calls,
      { name: "maintenanceUnbypass", values: [ws] },
    ]);
  }
  return {
    purgeStatus: status,
    async freezeScope(s) {
      const v = values(s);
      await store.run("maintenanceFreeze", v.slice(0, 2));
      const result = await status(s);
      if (!result) throw new PlatformError("unknown", "Missing freeze marker");
      return result;
    },
    async purgeScope(s) {
      const v = values(s),
        ws = s.workspaceId;
      const before = await status(s);
      if (!before) throw new PlatformError("conflict", "Scope must be frozen");
      if (before.state === "purged" || before.pending) return before;
      await store.run("maintenanceBegin", v.slice(0, 2));
      await batch(
        ws,
        [
          "maintenanceDeleteLinks",
          "maintenanceDeleteHistory",
          "maintenanceDeleteReceipts",
          "maintenanceDeleteEvents",
        ].map((name) => ({ name: name as Name, values: v })),
      );
      const blobs = (await store.run("maintenanceBlobs", v)).rows;
      for (const blob of blobs) {
        if (typeof blob.id !== "string") throw new PlatformError("unknown", "Invalid blob");
        const assetId = blob.id;
        const ready = (
          await store.run("maintenanceBlobReady", [
            ws,
            assetId,
            ws,
            assetId,
            ws,
            assetId,
            ws,
            assetId,
          ])
        ).rows[0];
        if (!ready) continue;
        // The GC receipt precedes the R2 effect. A crash retries the same deletion.
        await batch(ws, [
          { name: "maintenanceRetire", values: [ws, assetId] },
          { name: "gcAdd", values: [ws, assetId, 0] },
        ]);
        await bucketFor(ws).delete(`assets/${ws}/${assetId}`);
        await batch(ws, [
          { name: "gcRemove", values: [ws, assetId] },
          {
            name: "maintenanceBlobDone",
            values: [ws, assetId, ws, assetId, ws, assetId, ws, assetId],
          },
        ]);
      }
      const next = await status(s);
      if (!next) throw new PlatformError("unknown", "Missing purge status");
      if (next.remaining === 0 && next.pending === 0) {
        await store.run("maintenanceDone", v.slice(0, 2));
        return { ...next, state: "purged" };
      }
      return next;
    },
  };
}
