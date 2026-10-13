import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

let platform;
let mf;
let counter = 0;
const code = (expected) => (error) => error.code === expected;
const actor = (id, workspaceId, role = "member", kind = "human", scope = "write", clientId) => ({
  id,
  workspaceId,
  role,
  kind,
  scope,
  clientId,
  active: true,
});
const create = (projectId, key, operationId = `create-${projectId}`) => ({
  projectId,
  key,
  name: projectId,
  operationId,
});

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
    d1Databases: ["PROJECTS0", "PROJECTS1", "PROJECTS2", "PROJECTS3"],
  });
});
after(async () => {
  await mf?.dispose();
});
async function fixture() {
  const db = await mf.getD1Database(`PROJECTS${counter++}`);
  await platform.migrate(db, ["projects"]);
  const rawStore = platform.createModuleStore(db, "projects");
  const access = platform.fakeAccess();
  const state = { hook: null, now: 1800000000 };
  const store = {
    owner: "projects",
    run: (...args) => rawStore.run(...args),
    batch: (calls) => (state.hook ? state.hook(calls) : rawStore.batch(calls)),
  };
  const created = platform.createProjects({
    store,
    access: access.access,
    clock: { now: () => state.now },
    ids: { next: () => crypto.randomUUID() },
    eventConsumer: "test",
  });
  const owner = access.issue(actor("owner", "w1", "owner"));
  return { db, rawStore, access, state, ...created, owner };
}

test("Access consumer fake enforces provenance and live permission; rules reject malformed input", async () => {
  const f = await fixture();
  await platform.accessConsumerContract(f.access.access, f.owner);
  await assert.rejects(f.api.createProject(f.owner, null), code("validation"));
  await assert.rejects(f.api.createProject(f.owner, create("p1", "a")), code("validation"));
  await assert.rejects(f.api.createProject(f.owner, create("p1", "../A")), code("validation"));
  const viewer = f.access.issue(actor("viewer", "w1", "viewer"));
  await assert.rejects(f.api.createProject(viewer, create("p2", "TWO")), code("forbidden"));
  await f.api.createProject(f.owner, create("p1", "ONE"));
  await assert.rejects(
    f.api.renameProject(f.owner, {
      projectId: "p1",
      expectedVersion: 0,
      name: "new",
      operationId: "bad-version",
    }),
    code("validation"),
  );
  await assert.rejects(f.api.getProject(viewer, "p1"), code("not_found"));
});

test("atomic receipts/events, replay, conflicting reuse, stale CAS and response loss", async () => {
  const f = await fixture();
  const input = create("p1", "ONE");
  f.state.hook = (calls) =>
    f.rawStore.batch(
      calls.map((call) =>
        call.name === "event"
          ? { ...call, values: [call.values[0], call.values[1], null, ...call.values.slice(3)] }
          : call,
      ),
    );
  await assert.rejects(f.api.createProject(f.owner, input), code("unknown"));
  assert.equal((await f.rawStore.run("project", ["w1", "p1"])).rows.length, 0);
  assert.equal(
    (await f.rawStore.run("readReceipt", ["w1", "owner", input.operationId])).rows.length,
    0,
  );
  assert.equal((await f.rawStore.run("events", ["w1", 0, 10])).rows.length, 0);
  f.state.hook = null;
  assert.deepEqual(await f.api.createProject(f.owner, input), { id: "p1", version: 1 });
  assert.deepEqual(await f.api.createProject(f.owner, input), { id: "p1", version: 1 });
  await assert.rejects(f.api.createProject(f.owner, { ...input, key: "TWO" }), code("conflict"));
  await assert.rejects(
    f.api.renameProject(f.owner, {
      projectId: "p1",
      expectedVersion: 9,
      name: "lost",
      operationId: "stale",
    }),
    code("conflict"),
  );
  assert.equal(await f.api.readOperation(f.owner, "stale"), null);
  f.state.hook = async (calls) => {
    await f.rawStore.batch(calls);
    throw new Error("response lost");
  };
  const renamed = await f.api.renameProject(f.owner, {
    projectId: "p1",
    expectedVersion: 1,
    name: "renamed",
    operationId: "lost-response",
  });
  assert.deepEqual(renamed, { id: "p1", version: 2 });
  assert.deepEqual(await f.api.readOperation(f.owner, "lost-response"), renamed);
  assert.deepEqual(
    (await f.api.readEvents(f.eventReader, "w1", 0, 10)).map((e) => e.type),
    ["ProjectChanged", "ProjectChanged"],
  );
  assert.equal((await f.rawStore.run("events", ["w1", 0, 10])).rows.length, 2);
  assert.equal((await f.rawStore.run("project", ["w1", "p1"])).rows[0].name, "renamed");
});

