import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

let p,
  mf,
  serial = 0;
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
];
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
    d1Databases: Array.from({ length: 20 }, (_, i) => `LIFECYCLE${i}`),
  });
});
after(async () => mf?.dispose());
async function fixture() {
  const db = await mf.getD1Database(`LIFECYCLE${serial}`);
  await p.migrate(db, ["lifecycle"]);
  const workspaceId = `ws${serial++}`,
    principal = {};
  let now = 1000,
    count = 0,
    kind = "human",
    role = "owner",
    clientId,
    membership = true,
    fault;
  const events = [],
    frozen = new Set(),
    erased = new Set();
  const access = {
    async requireMembership(actor, ws) {
      if (actor !== principal || ws !== workspaceId || !membership)
        throw new p.PlatformError("forbidden", "No membership");
      return { workspaceId, principalId: "person", requestId: "request", kind, role, clientId };
    },
    async me(actor) {
      if (actor !== principal) throw new p.PlatformError("forbidden", "Invalid principal");
      return {
        principal: { id: "person", kind: clientId ? "oauth" : kind },
        workspaces: [],
        nextCursor: null,
      };
    },
  };
  let expectedOwners = order;
  const owners = Object.fromEntries(
    order.map((name) => [
      name,
      {
        async freezeScope() {
          events.push(`freeze:${name}`);
          frozen.add(name);
          if (fault === `freeze:${name}`) {
            fault = undefined;
            throw Error("Lost freeze reply");
          }
          return this.purgeStatus();
        },
        async purgeScope() {
          assert(
            expectedOwners.every((o) => frozen.has(o)),
            "purge before all acknowledgements",
          );
          assert(
            name !== "access" || order.filter((o) => o !== "access").every((o) => erased.has(o)),
            "Access must go last",
          );
          events.push(`purge:${name}`);
          erased.add(name);
          if (name === "access") membership = false;
          if (fault === `purge:${name}`) {
            fault = undefined;
            throw Error("Lost purge reply");
          }
          return this.purgeStatus();
        },
        async purgeStatus() {
          return frozen.has(name)
            ? {
                state: erased.has(name) ? "purged" : "frozen",
                remaining: erased.has(name) ? 0 : 2,
                pending: 0,
              }
            : null;
        },
      },
    ]),
  );
  const store = p.createModuleStore(db, "lifecycle");
  let batchFault;
  const deps = {
    store: {
      ...store,
      async batch(calls) {
        const mode = batchFault;
        batchFault = undefined;
        if (mode === "before") throw Error("process stopped before transaction");
        const result = await store.batch(calls);
        if (mode === "after") throw Error("process stopped after commit");
        return result;
      },
    },
    access,
    projects: {
      async getProjectIncludingArchived(_s, id) {
        return { id, archived: true };
      },
    },
    owners,
    clock: { now: () => now },
    ids: { next: () => `id${serial}_${++count}` },
  };
  const scope = { principal, workspaceId, requestId: "r" };
  const api = () => p.createLifecycle(deps).api;
  const tick = async () => {
    now += 31;
    return p.createLifecycle(deps).background.tick();
  };
  const input = { operationId: "request", expectedVersion: 0, confirmation: workspaceId };
  return {
    db,
    workspaceId,
    scope,
    api,
    tick,
    input,
    owners,
    events,
    frozen,
    erased,
    store,
    project: () => {
      expectedOwners = order.filter((o) => o !== "access");
    },
    identity: (value) => {
      ({ kind = "human", role = "owner", clientId } = value);
    },
    fault: (v) => {
      fault = v;
    },
    batchFault: (v) => {
      batchFault = v;
    },
    status: (input = {}) => api().getPurgeStatus(scope, input),
  };
}
async function finish(f, projectId) {
  for (let i = 0; i < 100; i++) {
    const status = await f.status(projectId ? { projectId } : {});
    if (status.state === "complete") return status;
    await f.tick();
  }
  assert.fail("purge did not complete");
}
test("human workspace owner, exact confirmation, scoped CAS and immutable operation retry", async () => {
  const f = await fixture();
  for (const identity of [
    { kind: "machine" },
    { clientId: "oauth-client" },
    { role: "admin" },
    { role: "member" },
  ]) {
    f.identity(identity);
    await assert.rejects(f.api().requestPurge(f.scope, f.input), (e) => e.code === "forbidden");
  }
  f.identity({});
  await assert.rejects(
    f.api().requestPurge(f.scope, { ...f.input, confirmation: "wrong" }),
    (e) => e.code === "validation",
  );
  await assert.rejects(
    f.api().requestPurge(f.scope, { ...f.input, expectedVersion: 1 }),
    (e) => e.code === "conflict",
  );
  const j = await f.api().requestPurge(f.scope, f.input);
  assert.deepEqual(await f.api().requestPurge(f.scope, f.input), j);
  await assert.rejects(
    f.api().requestPurge(f.scope, { ...f.input, operationId: "other" }),
    (e) => e.code === "conflict",
  );
  await assert.rejects(
    f.api().requestPurge(f.scope, { ...f.input, projectId: "p1", confirmation: "p1" }),
    (e) => e.code === "conflict",
  );
  await assert.rejects(
    f.api().resumePurge(f.scope, { operationId: "stale", jobId: j.id, expectedVersion: 0 }),
    (e) => e.code === "conflict",
  );
  assert.equal(
    (await f.store.run("readReceipt", [f.workspaceId, "person", "stale"])).rows.length,
    0,
  );
  const input = { operationId: "resume", jobId: j.id, expectedVersion: j.version };
  const resumed = await f.api().resumePurge(f.scope, input);
  assert.deepEqual(await f.api().resumePurge(f.scope, input), resumed);
  assert.equal(resumed.version, 2);
  await assert.rejects(
    f.api().getPurgeStatus({ ...f.scope, workspaceId: "other" }, {}),
    (e) => e.code === "forbidden",
  );
});
test("response loss and interrupted transactions leave one complete receipt and audit", async () => {
  const f = await fixture();
  f.batchFault("before");
  await assert.rejects(f.api().requestPurge(f.scope, f.input), (e) => e.code === "unknown");
  assert.equal(await f.status(), null);
  f.batchFault("after");
  const j = await f.api().requestPurge(f.scope, f.input);
  assert.deepEqual(await f.api().requestPurge(f.scope, f.input), j);
  const { n } = await f.db
    .prepare("SELECT COUNT(*) n FROM lifecycle_history WHERE workspace_id=?")
    .bind(f.workspaceId)
    .first();
  assert.equal(n, 1);
});
test("crash after every owner freeze/purge effect resumes and Access is last", async () => {
  const f = await fixture();
  await f.api().requestPurge(f.scope, f.input);
  for (const name of order) {
    f.fault(`freeze:${name}`);
    await f.tick();
    const failed = await f.status();
    assert(failed.steps.find((s) => s.owner === name).error);
    assert.equal(f.erased.size, 0);
    await f.tick();
  }
  await f.tick(); // all acknowledgements -> purging
  for (const name of order) {
    await f.tick(); // durable intent before external effect
    f.fault(`purge:${name}`);
    await f.tick();
    assert((await f.status()).steps.find((s) => s.owner === name).error);
    await f.tick();
  }
  const result = await finish(f);
  assert.equal(result.state, "complete");
  assert(result.steps.every((s) => s.state === "purged" && s.remaining === 0));
  f.identity({ clientId: "oauth" });
  await assert.rejects(f.status(), (e) => e.code === "forbidden");
});
test("crash before/after every durable transition, racing ticks, and project purge excludes Access", async () => {
  for (const mode of ["before", "after"]) {
    const f = await fixture();
    f.project();
    await f.api().requestPurge(f.scope, { ...f.input, projectId: "p1", confirmation: "p1" });
    for (let i = 0; i < 40; i++) {
      const j = await f.status({ projectId: "p1" });
      if (j.state === "complete") break;
      f.batchFault(mode);
      await assert.rejects(f.tick());
      await f.tick();
    }
    const result = await finish(f, "p1");
    assert(!result.steps.some((s) => s.owner === "access"));
    assert(!f.events.some((e) => e.endsWith(":access")));
  }
  const f = await fixture();
  await f.api().requestPurge(f.scope, f.input);
  await Promise.all([f.tick(), f.tick()]);
  await finish(f);
});
test("pending acknowledgements and incomplete R2 counts hold the global barrier", async () => {
  const f = await fixture();
  let pending = 1,
    remaining = 1;
  f.owners.assets.freezeScope = async () => {
    f.frozen.add("assets");
    return { state: "frozen", remaining, pending };
  };
  f.owners.assets.purgeStatus = async () => ({
    state: remaining ? "purging" : "purged",
    remaining,
    pending,
  });
  f.owners.assets.purgeScope = async () => {
    assert(f.frozen.size === 9);
    return { state: remaining ? "purging" : "purged", remaining, pending };
  };
  await f.api().requestPurge(f.scope, f.input);
  for (let i = 0; i < 11; i++) await f.tick();
  assert.equal(f.erased.size, 0);
  assert.equal((await f.status()).state, "freezing");
  pending = 0;
  for (let i = 0; i < 15; i++) await f.tick();
  assert(!f.erased.has("projects"));
  assert(!f.erased.has("access"));
  remaining = 0;
  f.erased.add("assets");
  await finish(f);
});
