import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

let p,
  mf,
  serial = 0;
before(async () => {
  fs.mkdirSync(".tmp", { recursive: true });
  await build({
    entryPoints: ["tools/lifecycle-test-entry.ts"],
    outfile: ".tmp/test-entry.mjs",
    bundle: true,
    format: "esm",
    platform: "node",
  });
  p = await import("../.tmp/test-entry.mjs");
  mf = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('ok')}}",
    compatibilityDate: "2026-07-30",
    d1Databases: ["A0", "A1", "A2", "A3", "A4"],
    r2Buckets: ["R2"],
  });
});
after(async () => mf?.dispose());
async function fixture() {
  const n = serial++,
    db = await mf.getD1Database(`A${n}`);
  await p.migrate(db, ["assets"]);
  const raw = await mf.getR2Bucket("R2"),
    store = p.createModuleStore(db, "assets");
  const ws = `w${n}`;
  let count = 0,
    now = 100,
    hook,
    fault;
  const make = () =>
    p.createAssets({
      store: {
        ...store,
        async batch(calls) {
          if (hook) {
            const f = hook;
            hook = null;
            await f();
          }
          return store.batch(calls);
        },
      },
      access: {
        async authorize(s) {
          return s;
        },
      },
      projects: {
        async authorizeProject(_s, id) {
          return { id };
        },
      },
      issues: {},
      wiki: {},
      clock: { now: () => now },
      ids: { next: () => `a${++count}` },
      bucketFor: (workspace) => {
        const b = p.createScopedBucket(raw, "assets", workspace);
        return {
          ...b,
          async delete(key) {
            if (fault) {
              fault = false;
              throw Error("R2 unavailable");
            }
            return b.delete(key);
          },
        };
      },
    });
  const scope = { workspaceId: ws, principalId: "human", kind: "human", role: "owner" };
  const bytes = new TextEncoder().encode("hello").buffer;
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const begin = (assetId, projectId = "p1", workspaceId = ws) =>
    make().api.beginUpload(
      { ...scope, workspaceId },
      {
        operationId: assetId,
        assetId,
        projectId,
        size: 5,
        contentType: "text/plain",
        filename: "test.txt",
        sha256,
      },
    );
  return {
    db,
    store,
    ws,
    raw,
    scope,
    bytes,
    begin,
    make,
    setHook: (f) => {
      hook = f;
    },
    setFault: () => {
      fault = true;
    },
    setNow: (value) => {
      now = value;
    },
  };
}
async function finish(f, scope) {
  for (let i = 0; i < 50; i++) {
    const s = await f.make().maintenance.purgeScope(scope);
    if (s.state === "purged") return s;
  }
  assert.fail("Assets purge did not complete");
}
test("Assets freezes delayed admitted writes, rejects uploads, and deletes R2 via retryable GC before purged", async () => {
  const f = await fixture();
  await f.begin("one");
  await f.make().api.putUpload(f.scope, "one", f.bytes);
  await f.begin("safe", "p2");
  await f.make().api.putUpload(f.scope, "safe", f.bytes);
  await f.begin("other", "p1", "other");
  await f.make().api.putUpload({ ...f.scope, workspaceId: "other" }, "other", f.bytes);
  let entered, release;
  const at = new Promise((r) => {
      entered = r;
    }),
    gate = new Promise((r) => {
      release = r;
    });
  f.setHook(async () => {
    entered();
    await gate;
  });
  const delayed = f.begin("late");
  await at;
  const scope = { workspaceId: f.ws, projectId: "p1" };
  await f.make().maintenance.freezeScope(scope);
  release();
  await assert.rejects(delayed, (e) => e.code === "conflict");
  await assert.rejects(f.make().api.putUpload(f.scope, "one", f.bytes), /scope frozen/);
  assert.equal((await f.store.run("readReceipt", [f.ws, "human", "late"])).rows.length, 0);
  f.setFault();
  await assert.rejects(f.make().maintenance.purgeScope(scope), /R2 unavailable/);
  assert.equal((await f.make().maintenance.purgeStatus(scope)).state, "purging");
  assert(await f.raw.get(`assets/${f.ws}/one`));
  assert((await f.store.run("gcJob", [f.ws, "one"])).rows.length === 1);
  await finish(f, scope);
  assert.equal(await f.raw.get(`assets/${f.ws}/one`), null);
  assert(await f.raw.get(`assets/${f.ws}/safe`));
  assert(await f.raw.get("assets/other/other"));
  assert.equal((await f.make().maintenance.purgeScope(scope)).state, "purged");
  await assert.rejects(f.begin("resurrection"), (e) => e.code === "conflict");
});
test("Assets bounded purge keeps parents until all children are deleted", async () => {
  const f = await fixture();
  await f.begin("many");
  for (let i = 0; i < 55; i++)
    await f.db
      .prepare(
        "INSERT INTO assets_history(workspace_id,asset_id,version,action,actor_id,occurred_at) VALUES(?,?,?,'test','human',1)",
      )
      .bind(f.ws, "many", i + 2)
      .run();
  const scope = { workspaceId: f.ws };
  await f.make().maintenance.freezeScope(scope);
  const first = await f.make().maintenance.purgeScope(scope);
  assert(first.remaining > 0);
  assert.equal(first.state, "purging");
  await finish(f, scope);
  assert.equal((await f.store.run("blob", [f.ws, "many"])).rows.length, 0);
});
test("an active R2 upload prevents freeze acknowledgement until compensation finishes", async () => {
  const f = await fixture();
  await f.begin("active");
  let entered, release;
  const at = new Promise((r) => {
      entered = r;
    }),
    gate = new Promise((r) => {
      release = r;
    });
  const bucket = p.createScopedBucket(f.raw, "assets", f.ws);
  const module = p.createAssets({
    store: f.store,
    access: {
      async authorize(s) {
        return s;
      },
    },
    projects: {
      async authorizeProject(_s, id) {
        return { id };
      },
    },
    issues: {},
    wiki: {},
    clock: { now: () => 1 },
    ids: { next: () => "attempt" },
    bucketFor: () => ({
      ...bucket,
      async put(k, v) {
        entered();
        await gate;
        return bucket.put(k, v);
      },
    }),
  });
  const upload = module.api.putUpload(f.scope, "active", f.bytes);
  await at;
  const scope = { workspaceId: f.ws };
  assert.equal((await module.maintenance.freezeScope(scope)).pending, 1);
  assert.equal((await module.maintenance.purgeScope(scope)).state, "purged");
  release();
  await assert.rejects(upload, (e) => e.code === "conflict");
  assert.equal(await f.raw.get(`assets/${f.ws}/active`), null);
  assert.equal((await module.maintenance.purgeStatus(scope)).pending, 0);
  await finish(f, scope);
});

