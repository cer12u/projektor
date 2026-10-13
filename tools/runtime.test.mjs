import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

let mf;
let platform;
before(async () => {
  fs.mkdirSync(".tmp", { recursive: true });
  await build({
    entryPoints: ["tools/test-entry.ts"],
    outfile: ".tmp/test-entry.mjs",
    bundle: true,
    format: "esm",
    platform: "node",
  });
  platform = await import("../.tmp/test-entry.mjs");
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('test'); } }",
    compatibilityDate: "2026-07-30",
    d1Databases: ["A", "B", "MIGRATIONS", "BAD_MIGRATION"],
    kvNamespaces: ["KV"],
    r2Buckets: ["R2"],
  });
});
after(async () => {
  await mf?.dispose();
});

for (const [owner, binding, factory] of [
  ["fixture_a", "A", "createA"],
  ["fixture_b", "B", "createB"],
]) {
  test(`${owner}: isolated schema, batch rollback, stale CAS, tenant confinement`, async () => {
    const db = await mf.getD1Database(binding);
    await platform.migrate(db, [owner]);
    const names = (
      await db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all()
    ).results.map((r) => r.name);
    assert(
      !names.some((name) => name.startsWith(owner === "fixture_a" ? "fixture_b_" : "fixture_a_")),
    );
    const store = platform.createModuleStore(db, owner);
    const repo = platform[factory](store);
    await repo.seed("w1", "same", "one");
    await repo.seed("w2", "same", "two");
    await assert.rejects(
      store.batch([
        { name: "insert", values: ["w1", "rollback", "not committed"] },
        { name: "insert", values: ["w1", "same", "duplicate"] },
        { name: "receipt", values: ["w1", "bad-batch", "success"] },
      ]),
      /UNIQUE/,
    );
    assert.equal((await repo.read("w1", "rollback")).rows.length, 0);
    assert.equal((await repo.receipt("w1", "bad-batch")).rows.length, 0);
    await repo.edit("w1", "same", 1, "edited", "op1");
    await assert.rejects(repo.edit("w1", "same", 1, "stale", "op2"), /CHECK/);
    assert.deepEqual((await repo.read("w1", "same")).rows, [
      { id: "same", value: "edited", version: 2 },
    ]);
    assert.equal((await repo.receipt("w1", "op2")).rows.length, 0);
    assert.equal((await repo.receipt("w2", "op1")).rows.length, 0);
    assert.deepEqual((await repo.read("w2", "same")).rows, [
      { id: "same", value: "two", version: 1 },
    ]);
    await assert.rejects(repo.edit("other", "same", 2, "foreign", "op3"), /CHECK/);
    assert.equal((await repo.receipt("other", "op3")).rows.length, 0);
    // Two writers race on the same version: only one complete transaction wins.
    const results = await Promise.allSettled([
      repo.edit("w1", "same", 2, "a", "race-a"),
      repo.edit("w1", "same", 2, "b", "race-b"),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(
      (await repo.receipt("w1", "race-a")).rows.length +
        (await repo.receipt("w1", "race-b")).rows.length,
      1,
    );
  });
}

test("executor rejects foreign catalog IDs, owner spoofing and >100 binds before batch submission", async () => {
  const db = await mf.getD1Database("A");
  const store = platform.createModuleStore(db, "fixture_a");
  assert.throws(
    () => platform.createA(platform.createModuleStore(db, "fixture_b")),
    /Wrong store owner/,
  );
  assert.throws(() => {
    store.owner = "fixture_b";
  }, TypeError);
  await assert.rejects(store.run("SELECT * FROM fixture_b_items", []), /Unknown query/);
  await assert.rejects(store.run("fixture_b.read", []), /Unknown query/);
  assert.throws(() => platform.createModuleStore(db, "platform"), /Unknown runtime owner/);
  assert.throws(() => platform.createModuleStore(db, "__proto__"), /Unknown runtime owner/);
  await assert.rejects(
    store.batch([
      { name: "insert", values: ["w1", "bind-rollback", "no"] },
      { name: "read", values: Array(101).fill(null) },
    ]),
    /100 binds/,
  );
  assert.equal((await store.run("read", ["w1", "bind-rollback"])).rows.length, 0);
  assert.deepEqual((await store.run("bindBoundary", Array(100).fill(1))).rows, [{ total: 100 }]);
  await assert.rejects(store.run("bindBoundary", Array(101).fill(1)), /100 binds/);
});

test("KV and R2 use owner prefixes on every get/put/delete", async () => {
  const kv = await mf.getKVNamespace("KV");
  const bucket = await mf.getR2Bucket("R2");
  for (const [adapter, prefix, foreign, value] of [
    [platform.createScopedKV(kv, "fixture_a"), "fixture_a:", "fixture_b:", "value"],
    [
      platform.createScopedBucket(bucket, "fixture_a"),
      "fixture_a/",
      "fixture_b/",
      new TextEncoder().encode("value").buffer,
    ],
  ]) {
    await adapter.put(`${prefix}key`, value);
    assert.deepEqual(await adapter.get(`${prefix}key`), value);
    for (const key of [`${foreign}key`, prefix, "fixture_ab:key", ""]) {
      await assert.rejects(adapter.get(key), /prefix/);
      await assert.rejects(adapter.put(key, value), /prefix/);
      await assert.rejects(adapter.delete(key), /prefix/);
    }
    await adapter.delete(`${prefix}key`);
    assert.equal(await adapter.get(`${prefix}key`), null);
  }
});

test("migration bookkeeping is idempotent and refuses checksum drift", async () => {
  const db = await mf.getD1Database("MIGRATIONS");
  await platform.migrate(db, ["fixture_a", "fixture_b"]);
  await platform.migrate(db, ["fixture_a", "fixture_b"]);
  assert.equal(
    (await db.prepare("SELECT * FROM platform_schema_versions").all()).results.length,
    3,
  );
  await db
    .prepare("UPDATE platform_schema_versions SET checksum='tampered' WHERE owner='fixture_a'")
    .run();
  await assert.rejects(platform.migrate(db, ["fixture_a"]), /Migration drift/);
});

test("clock, IDs and typed errors have portable contracts", () => {
  assert(Math.abs(platform.systemClock.now() - Math.floor(Date.now() / 1000)) <= 1);
  assert.notEqual(platform.randomIds.next(), platform.randomIds.next());
  assert.match(platform.randomIds.next(), /^[0-9a-f-]{36}$/);
  assert.equal(new platform.PlatformError("conflict", "stale").code, "conflict");
});

test("failed migration rolls back schema and owner receipt together", async () => {
  const db = await mf.getD1Database("BAD_MIGRATION");
  await db.prepare("CREATE TABLE fixture_a_guards (id TEXT)").run();
  await assert.rejects(platform.migrate(db, ["fixture_a"]), /already exists/);
  assert.equal(
    (await db.prepare("SELECT name FROM sqlite_schema WHERE name='fixture_a_items'").all()).results
      .length,
    0,
  );
  assert.equal(
    (await db.prepare("SELECT * FROM platform_schema_versions WHERE owner='fixture_a'").all())
      .results.length,
    0,
  );
});
