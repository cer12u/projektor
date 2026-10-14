import {
  type Call,
  type Clock,
  type IdGenerator,
  type ModuleStore,
  PlatformError,
  type Row,
  type ScopedBucket,
} from "../../../platform/public";
import type { AccessApi, RequestScope } from "../../access/public";
import type { IssuesApi } from "../../issues/public";
import type { ProjectsApi } from "../../projects/public";
import type { WikiApi } from "../../wiki/public";
import type {
  AssetEvent,
  AssetEventReader,
  AssetMetadata,
  AssetResult,
  AssetsApi,
  AssetsMaintenance,
  AssetTarget,
} from "../public";
import type { queries } from "../storage/queries";
import { createMaintenance } from "./maintenance";

type Name = keyof typeof queries;
type Statement = Call<Name>;
interface Dependencies {
  readonly store: ModuleStore<"assets", Name>;
  readonly bucketFor: (workspaceId: string) => ScopedBucket;
  readonly access: Pick<AccessApi, "authorize">;
  readonly projects: Pick<ProjectsApi, "authorizeProject">;
  readonly issues: Pick<IssuesApi, "authorizeIssue">;
  readonly wiki: Pick<WikiApi, "authorizePage">;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly eventConsumer?: string;
}
const MAX_SIZE = 10 * 1024 * 1024;
const EXPIRY = 24 * 60 * 60;
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
function number(r: Row, k: string): number {
  return typeof r[k] === "number" ? r[k] : fail("unknown", `Invalid ${k}`);
}
function string(r: Row, k: string): string {
  return typeof r[k] === "string" ? r[k] : fail("unknown", `Invalid ${k}`);
}
async function hash(v: ArrayBuffer | string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    typeof v === "string" ? new TextEncoder().encode(v) : v,
  );
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
export function createAssets(d: Dependencies): {
  api: AssetsApi;
  eventReader?: AssetEventReader;
  maintenance: AssetsMaintenance;
} {
  if (d.store.owner !== "assets") fail("forbidden", "Wrong Assets store");
  const { store, bucketFor, access, projects, issues, wiki, clock, ids } = d;
  const eventReader = d.eventConsumer ? (Object.freeze({}) as AssetEventReader) : undefined;
  const one = async (name: Name, values: Statement["values"]): Promise<Row | undefined> =>
    (await store.run(name, values)).rows[0];
  const w = (s: RequestScope) => id(s.workspaceId);
  const actor = (s: RequestScope) => id(s.principalId);
  const key = (workspaceId: string, assetId: string) => `assets/${id(workspaceId)}/${id(assetId)}`;
  const fingerprint = (action: string, values: unknown[]) =>
    hash(JSON.stringify([action, ...values]));
  const metadata = (r: Row): AssetMetadata => ({
    id: string(r, "id"),
    projectId: string(r, "project_id"),
    size: number(r, "size"),
    contentType: string(r, "content_type"),
    filename: string(r, "filename"),
    sha256: string(r, "sha256"),
    version: number(r, "version"),
    ready: r.state === "ready",
  });
  async function blob(
    scope: RequestScope,
    assetId: string,
    mode: "read" | "write" = "read",
  ): Promise<Row> {
    await access.authorize(scope, mode);
    const r = await one("blob", [w(scope), id(assetId)]);
    if (!r) fail("not_found", "Asset not found");
    await projects.authorizeProject(scope, string(r, "project_id"), mode);
    return r;
  }
  async function target(
    scope: RequestScope,
    t: AssetTarget,
    mode: "read" | "write" = "read",
  ): Promise<string> {
    id(t.id);
    if (t.kind === "issue") return (await issues.authorizeIssue(scope, t.id, mode)).projectId;
    if (t.kind === "wiki") return (await wiki.authorizePage(scope, t.id, mode)).projectId;
    fail("validation", "Invalid target");
  }
  async function replay(scope: RequestScope, op: string, fp: string): Promise<AssetResult | null> {
    const r = await one("readReceipt", [w(scope), actor(scope), id(op)]);
    if (!r) return null;
    if (string(r, "fingerprint") !== fp) fail("conflict", "Operation ID reused");
    return { id: string(r, "result_id"), version: number(r, "result_version") };
  }
  function guarded(scope: RequestScope, change: Statement): Statement[] {
    const g = ids.next();
    return [
      change,
      { name: "guard", values: [w(scope), g] },
      { name: "clearGuard", values: [w(scope), g] },
    ];
  }
  async function commit(
    scope: RequestScope,
    op: string,
    fp: string,
    assetId: string,
    next: number,
    action: AssetEvent["type"],
    calls: Statement[],
  ): Promise<AssetResult> {
    const ws = w(scope),
      at = clock.now();
    try {
      await store.batch([
        ...calls,
        { name: "history", values: [action, actor(scope), at, ws, assetId] },
        { name: "receipt", values: [ws, actor(scope), op, fp, ws, assetId] },
        {
          name: "event",
          values: [
            ws,
            ws,
            ids.next(),
            assetId,
            next,
            action,
            at,
            actor(scope),
            scope.clientId ?? null,
          ],
        },
      ]);
    } catch (e) {
      try {
        const saved = await replay(scope, op, fp);
        if (saved) return saved;
      } catch (recovery) {
        if (recovery instanceof PlatformError) throw recovery;
        fail("unknown", "Outcome unknown; retry operation ID");
      }
      if (e instanceof Error && /(?:CHECK|UNIQUE|FOREIGN KEY) constraint failed/i.test(e.message))
        fail("conflict", "Version or invariant conflict");
      fail("unknown", "Outcome unknown; retry operation ID");
    }
    const saved = await replay(scope, op, fp);
    if (!saved) fail("unknown", "Outcome unknown; retry operation ID");
    return saved;
  }
  const api: AssetsApi = {
    async beginUpload(scope, input) {
      const op = id(input.operationId),
        assetId = id(input.assetId),
        projectId = id(input.projectId);
      if (!Number.isSafeInteger(input.size) || input.size < 0 || input.size > MAX_SIZE)
        fail("validation", "Invalid size");
      if (
        typeof input.contentType !== "string" ||
        !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(input.contentType) ||
        input.contentType.length > 128
      )
        fail("validation", "Invalid content type");
      if (
        typeof input.filename !== "string" ||
        input.filename.length < 1 ||
        input.filename.length > 255 ||
        [...input.filename].some(
          (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || c === "/" || c === "\\",
        )
      )
        fail("validation", "Invalid filename");
      if (!/^[0-9a-f]{64}$/.test(input.sha256)) fail("validation", "Invalid SHA-256");
      await access.authorize(scope, "write");
      await projects.authorizeProject(scope, projectId, "write");
      const fp = await fingerprint("begin", [
        assetId,
        projectId,
        input.size,
        input.contentType,
        input.filename,
        input.sha256,
      ]);
      const saved = await replay(scope, op, fp);
      if (saved) return saved;
      return commit(scope, op, fp, assetId, 1, "AssetBegun", [
        ...guarded(scope, {
          name: "begin",
          values: [
            w(scope),
            assetId,
            projectId,
            input.size,
            input.contentType,
            input.filename,
            input.sha256,
            clock.now(),
          ],
        }),
        { name: "gcAdd", values: [w(scope), assetId, clock.now() + EXPIRY] },
      ]);
    },
    async putUpload(scope, assetId, body) {
      const r = await blob(scope, assetId, "write");
      if (r.state !== "pending") fail("conflict", "Upload closed");
      if (body.byteLength > MAX_SIZE) fail("validation", "Upload too large");
      if (body.byteLength !== number(r, "size") || (await hash(body)) !== string(r, "sha256"))
        fail("validation", "Size or hash mismatch");
      const attempt = ids.next();
      const admitted = await store.run("uploadStart", [w(scope), attempt, w(scope), assetId]);
      if (admitted.changes !== 1) fail("conflict", "Upload closed");
      // Freeze waits for admitted uploads; a write crossing freeze is compensated.
      try {
        await bucketFor(w(scope)).put(key(w(scope), assetId), body);
        const frozen = await one("uploadFrozen", [w(scope), string(r, "project_id")]);
        if (frozen) {
          try {
            await bucketFor(w(scope)).delete(key(w(scope), assetId));
          } catch {
            /* GC tombstone retries. */
          }
          fail("conflict", "Scope frozen");
        }
      } finally {
        await store.run("uploadFinish", [w(scope), attempt]);
      }
    },
    async completeUpload(scope, input) {
      const op = id(input.operationId),
        assetId = id(input.assetId),
        expected = version(input.expectedVersion);
      await access.authorize(scope, "write");
      const fp = await fingerprint("complete", [assetId, expected]);
      const saved = await replay(scope, op, fp);
      if (saved) return saved;
      const r = await blob(scope, assetId, "write");
      if (r.state !== "pending" || number(r, "version") !== expected)
        fail("conflict", "Upload version conflict");
      const object = await bucketFor(w(scope)).get(key(w(scope), assetId));
      if (
        !object ||
        object.byteLength !== number(r, "size") ||
        (await hash(object)) !== string(r, "sha256")
      )
        fail("validation", "Stored object size or hash mismatch");
      return commit(scope, op, fp, assetId, expected + 1, "AssetCompleted", [
        ...guarded(scope, { name: "complete", values: [w(scope), assetId, expected] }),
      ]);
    },
    async linkAsset(scope, input) {
      const op = id(input.operationId),
        assetId = id(input.assetId),
        linkId = id(input.linkId),
        expected = version(input.expectedVersion);
      await access.authorize(scope, "write");
      const fp = await fingerprint("link", [assetId, expected, linkId, input.target]);
      const saved = await replay(scope, op, fp);
      if (saved) return saved;
      const r = await blob(scope, assetId, "write");
      const projectId = await target(scope, input.target, "write");
      if (projectId !== string(r, "project_id"))
        fail("forbidden", "Target belongs to another project");
      if (r.state !== "ready") fail("conflict", "Asset unavailable");
      return commit(scope, op, fp, assetId, expected + 1, "AssetLinked", [
        ...guarded(scope, { name: "bump", values: [w(scope), assetId, expected] }),
        {
          name: "insertLink",
          values: [w(scope), linkId, assetId, input.target.kind, input.target.id],
        },
        { name: "gcRemove", values: [w(scope), assetId] },
      ]);
    },
    async unlinkAsset(scope, input) {
      const op = id(input.operationId),
        assetId = id(input.assetId),
        linkId = id(input.linkId),
        expected = version(input.expectedVersion);
      await access.authorize(scope, "write");
      const fp = await fingerprint("unlink", [assetId, expected, linkId]);
      const saved = await replay(scope, op, fp);
      if (saved) return saved;
      const r = await blob(scope, assetId, "write");
      const link = await one("link", [w(scope), linkId, assetId]);
      if (!link) fail("not_found", "Link not found");
      await target(
        scope,
        { kind: string(link, "target_kind") as AssetTarget["kind"], id: string(link, "target_id") },
        "write",
      );
      if (r.state !== "ready") fail("conflict", "Asset unavailable");
      return commit(scope, op, fp, assetId, expected + 1, "AssetUnlinked", [
        ...guarded(scope, { name: "bump", values: [w(scope), assetId, expected] }),
        ...guarded(scope, { name: "deleteLink", values: [w(scope), linkId, assetId] }),
        { name: "retire", values: [w(scope), assetId, w(scope), assetId] },
        { name: "gcAdd", values: [w(scope), assetId, clock.now()] },
      ]);
    },
    async getMetadata(scope, assetId) {
      return metadata(await blob(scope, assetId));
    },
    async listAssets(scope, t, cursor = "", limit = 50) {
      await access.authorize(scope, "read");
      await target(scope, t);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        fail("validation", "Invalid limit");
      const rows = (
        await store.run("list", [w(scope), t.kind, t.id, cursor ? id(cursor) : "", limit + 1])
      ).rows;
      return {
        items: rows.slice(0, limit).map((r) => ({
          id: string(r, "id"),
          assetId: string(r, "asset_id"),
          filename: string(r, "filename"),
          target: {
            kind: string(r, "target_kind") as AssetTarget["kind"],
            id: string(r, "target_id"),
          },
        })),
        nextCursor: rows.length > limit ? string(rows[limit - 1], "id") : null,
      };
    },
    async downloadAsset(scope, assetId) {
      const r = await blob(scope, assetId);
      if (r.state !== "ready") fail("not_found", "Asset unavailable");
      let visible = false;
      let cursor = "";
      for (;;) {
        const links = (await store.run("linksForBlob", [w(scope), assetId, cursor, 100])).rows;
        for (const link of links) {
          try {
            await target(scope, {
              kind: string(link, "target_kind") as AssetTarget["kind"],
              id: string(link, "target_id"),
            });
            visible = true;
            break;
          } catch (e) {
            if (!(e instanceof PlatformError) || !["forbidden", "not_found"].includes(e.code))
              throw e;
          }
        }
        if (visible || links.length < 100) break;
        cursor = string(links[links.length - 1], "id");
      }
      if (!visible) fail("forbidden", "No visible link");
      const body = await bucketFor(w(scope)).open(key(w(scope), assetId));
      if (!body) fail("not_found", "Object missing");
      return { metadata: metadata(r), body };
    },
    async readOperation(scope, operationId) {
      await access.authorize(scope);
      const r = await one("readReceipt", [w(scope), actor(scope), id(operationId)]);
      return r ? { id: string(r, "result_id"), version: number(r, "result_version") } : null;
    },
    async readEvents(reader, workspaceId, cursor, limit) {
      if (reader !== eventReader || !eventReader) fail("forbidden", "Invalid event reader");
      if (
        !Number.isSafeInteger(cursor) ||
        cursor < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        fail("validation", "Invalid page");
      return (await store.run("events", [id(workspaceId), cursor, limit])).rows.map((r) => ({
        eventId: string(r, "event_id"),
        projectId: r.project_id === null ? null : string(r, "project_id"),
        source: "assets" as const,
        schemaVersion: number(r, "schema_version") as 1 | 2,
        workspaceId,
        aggregateId: string(r, "aggregate_id"),
        aggregateVersion: number(r, "aggregate_version"),
        type: string(r, "type") as AssetEvent["type"],
        occurredAt: number(r, "occurred_at"),
        payload: {
          actorId: string(r, "actor_id"),
          clientId: r.client_id === null ? null : string(r, "client_id"),
        },
        cursor: number(r, "sequence"),
      }));
    },
    async drainGc(limit = 50) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        fail("validation", "Invalid limit");
      const jobs = (await store.run("gcDue", [clock.now(), limit])).rows;
      let done = 0;
      for (const job of jobs) {
        const ws = string(job, "workspace_id"),
          assetId = string(job, "asset_id");
        const r = await one("blob", [ws, assetId]);
        if (!r) {
          await store.run("gcRemove", [ws, assetId]);
          done++;
          continue;
        }
        if (
          (await one("uploadFrozen", [ws, string(r, "project_id")])) ||
          Number(
            (
              await one("maintenancePending", [
                ws,
                string(r, "project_id"),
                string(r, "project_id"),
              ])
            )?.n ?? 0,
          ) > 0
        )
          continue;
        // Close pending uploads too: completion/link must not race the R2 deletion.
        await store.run("retire", [ws, assetId, ws, assetId]);
        const current = await one("blob", [ws, assetId]);
        if (current?.state === "ready") {
          await store.run("gcRemove", [ws, assetId]);
          done++;
          continue;
        }
        await bucketFor(ws).delete(key(ws, assetId));
        await store.batch([
          { name: "gcDeleteHistory", values: [ws, assetId] },
          { name: "gcRemove", values: [ws, assetId] },
          { name: "gcDeleteBlob", values: [ws, assetId, ws, assetId] },
        ]);
        done++;
      }
      const tombstones = (await store.run("tombstoneDue", [limit])).rows;
      for (const row of tombstones) {
        const ws = string(row, "workspace_id"),
          objectKey = string(row, "object_key");
        if (clock.now() < number(row, "sweep_until")) await bucketFor(ws).delete(objectKey);
        else await store.run("tombstoneRemove", [ws, objectKey]);
        done++;
      }
      const scopes = (await store.run("workspaceSweeps", [clock.now(), limit])).rows;
      for (const row of scopes) {
        const ws = string(row, "workspace_id"),
          bucket = bucketFor(ws);
        const prefix = `assets/${ws}/`;
        const page = await bucket.list(prefix, undefined, limit);
        for (const objectKey of page.keys) {
          await bucket.delete(objectKey);
          done++;
        }
      }
      return done;
    },
  };
  return { api, eventReader, maintenance: createMaintenance(store, bucketFor, clock) };
}