test("unresolved admission is tombstoned, retried by GC, then expires", async () => {
  const f = await fixture();
  await f.begin("unknown");
  await f.raw.put(`assets/${f.ws}/unknown`, f.bytes);
  await f.store.run("uploadStart", [f.ws, "crashed", f.ws, "unknown"]);
  const scope = { workspaceId: f.ws, projectId: "p1" };
  await f.make().maintenance.freezeScope(scope);
  f.setFault();
  await assert.rejects(f.make().maintenance.purgeScope(scope), /R2 unavailable/);
  assert.equal((await f.make().maintenance.purgeStatus(scope)).pending, 1);
  const result = await finish(f, scope);
  assert.equal(result.sweepingUntil, 100 + 7 * 86400);
  assert.equal(await f.raw.get(`assets/${f.ws}/unknown`), null);
  assert.equal((await f.store.run("tombstoneDue", [10])).rows.length, 1);
  await f.raw.put(`assets/${f.ws}/unknown`, f.bytes);
  await f.make().api.drainGc();
  assert.equal(await f.raw.get(`assets/${f.ws}/unknown`), null);
  f.setNow(result.sweepingUntil);
  await f.make().api.drainGc();
  assert.equal((await f.store.run("tombstoneDue", [10])).rows.length, 0);
});

test("workspace sweep removes stray objects only in purged workspace", async () => {
  const f = await fixture();
  const scope = { workspaceId: f.ws };
  await f.make().maintenance.freezeScope(scope);
  await finish(f, scope);
  await f.raw.put(`assets/${f.ws}/stray`, f.bytes);
  await f.raw.put(`assets/other/keep`, f.bytes);
  await f.make().api.drainGc();
  assert.equal(await f.raw.get(`assets/${f.ws}/stray`), null);
  assert(await f.raw.get("assets/other/keep"));
});
