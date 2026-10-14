import {
  type Call,
  type Clock,
  type IdGenerator,
  type ModuleStore,
  PlatformError,
  type Row,
} from "../../../platform/public";
import type { AccessApi, AccessMaintenance } from "../../access/public";
import type { AssetsMaintenance } from "../../assets/public";
import type { CoordinationMaintenance } from "../../coordination/public";
import type { InsightsMaintenance } from "../../insights/public";
import type { IntegrationsMaintenance } from "../../integrations/public";
import type { IssuesMaintenance } from "../../issues/public";
import type { PlanningMaintenance } from "../../planning/public";
import type { ProjectsApi, ProjectsMaintenance } from "../../projects/public";
import type { WikiMaintenance } from "../../wiki/public";
import type { LifecycleApi, LifecycleEvent, LifecycleScope, PurgeJob, PurgeStep } from "../public";
import type { queries } from "../storage/queries";

type Name = keyof typeof queries;
type Statement = Call<Name>;
interface Dependencies {
  readonly store: ModuleStore<"lifecycle", Name>;
  readonly access: Pick<AccessApi, "requireMembership" | "me">;
  readonly projects: Pick<ProjectsApi, "getProjectIncludingArchived">;
  readonly owners: {
    readonly access: AccessMaintenance;
    readonly projects: ProjectsMaintenance;
    readonly issues: IssuesMaintenance;
    readonly wiki: WikiMaintenance;
    readonly coordination: CoordinationMaintenance;
    readonly assets: AssetsMaintenance;
    readonly planning: PlanningMaintenance;
    readonly insights: InsightsMaintenance;
    readonly integrations: IntegrationsMaintenance;
  };
  readonly clock: Clock;
  readonly ids: IdGenerator;
}
// Parents are removed last; every owner must acknowledge freeze before any deletion.
const order = [
  "integrations",
  "insights",
  "planning",
  "assets",
  "coordination",
  "wiki",
  "issues",
  "projects",
  "access",
] as const;
function id(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    throw new PlatformError("validation", "Invalid ID");
  return value;
}
function version(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new PlatformError("validation", "Invalid version");
  return value;
}
function str(row: Row, key: string): string {
  if (typeof row[key] !== "string") throw new PlatformError("unknown", "Invalid stored job");
  return row[key];
}
function num(row: Row, key: string): number {
  if (typeof row[key] !== "number") throw new PlatformError("unknown", "Invalid stored count");
  return row[key];
}
async function fingerprint(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}
export function createLifecycle(d: Dependencies): {
  api: LifecycleApi;
  background: { tick(limit?: number): Promise<number> };
} {
  const { store, access, projects, clock, ids } = d;
  if (store.owner !== "lifecycle") throw new PlatformError("forbidden", "Wrong Lifecycle store");
  const one = async (name: Name, values: Statement["values"]) =>
    (await store.run(name, values)).rows[0];
  const scopeKey = (projectId?: string) =>
    projectId === undefined ? "workspace" : `project:${id(projectId)}`;
  async function job(row: Row): Promise<PurgeJob> {
    const steps = (await store.run("steps", [str(row, "workspace_id"), str(row, "id")])).rows;
    return {
      id: str(row, "id"),
      workspaceId: str(row, "workspace_id"),
      projectId: row.project_id === null ? null : str(row, "project_id"),
      version: num(row, "version"),
      state: str(row, "state") as PurgeJob["state"],
      steps: steps.map((r) => ({
        owner: str(r, "owner"),
        state: str(r, "state") as PurgeStep["state"],
        remaining: num(r, "remaining"),
        pending: num(r, "pending"),
        error: r.error === null ? null : str(r, "error"),
        ...(typeof r.sweeping_until === "number" ? { sweepingUntil: r.sweeping_until } : {}),
      })),
    };
  }
  async function owner(s: LifecycleScope) {
    const admitted = await access.requireMembership(
      s.principal,
      id(s.workspaceId),
      s.requestId,
      "write",
    );
    if (admitted.kind !== "human" || admitted.clientId || admitted.role !== "owner")
      throw new PlatformError("forbidden", "Only an interactive workspace owner can purge");
    return admitted;
  }
  function audit(j: PurgeJob, action: LifecycleEvent["type"], actor: string): Statement[] {
    return [
      { name: "history", values: [j.workspaceId, j.id, j.version, action, actor, clock.now()] },
      { name: "event", values: [j.workspaceId, ids.next(), j.id, j.version, action, clock.now()] },
    ];
  }
  function cas(j: PurgeJob, state: PurgeJob["state"], retryAt = 0): Statement[] {
    const guard = ids.next();
    return [
      { name: "advance", values: [state, clock.now(), retryAt, j.workspaceId, j.id, j.version] },
      { name: "guard", values: [j.workspaceId, guard] },
      { name: "clearGuard", values: [j.workspaceId, guard] },
    ];
  }
  async function replay(
    ws: string,
    actor: string,
    op: string,
    fp: string,
  ): Promise<PurgeJob | null> {
    const r = await one("readReceipt", [ws, actor, op]);
    if (!r) return null;
    if (str(r, "fingerprint") !== fp) throw new PlatformError("conflict", "Operation ID reused");
    // Only this owner writes this immutable receipt, using the same DTO encoder below.
    return JSON.parse(str(r, "result_json")) as PurgeJob;
  }
  async function commit(j: PurgeJob, actor: string, op: string, fp: string, calls: Statement[]) {
    try {
      await store.batch([
        ...calls,
        { name: "receipt", values: [j.workspaceId, actor, op, fp, JSON.stringify(j)] },
      ]);
      return j;
    } catch (error) {
      const saved = await replay(j.workspaceId, actor, op, fp);
      if (saved) return saved;
      if (error instanceof Error && /constraint failed/i.test(error.message))
        throw new PlatformError("conflict", "Purge version or scope conflict");
      throw new PlatformError("unknown", "Outcome unknown; retry the same operation ID");
    }
  }
  const api: LifecycleApi = {
    async requestPurge(s, input) {
      const admitted = await owner(s);
      const op = id(input.operationId),
        expected = version(input.expectedVersion);
      const projectId = input.projectId === undefined ? null : id(input.projectId);
      if (input.confirmation !== (projectId ?? s.workspaceId))
        throw new PlatformError("validation", "Confirmation must exactly match the scope ID");
      const fp = await fingerprint(["request", projectId, expected, input.confirmation]);
      const saved = await replay(s.workspaceId, admitted.principalId, op, fp);
      if (saved) return saved;
      if (expected !== 0 || (await one("scopeJob", [s.workspaceId, scopeKey(input.projectId)])))
        throw new PlatformError("conflict", "A purge already exists for this scope");
      if (projectId) await projects.getProjectIncludingArchived(admitted, projectId);
      const j: PurgeJob = {
        id: ids.next(),
        workspaceId: s.workspaceId,
        projectId,
        version: 1,
        state: "freezing",
        steps: order
          .filter((o) => !projectId || o !== "access")
          .map((o) => ({ owner: o, state: "pending", remaining: 0, pending: 0, error: null })),
      };
      return commit(j, admitted.principalId, op, fp, [
        {
          name: "create",
          values: [
            j.workspaceId,
            j.id,
            scopeKey(input.projectId),
            projectId,
            admitted.principalId,
            clock.now(),
          ],
        },
        ...j.steps.map(
          (step, ordinal): Statement => ({
            name: "step",
            values: [j.workspaceId, j.id, step.owner, ordinal],
          }),
        ),
        ...audit(j, "PurgeRequested", admitted.principalId),
      ]);
    },
    async resumePurge(s, input) {
      const admitted = await owner(s);
      const op = id(input.operationId),
        expected = version(input.expectedVersion),
        jobId = id(input.jobId);
      const fp = await fingerprint(["resume", jobId, expected]);
      const saved = await replay(s.workspaceId, admitted.principalId, op, fp);
      if (saved) return saved;
      const r = await one("job", [s.workspaceId, jobId]);
      if (!r) throw new PlatformError("not_found", "Purge not found");
      const current = await job(r);
      if (current.version !== expected || current.state === "complete")
        throw new PlatformError("conflict", "Purge version conflict");
      const next = { ...current, version: expected + 1 };
      return commit(next, admitted.principalId, op, fp, [
        ...cas(current, current.state),
        ...audit(next, "PurgeResumed", admitted.principalId),
      ]);
    },
    async getPurgeStatus(s, input) {
      const r = await one("scopeJob", [id(s.workspaceId), scopeKey(input.projectId)]);
      try {
        await owner(s);
      } catch (error) {
        if (
          !(error instanceof PlatformError) ||
          !["not_found", "forbidden"].includes(error.code) ||
          !r
        )
          throw error;
        const current = await job(r);
        const accessStep = current.steps.find((step) => step.owner === "access");
        // The requesting human retains access to this receipt once membership is being erased.
        // Access validates principal provenance and OAuth/machine identity via me().
        const identity = (await access.me(s.principal)).principal;
        if (
          identity.kind !== "human" ||
          identity.id !== str(r, "requester_id") ||
          current.projectId !== null ||
          !accessStep ||
          !["purging", "purged"].includes(accessStep.state)
        )
          throw error;
      }
      return r ? job(r) : null;
    },
  };
  async function advance(row: Row) {
    const j = await job(row);
    const scope = {
      workspaceId: j.workspaceId,
      ...(j.projectId ? { projectId: j.projectId } : {}),
    };
    const step =
      j.state === "freezing"
        ? (j.steps.find((s) => s.state === "pending") ?? j.steps.find((s) => s.pending > 0))
        : j.steps.find((s) => s.state !== "purged");
    if (!step) {
      const state = j.state === "freezing" ? "purging" : "complete";
      await store.batch([
        ...cas(j, state),
        ...audit(
          { ...j, state, version: j.version + 1 },
          state === "complete" ? "PurgeCompleted" : "PurgeAdvanced",
          "scheduler",
        ),
      ]);
      return;
    }
    const name = order.find((o) => o === step.owner);
    if (!name) throw new PlatformError("unknown", "Unknown purge owner");
    let state: PurgeStep["state"] = step.state,
      remaining = step.remaining,
      pending = step.pending,
      error: string | null = null,
      sweepingUntil = step.sweepingUntil ?? null;
    // Persist purging before entering an owner. This also makes terminal receipt access
    // survive Access deletion followed by a crash before the acknowledgement is stored.
    if (j.state === "purging" && step.state === "frozen") {
      await store.batch([
        ...cas(j, j.state),
        {
          name: "saveStep",
          values: [
            "purging",
            remaining,
            pending,
            null,
            step.sweepingUntil ?? null,
            j.workspaceId,
            j.id,
            name,
          ],
        },
        ...audit({ ...j, version: j.version + 1 }, "PurgeAdvanced", "scheduler"),
      ]);
      return;
    }
    try {
      const maintenance = d.owners[name];
      const status =
        j.state === "freezing"
          ? await maintenance.freezeScope(scope)
          : await maintenance.purgeScope(scope);
      const observed = await maintenance.purgeStatus(scope);
      if (!status || !observed || observed.remaining < 0 || observed.pending < 0)
        throw new PlatformError("unknown", "Invalid maintenance acknowledgement");
      remaining = observed.remaining;
      pending = observed.pending;
      sweepingUntil =
        "sweepingUntil" in observed && typeof observed.sweepingUntil === "number"
          ? observed.sweepingUntil
          : null;
      state =
        j.state === "freezing"
          ? "frozen"
          : observed.state === "purged" && remaining === 0 && pending === 0
            ? "purged"
            : "purging";
    } catch {
      error = "Owner maintenance failed; automatic retry pending";
    }
    await store.batch([
      ...cas(j, j.state, error || pending ? clock.now() + 30 : 0),
      {
        name: "saveStep",
        values: [state, remaining, pending, error, sweepingUntil, j.workspaceId, j.id, name],
      },
      ...audit({ ...j, version: j.version + 1 }, "PurgeAdvanced", "scheduler"),
    ]);
  }
  return {
    api,
    background: {
      async tick(limit = 10) {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20)
          throw new PlatformError("validation", "Invalid job limit");
        const rows = (await store.run("due", [clock.now(), limit])).rows;
        for (const row of rows) {
          try {
            await advance(row);
          } catch (error) {
            // Racing ticks use CAS. A losing tick safely retries the idempotent owner call.
            if (!(error instanceof Error && /constraint failed/i.test(error.message))) throw error;
          }
        }
        return rows.length;
      },
    },
  };
}