test("DB key uniqueness survives concurrent create and rename, including case changes", async () => {
  const f = await fixture();
  const created = await Promise.allSettled([
    f.api.createProject(f.owner, create("a", "SAME")),
    f.api.createProject(f.owner, create("b", "same")),
  ]);
  assert.equal(created.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    created.filter((r) => r.status === "rejected" && r.reason.code === "conflict").length,
    1,
  );
  await f.api.createProject(f.owner, create("c", "THIRD"));
  await f.api.createProject(f.owner, create("d", "FOURTH"));
  const renamed = await Promise.allSettled([
    f.api.renameProject(f.owner, {
      projectId: "c",
      key: "RACE",
      name: "c",
      expectedVersion: 1,
      operationId: "rename-c",
    }),
    f.api.renameProject(f.owner, {
      projectId: "d",
      key: "race",
      name: "d",
      expectedVersion: 1,
      operationId: "rename-d",
    }),
  ]);
  assert.equal(renamed.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    renamed.filter((r) => r.status === "rejected" && r.reason.code === "conflict").length,
    1,
  );
  assert.equal(
    (await f.api.listVisibleProjects(f.owner, "", 100)).projects.filter((p) => p.key === "RACE")
      .length,
    1,
  );
});

test("two tenants, keyset visibility, grants for machines and OAuth clients, revoke at next admission", async () => {
  const f = await fixture();
  const otherOwner = f.access.issue(actor("owner", "w2", "owner"));
  const machine = f.access.issue(actor("bot", "w1", "member", "machine"));
  const oauth = f.access.issue(actor("alice", "w1", "member", "human", "write", "oauth-client"));
  const outsider = f.access.issue(actor("outsider", "w1"));
  await f.api.createProject(f.owner, create("p1", "ONE"));
  await f.api.createProject(otherOwner, create("p1", "ONE"));
  await f.api.createProject(f.owner, create("p2", "TWO"));
  await f.api.grantProjectRole(f.owner, {
    projectId: "p1",
    principalId: "bot",
    role: "editor",
    expectedVersion: 1,
    operationId: "bot-grant",
  });
  await f.api.grantProjectRole(f.owner, {
    projectId: "p1",
    principalId: "alice",
    role: "manager",
    expectedVersion: 2,
    operationId: "oauth-grant",
  });
  assert.equal((await f.api.authorizeProject(machine, "p1", "write")).role, "editor");
  await f.api.authorizeProjectPrincipal(f.owner, "p1", "bot");
  await assert.rejects(f.api.authorizeProjectPrincipal(f.owner, "p2", "bot"), code("not_found"));
  assert.equal((await f.api.authorizeProject(oauth, "p1", "manage")).role, "manager");
  await assert.rejects(f.api.authorizeProject(machine, "p1", "manage"), code("forbidden"));
  await assert.rejects(f.api.getProject(machine, "p2"), code("not_found"));
  await assert.rejects(f.api.getProject(outsider, "p1"), code("not_found"));
  assert.equal((await f.api.listVisibleProjects(machine)).projects.length, 1);
  const page = await f.api.listVisibleProjects(f.owner, "", 1);
  assert.equal(page.projects.length, 1);
  assert.equal((await f.api.listVisibleProjects(f.owner, page.nextCursor, 1)).projects.length, 1);
  assert.equal((await f.api.getProject(otherOwner, "p1")).version, 1);
  await f.api.revokeProjectRole(f.owner, {
    projectId: "p1",
    principalId: "bot",
    expectedVersion: 3,
    operationId: "bot-revoke",
  });
  await assert.rejects(f.api.authorizeProject(machine, "p1"), code("not_found"));
  f.access.revoke(oauth);
  await assert.rejects(f.api.authorizeProject(oauth, "p1"), code("forbidden"));
  const archive = await f.api.archiveProject(f.owner, {
    projectId: "p1",
    expectedVersion: 4,
    operationId: "archive",
  });
  assert.deepEqual(archive, { id: "p1", version: 5 });
  await assert.rejects(f.api.getProject(f.owner, "p1"), code("not_found"));
  assert.deepEqual(
    await f.api.archiveProject(f.owner, {
      projectId: "p1",
      expectedVersion: 4,
      operationId: "archive",
    }),
    archive,
  );
});
