import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

let platform,
  mf,
  serial = 0;
const error = (code) => (e) => e.code === code;
const bytes = (text) => new TextEncoder().encode(text).buffer;
const hash = async (value) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", value)), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
before(async () => {
  fs.mkdirSync(".tmp", { recursive: true });
  const result = await build({
    entryPoints: ["tools/assets-test-entry.ts"],
    outfile: ".tmp/test-entry.mjs",
    bundle: true,
    format: "esm",
    platform: "node",
    metafile: true,
  });
  assert(
    Object.keys(result.metafile.inputs).every(
      (p) => !p.startsWith("modules/issues/internal/") && !p.startsWith("modules/wiki/internal/"),
    ),
  );
  platform = await import("../.tmp/test-entry.mjs");
  mf = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('ok')}}",
    compatibilityDate: "2026-07-30",
    d1Databases: Array.from({ length: 16 }, (_, i) => `ASSETS${i}`),
    r2Buckets: ["R2"],
  });
});
after(async () => mf?.dispose());
async function fixture() {
  const db = await mf.getD1Database(`ASSETS${serial++}`);
  await platform.migrate(db, ["assets"]);
  const raw = await mf.getR2Bucket("R2"),
    bucket = platform.createScopedBucket(raw, "assets", "w1");
  const access = platform.fakeAccess();
  let now = 1000,
    fault = null,
    batchFault = null;
  const scope = (ws = "w1", principal = "a") =>
    access.issue({
      id: principal,
      workspaceId: ws,
      kind: "machine",
      role: "member",
      scope: "write",
      active: true,
    });
  const denied = new Set();
  const projects = {
    async authorizeProject(s, p, permission = "read") {
      await access.access.authorize(s, permission);
      if (denied.has(`${s.workspaceId}:${p}`))
        throw new platform.PlatformError("forbidden", "project denied");
      return { id: p };
    },
  };
  const issues = {
    async authorizeIssue(s, i, permission = "read") {
      await projects.authorizeProject(s, "p1", permission);
      if (i !== "i1") throw new platform.PlatformError("not_found", "issue");
      return { id: i, projectId: "p1" };
    },
  };
  const wiki = {
    async authorizePage(s, i, permission = "read") {
      await projects.authorizeProject(s, "p1", permission);
      if (i !== "page1") throw new platform.PlatformError("not_found", "page");
      return { id: i, projectId: "p1" };
    },
  };
  const store = platform.createModuleStore(db, "assets");
  const deps = {
    store: {
      ...store,
      batch: async (calls) => {
        if (batchFault) {
          const f = batchFault;
          batchFault = null;
          throw f;
        }
        return store.batch(calls);
      },
    },
    bucketFor: (workspaceId) => {
      const scoped = platform.createScopedBucket(raw, "assets", workspaceId);
      return {
        get: (key) => scoped.get(key),
        open: (key) => scoped.open(key),
        put: async (k, v) => {
          if (fault?.kind === "put") {
            fault = null;
            throw Error("R2 put fault");
          }
          return scoped.put(k, v);
        },
        delete: async (k) => {
          if (fault?.kind === "delete") {
            fault = null;
            throw Error("R2 delete fault");
          }
          return scoped.delete(k);
        },
      };
    },
    access: access.access,
    projects,
    issues,
    wiki,
    clock: { now: () => now },
    ids: { next: () => crypto.randomUUID() },
    eventConsumer: "test",
  };
  const { api, eventReader } = platform.createAssets(deps);
  const input = async (assetId = "b1", operationId = "begin") => ({
    assetId,
    operationId,
    projectId: "p1",
    size: bytes("hello").byteLength,
    contentType: "text/plain",
    filename: "log.txt",
    sha256: await hash(bytes("hello")),
  });
  return {
    db,
    raw,
    bucket,
    api,
    eventReader,
    scope,
    input,
    denied,
    revoke: access.revoke,
    setNow: (n) => (now = n),
    failR2: (kind) => (fault = { kind }),
    failBatch: (e) => (batchFault = e),
  };
}
async function completed(f, s) {
  const x = await f.input();
  await f.api.beginUpload(s, x);
  await f.api.putUpload(s, "b1", bytes("hello"));
  await f.api.completeUpload(s, { operationId: "complete", assetId: "b1", expectedVersion: 1 });
}
test("begin, R2 verification, link, list and download across two tenants", async () => {
  const f = await fixture(),
    a = f.scope(),
    b = f.scope("w2");
  await completed(f, a);
  await assert.rejects(f.api.downloadAsset(a, "b1"), error("forbidden"));
  const r = await f.api.linkAsset(a, {
    operationId: "link",
    assetId: "b1",
    expectedVersion: 2,
    linkId: "l1",
    target: { kind: "issue", id: "i1" },
  });
  assert.deepEqual(r, { id: "b1", version: 3 });
  assert.equal((await f.api.listAssets(a, { kind: "issue", id: "i1" })).items.length, 1);
  const stream = (await f.api.downloadAsset(a, "b1")).body;
  assert.equal(new TextDecoder().decode(await stream.read()), "hello");
  assert.equal(await stream.read(), null);
  assert.deepEqual(await f.api.readOperation(a, "link"), r);
  assert.deepEqual(
    await f.api.linkAsset(a, {
      operationId: "link",
      assetId: "b1",
      expectedVersion: 2,
      linkId: "l1",
      target: { kind: "issue", id: "i1" },
    }),
    r,
  );
  await assert.rejects(f.api.getMetadata(b, "b1"), error("not_found"));
  await assert.rejects(
    f.api.linkAsset(b, {
      operationId: "x",
      assetId: "b1",
      expectedVersion: 3,
      linkId: "l2",
      target: { kind: "wiki", id: "page1" },
    }),
    error("not_found"),
  );
  assert.equal((await f.api.readEvents(f.eventReader, "w1", 0, 10)).length, 3);
});
test("stored bytes are checked, R2 put failure remains recoverable", async () => {
  const f = await fixture(),
    s = f.scope();
  await f.api.beginUpload(s, await f.input());
  f.failR2("put");
  await assert.rejects(f.api.putUpload(s, "b1", bytes("hello")));
  await f.raw.put("assets/w1/b1", bytes("wrong!"));
  await assert.rejects(
    f.api.completeUpload(s, { operationId: "complete", assetId: "b1", expectedVersion: 1 }),
    error("validation"),
  );
  await f.raw.put("assets/w1/b1", bytes("wrong"));
  await assert.rejects(
    f.api.completeUpload(s, { operationId: "complete", assetId: "b1", expectedVersion: 1 }),
    error("validation"),
  );
  await f.raw.put("assets/w1/b1", bytes("hello"));
  f.failBatch(Error("D1 failed"));
  await assert.rejects(
    f.api.completeUpload(s, { operationId: "complete", assetId: "b1", expectedVersion: 1 }),
    error("unknown"),
  );
  assert.equal((await f.db.prepare("SELECT count(*) n FROM assets_gc_jobs").first()).n, 1);
  assert.equal(
    (await f.api.completeUpload(s, { operationId: "complete", assetId: "b1", expectedVersion: 1 }))
      .version,
    2,
  );
});
test("stale version rolls back and response loss replays receipt", async () => {
  const f = await fixture(),
    s = f.scope();
  await completed(f, s);
  await assert.rejects(
    f.api.linkAsset(s, {
      operationId: "stale",
      assetId: "b1",
      expectedVersion: 1,
      linkId: "l1",
      target: { kind: "issue", id: "i1" },
    }),
    error("conflict"),
  );
  assert.equal(await f.api.readOperation(s, "stale"), null);
  const r = await f.api.linkAsset(s, {
    operationId: "good",
    assetId: "b1",
    expectedVersion: 2,
    linkId: "l1",
    target: { kind: "issue", id: "i1" },
  });
  assert.deepEqual(
    await f.api.linkAsset(s, {
      operationId: "good",
      assetId: "b1",
      expectedVersion: 2,
      linkId: "l1",
      target: { kind: "issue", id: "i1" },
    }),
    r,
  );
  await assert.rejects(
    f.api.linkAsset(s, {
      operationId: "good",
      assetId: "b1",
      expectedVersion: 2,
      linkId: "l2",
      target: { kind: "issue", id: "i1" },
    }),
    error("conflict"),
  );
  assert.equal((await f.db.prepare("SELECT count(*) n FROM assets_links").first()).n, 1);
});
test("archive or membership revoke refuses download", async () => {
  const f = await fixture(),
    s = f.scope();
  await completed(f, s);
  await f.api.linkAsset(s, {
    operationId: "link",
    assetId: "b1",
    expectedVersion: 2,
    linkId: "l1",
    target: { kind: "issue", id: "i1" },
  });
  f.denied.add("w1:p1");
  await assert.rejects(f.api.downloadAsset(s, "b1"), error("forbidden"));
  f.denied.clear();
  f.revoke(s);
  await assert.rejects(f.api.downloadAsset(s, "b1"), error("forbidden"));
});
test("unlink schedules GC; delete and D1 faults retain recoverable job", async () => {
  const f = await fixture(),
    s = f.scope();
  await completed(f, s);
  await f.api.linkAsset(s, {
    operationId: "link",
    assetId: "b1",
    expectedVersion: 2,
    linkId: "l1",
    target: { kind: "issue", id: "i1" },
  });
  const r = await f.api.unlinkAsset(s, {
    operationId: "unlink",
    assetId: "b1",
    expectedVersion: 3,
    linkId: "l1",
  });
  assert.equal(r.version, 4);
  assert.deepEqual(
    await f.api.unlinkAsset(s, {
      operationId: "unlink",
      assetId: "b1",
      expectedVersion: 3,
      linkId: "l1",
    }),
    r,
  );
  await assert.rejects(f.api.downloadAsset(s, "b1"), error("not_found"));
  f.failR2("delete");
  await assert.rejects(f.api.drainGc());
  assert.equal((await f.db.prepare("SELECT count(*) n FROM assets_gc_jobs").first()).n, 1);
  f.failBatch(Error("D1 failed"));
  await assert.rejects(f.api.drainGc());
  assert.equal((await f.db.prepare("SELECT count(*) n FROM assets_gc_jobs").first()).n, 1);
  assert.equal(await f.api.drainGc(), 1);
  assert.equal(await f.bucket.get("assets/w1/b1"), null);
  assert.equal((await f.db.prepare("SELECT count(*) n FROM assets_gc_jobs").first()).n, 0);
});
test("unfinished upload expires; R2 adapter rejects cross-workspace and foreign prefix", async () => {
  const f = await fixture(),
    s = f.scope();
  await f.api.beginUpload(s, await f.input());
  await f.api.putUpload(s, "b1", bytes("hello"));
  assert.equal(await f.api.drainGc(), 0);
  f.setNow(1000 + 86400);
  assert.equal(await f.api.drainGc(), 1);
  await assert.rejects(f.bucket.get("assets/w2/b1"), error("forbidden"));
  await assert.rejects(f.bucket.get("assets/w1/bad/nested"), error("forbidden"));
  await assert.rejects(f.bucket.get("foreign/b1"), error("forbidden"));
  await assert.rejects(f.bucket.put("assets/w2/b1", bytes("hello")), error("forbidden"));
  await assert.rejects(f.bucket.put("foreign/b1", bytes("hello")), error("forbidden"));
  await assert.rejects(f.bucket.delete("assets/w2/b1"), error("forbidden"));
  await assert.rejects(f.bucket.delete("foreign/b1"), error("forbidden"));
});
test("completed but never linked object expires without an orphan", async () => {
  const f = await fixture();
  const s = f.scope();
  await completed(f, s);
  assert.equal((await f.db.prepare("SELECT count(*) n FROM assets_gc_jobs").first()).n, 1);
  f.setNow(1000 + 86400);
  assert.equal(await f.api.drainGc(), 1);
  assert.equal(await f.bucket.get("assets/w1/b1"), null);
  await assert.rejects(f.api.getMetadata(s, "b1"), error("not_found"));
  assert.equal((await f.db.prepare("SELECT count(*) n FROM assets_gc_jobs").first()).n, 0);
});
