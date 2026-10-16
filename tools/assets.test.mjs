import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { assetsProviderContract } from "./assets-provider-contract.mjs";

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
    d1Databases: Array.from({ length: 48 }, (_, i) => `ASSETS${i}`),
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
    batchFault = null,
    beforeDelete = null;
  const scope = (ws = "w1", principal = "a", options = {}) =>
    access.issue({
      id: principal,
      workspaceId: ws,
      kind: "machine",
      role: "member",
      scope: "write",
      active: true,
      ...options,
    });
  const denied = new Set();
  const projects = {
    async authorizeProject(s, p, permission = "read") {
      await access.access.authorize(s, permission);
      if (denied.has(`${s.workspaceId}:${p}`) || (s.principalId === "outsider" && p === "p1"))
        throw new platform.PlatformError("forbidden", "project denied");
      if (!["p1", "p2"].includes(p)) throw new platform.PlatformError("not_found", "project");
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
          if (beforeDelete) {
            const hook = beforeDelete;
            beforeDelete = null;
            await hook();
          }
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
    providers: { access: access.access, projects, issues, wiki },
    restart: () => platform.createAssets(deps).api,
    setNow: (n) => (now = n),
    beforeDelete: (hook) => (beforeDelete = hook),
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
test("URL assets use one command, preserve receipt and never create an R2 object", async () => {
  const f = await fixture(),
    a = f.scope(),
    b = f.scope("w2");
  const input = {
    operationId: "url-op",
    assetId: "url1",
    url: "https://example.test/doc",
    title: "Doc",
    target: { kind: "issue", id: "i1" },
  };
  await assert.rejects(
    f.api.createLinkAsset(a, { ...input, url: "javascript:alert(1)" }),
    error("validation"),
  );
  assert.deepEqual(await f.api.createLinkAsset(a, input), { id: "url1", version: 1 });
  assert.deepEqual(await f.api.createLinkAsset(a, input), { id: "url1", version: 1 });
  await assert.rejects(f.api.createLinkAsset(a, { ...input, title: "Other" }), error("conflict"));
  const list = await f.api.listAssets(a, input.target);
  assert.equal(list.items[0].kind, "link");
  assert.equal(list.items[0].url, input.url);
  assert.equal((await f.api.downloadAsset(a, "url1")).body, null);
  assert.equal(await f.bucket.get("assets/w1/url1"), null);
  assert.equal((await f.api.listAssets(b, input.target)).items.length, 0);
  await f.api.unlinkAsset(a, {
    operationId: "unlink-url",
    assetId: "url1",
    linkId: "url1",
    expectedVersion: 1,
  });
  await f.api.drainGc();
  assert.equal(
    (await f.db.prepare("SELECT COUNT(*) n FROM assets_blobs WHERE id='url1'").first()).n,
    0,
  );
});
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
  assert.equal((await f.api.getLink(a, "l1")).assetId, "b1");
  await assert.rejects(f.api.getLink(b, "l1"), error("not_found"));
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

async function linked(f, s) {
  await completed(f, s);
  await f.api.linkAsset(s, {
    operationId: "link",
    assetId: "b1",
    expectedVersion: 2,
    linkId: "l1",
    target: { kind: "issue", id: "i1" },
  });
}
async function snapshot(f) {
  const tables = ["blobs", "links", "gc_jobs", "history", "receipts", "events", "guards"];
  const rows = [];
  for (const table of tables)
    rows.push((await f.db.prepare(`SELECT * FROM assets_${table} ORDER BY rowid`).all()).results);
  return rows;
}

test("09a R2 every method rejects foreign owner/workspace, dot and slash keys before touching storage", async () => {
  const f = await fixture();
  const forbidden = [
    "assets/w2/b1",
    "otherx/w1/b1",
    "assets/w1/..",
    "assets/w1/a..b",
    "assets/w1/a/b",
    "assets/w1/",
    "assets/w1//",
  ];
  for (const key of forbidden) {
    await f.raw.put(key, bytes("private"));
    for (const method of ["get", "open", "put", "delete"])
      await assert.rejects(
        f.bucket[method](key, bytes("overwrite")),
        error("forbidden"),
        `${method}: ${key}`,
      );
    assert.equal(await (await f.raw.get(key)).text(), "private");
  }
  await f.bucket.put("assets/w1/valid-key_1", bytes("valid"));
  assert.equal(new TextDecoder().decode(await f.bucket.get("assets/w1/valid-key_1")), "valid");
  const stream = await f.bucket.open("assets/w1/valid-key_1");
  assert.equal(new TextDecoder().decode(await stream.read()), "valid");
  await stream.cancel();
  await f.bucket.delete("assets/w1/valid-key_1");
  assert.equal(await f.bucket.get("assets/w1/valid-key_1"), null);
});

for (const defect of ["size", "sha256", "missing"]) {
  test(`09a complete independently rejects ${defect} without metadata, receipt or event change`, async () => {
    const f = await fixture(),
      s = f.scope();
    const input = await f.input();
    // Match the digest while deliberately contradicting the declared size.
    if (defect === "size") input.size = 4;
    await f.api.beginUpload(s, input);
    await f.raw.delete("assets/w1/b1");
    if (defect !== "missing")
      await f.raw.put("assets/w1/b1", bytes(defect === "sha256" ? "wrong" : "hello"));
    const before = await snapshot(f);
    await assert.rejects(
      f.api.completeUpload(s, { operationId: "complete", assetId: "b1", expectedVersion: 1 }),
      error("validation"),
    );
    assert.deepEqual(await snapshot(f), before);
  });
}

test("09a download checks the live project and target at R2 open, including other-project viewer", async () => {
  const f = await fixture(),
    s = f.scope();
  await linked(f, s);
  const outsider = f.scope("w1", "outsider", { role: "viewer", scope: "read" });
  await f.providers.projects.authorizeProject(outsider, "p2");
  await assert.rejects(f.api.downloadAsset(outsider, "b1"), error("forbidden"));
  // Metadata lookup is intentionally insufficient authority to open the stream.
  assert.equal((await f.api.getMetadata(s, "b1")).ready, true);
  f.providers.issues.authorizeIssue = async () => {
    throw new platform.PlatformError("not_found", "target archived");
  };
  await assert.rejects(f.api.downloadAsset(s, "b1"), error("forbidden"));
});

for (const method of ["beginUpload", "completeUpload", "linkAsset", "unlinkAsset"]) {
  test(`09a ${method} retry binds every input and replays one durable result after restart`, async () => {
    const f = await fixture(),
      s = f.scope();
    const inputs = {
      beginUpload: await f.input(),
      completeUpload: { operationId: "complete", assetId: "b1", expectedVersion: 1 },
      linkAsset: {
        operationId: "link",
        assetId: "b1",
        expectedVersion: 2,
        linkId: "l1",
        target: { kind: "issue", id: "i1" },
      },
      unlinkAsset: { operationId: "unlink", assetId: "b1", expectedVersion: 3, linkId: "l1" },
    };
    if (method === "completeUpload") {
      await f.api.beginUpload(s, await f.input());
      await f.api.putUpload(s, "b1", bytes("hello"));
    } else if (method === "linkAsset") await completed(f, s);
    else if (method === "unlinkAsset") await linked(f, s);
    const input = inputs[method];
    const result = await f.api[method](s, input),
      before = await snapshot(f);
    const restarted = f.restart();
    assert.deepEqual(await restarted[method](s, input), result);
    assert.deepEqual(await restarted.readOperation(s, input.operationId), result);
    assert.deepEqual(await snapshot(f), before);
    for (const field of Object.keys(input).filter((k) => k !== "operationId")) {
      const changed = {
        ...input,
        [field]:
          typeof input[field] === "number"
            ? input[field] + 1
            : field === "target"
              ? { kind: "wiki", id: "page1" }
              : field === "projectId"
                ? "p2"
                : field === "sha256"
                  ? "0".repeat(64)
                  : field === "contentType"
                    ? "image/png"
                    : `${input[field]}x`,
      };
      await assert.rejects(restarted[method](s, changed), error("conflict"), field);
    }
    assert.deepEqual(await snapshot(f), before);
  });
}

for (const method of ["linkAsset", "unlinkAsset"]) {
  test(`09a ${method} stale CAS rolls back all owned rows; concurrent updates have one winner`, async () => {
    const f = await fixture(),
      s = f.scope();
    if (method === "linkAsset") await completed(f, s);
    else await linked(f, s);
    const expectedVersion = method === "linkAsset" ? 2 : 3;
    const input = {
      assetId: "b1",
      linkId: "l1",
      expectedVersion,
      target: { kind: "issue", id: "i1" },
    };
    // A missing audit row must not turn the history PK into the CAS mechanism.
    await f.db
      .prepare("DELETE FROM assets_history WHERE workspace_id='w1' AND asset_id='b1' AND version=?")
      .bind(expectedVersion)
      .run();
    const before = await snapshot(f);
    await assert.rejects(
      f.api[method](s, { ...input, expectedVersion: expectedVersion - 1, operationId: "stale" }),
      error("conflict"),
    );
    assert.deepEqual(await snapshot(f), before);
    const outcomes = await Promise.allSettled(
      [0, 1].map((n) =>
        f.api[method](s, {
          ...input,
          operationId: `race${n}`,
          ...(method === "linkAsset" ? { linkId: `race${n}` } : {}),
        }),
      ),
    );
    assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(
      outcomes.filter(
        (x) => x.status === "rejected" && ["conflict", "not_found"].includes(x.reason.code),
      ).length,
      1,
    );
    assert.equal(
      (await f.db.prepare("SELECT version FROM assets_blobs WHERE id='b1'").first()).version,
      expectedVersion + 1,
    );
    assert.equal(
      (
        await f.db
          .prepare("SELECT count(*) n FROM assets_receipts WHERE operation_id LIKE 'race%'")
          .first()
      ).n,
      1,
    );
  });
}

for (const method of ["beginUpload", "unlinkAsset"]) {
  test(`09a ${method} cannot change metadata unless its GC job is durably committed`, async () => {
    const f = await fixture(),
      s = f.scope();
    if (method === "unlinkAsset") await linked(f, s);
    const input =
      method === "beginUpload"
        ? await f.input()
        : { operationId: "unlink", assetId: "b1", expectedVersion: 3, linkId: "l1" };
    const before = await snapshot(f);
    await f.db.exec(
      "CREATE TRIGGER fail_gc BEFORE INSERT ON assets_gc_jobs BEGIN SELECT RAISE(ABORT, 'injected GC persistence failure'); END;",
    );
    await assert.rejects(f.api[method](s, input));
    assert.deepEqual(
      await snapshot(f),
      before,
      "metadata and audit must roll back when GC persistence fails",
    );
    await f.db.exec("DROP TRIGGER fail_gc;");
    await f.api[method](s, input);
    assert.equal((await f.db.prepare("SELECT count(*) n FROM assets_gc_jobs").first()).n, 1);
  });
}

test("09a GC preserves a still-linked blob and resumes after R2 delete / D1 crash", async () => {
  const f = await fixture(),
    s = f.scope();
  await linked(f, s);
  await f.api.linkAsset(s, {
    operationId: "link2",
    assetId: "b1",
    expectedVersion: 3,
    linkId: "l2",
    target: { kind: "wiki", id: "page1" },
  });
  await f.api.unlinkAsset(s, {
    operationId: "unlink1",
    assetId: "b1",
    expectedVersion: 4,
    linkId: "l1",
  });
  assert.equal(await f.api.drainGc(), 1);
  assert.deepEqual(await f.bucket.get("assets/w1/b1"), bytes("hello"));
  assert.equal((await f.api.listAssets(s, { kind: "wiki", id: "page1" })).items.length, 1);
  await f.api.unlinkAsset(s, {
    operationId: "unlink2",
    assetId: "b1",
    expectedVersion: 5,
    linkId: "l2",
  });
  f.failBatch(Error("crash after R2 delete"));
  await assert.rejects(f.api.drainGc());
  assert.equal(await f.bucket.get("assets/w1/b1"), null);
  assert.equal((await f.db.prepare("SELECT count(*) n FROM assets_gc_jobs").first()).n, 1);
  assert.equal((await f.db.prepare("SELECT count(*) n FROM assets_blobs").first()).n, 1);
  const restarted = f.restart();
  let drained;
  await assert.doesNotReject(async () => {
    drained = await restarted.drainGc();
  });
  assert.equal(drained, 1);
  assert.equal(await restarted.drainGc(), 0);
  assert.equal((await f.db.prepare("SELECT count(*) n FROM assets_blobs").first()).n, 0);
  assert.equal((await f.db.prepare("SELECT count(*) n FROM assets_gc_jobs").first()).n, 0);
  assert.deepEqual(await restarted.readOperation(s, "unlink2"), { id: "b1", version: 6 });
});

test("09a begin size boundary accepts exactly 10 MiB and rejects one byte more", async () => {
  const f = await fixture(),
    s = f.scope();
  const data = new ArrayBuffer(10 * 1024 * 1024);
  const input = { ...(await f.input()), size: data.byteLength, sha256: await hash(data) };
  const before = await snapshot(f);
  await assert.rejects(
    f.api.beginUpload(s, { ...input, size: data.byteLength + 1 }),
    error("validation"),
  );
  assert.deepEqual(await snapshot(f), before);
  await assert.doesNotReject(async () => {
    assert.deepEqual(await f.api.beginUpload(s, input), { id: "b1", version: 1 });
    await f.api.putUpload(s, "b1", data);
  });
  assert.deepEqual(
    await f.api.completeUpload(s, { operationId: "complete", assetId: "b1", expectedVersion: 1 }),
    { id: "b1", version: 2 },
  );
});

test("09a Assets dependency fakes satisfy the public provider contract", async () => {
  const f = await fixture();
  await assetsProviderContract({
    ...f.providers,
    editor: f.scope(),
    viewer: f.scope("w1", "viewer", { role: "viewer", scope: "read" }),
    projectId: "p1",
    issueId: "i1",
    pageId: "page1",
  });
});

test("09a expired pending GC closes completion before deleting R2 bytes", async () => {
  const f = await fixture(),
    s = f.scope();
  await f.api.beginUpload(s, await f.input());
  await f.api.putUpload(s, "b1", bytes("hello"));
  f.setNow(1000 + 86400);
  let completion;
  f.beforeDelete(async () => {
    try {
      completion = await f.api.completeUpload(s, {
        operationId: "late-complete",
        assetId: "b1",
        expectedVersion: 1,
      });
      await f.api.linkAsset(s, {
        operationId: "late-link",
        assetId: "b1",
        expectedVersion: 2,
        linkId: "late-link",
        target: { kind: "issue", id: "i1" },
      });
    } catch (e) {
      completion = e.code;
    }
  });
  await f.api.drainGc();
  assert.equal(
    completion,
    "conflict",
    "GC must close pending uploads before an interleaved completion/link",
  );
  assert.equal(await f.bucket.get("assets/w1/b1"), null);
  assert.equal((await f.db.prepare("SELECT count(*) n FROM assets_links").first()).n, 0);
  assert.equal(await f.api.readOperation(s, "late-complete"), null);
});

test("09a download after membership revoke rejects a previously authorized asset", async () => {
  const f = await fixture(),
    s = f.scope();
  await linked(f, s);
  const download = await f.api.downloadAsset(s, "b1");
  await download.body.cancel();
  f.revoke(s);
  await assert.rejects(f.api.downloadAsset(s, "b1"), error("forbidden"));
});

test("11a Assets event attribution and legacy null", async () => {
  const f = await fixture();
  await f.api.beginUpload(f.scope("w1", "agent", { clientId: "Dots" }), await f.input());
  const current = (await f.api.readEvents(f.eventReader, "w1", 0, 100))[0];
  assert.equal(current.schemaVersion, 2);
  assert.equal(current.payload.clientId, "Dots");
  await f.db
    .prepare(
      "INSERT INTO assets_events(workspace_id,sequence,event_id,aggregate_id,aggregate_version,type,actor_id,occurred_at) VALUES('w1',2,'old','b1',1,'AssetBegun','agent',1)",
    )
    .run();
  const old = (await f.api.readEvents(f.eventReader, "w1", 1, 100))[0];
  assert.equal(old.schemaVersion, 1);
  assert.equal(old.payload.clientId, null);
});
