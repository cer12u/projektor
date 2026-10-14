import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { projectsConsumerContract } from "./projects-consumer-contract.mjs";

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
    d1Databases: Array.from({ length: 32 }, (_, i) => `PROJECTS${i}`),
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

const edit = (projectId, expectedVersion, operationId = "edit") => ({
  projectId,
  expectedVersion,
  operationId,
  name: "renamed",
});
const commands = [
  ["createProject", () => create("new", "NEW", "command"), { name: "different" }],
  ["renameProject", () => edit("p1", 1, "command"), { name: "different" }],
  [
    "grantProjectRole",
    () => ({
      projectId: "p1",
      expectedVersion: 1,
      operationId: "command",
      principalId: "target",
      role: "editor",
    }),
    { role: "viewer" },
  ],
  [
    "revokeProjectRole",
    () => ({ projectId: "p1", expectedVersion: 2, operationId: "command", principalId: "target" }),
    { principalId: "other" },
  ],
  [
    "archiveProject",
    () => ({ projectId: "p1", expectedVersion: 1, operationId: "command" }),
    { expectedVersion: 2 },
  ],
];
async function prepared(method) {
  const f = await fixture();
  f.access.issue(actor("target", "w1"));
  await f.api.createProject(f.owner, create("p1", "ONE"));
  if (method === "revokeProjectRole")
    await f.api.grantProjectRole(f.owner, {
      projectId: "p1",
      expectedVersion: 1,
      principalId: "target",
      role: "editor",
      operationId: "setup-grant",
    });
  return f;
}
async function snapshot(f) {
  const result = {};
  for (const table of [
    "projects_projects",
    "projects_grants",
    "projects_receipts",
    "projects_events",
    "projects_guards",
  ])
    result[table] = (await f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
  return result;
}
for (const [method, makeInput, changed] of commands) {
  test(`${method}: rollback, replay fingerprint, response loss and durable receipt/event consistency`, async () => {
    const f = await prepared(method);
    const input = makeInput();
    const before = await snapshot(f);
    // Failing the final event must undo every earlier row, including grant/version/receipt.
    f.state.hook = (calls) =>
      f.rawStore.batch(
        calls.map((call) =>
          call.name === "event"
            ? { ...call, values: [call.values[0], call.values[1], null, ...call.values.slice(3)] }
            : call,
        ),
      );
    await assert.rejects(f.api[method](f.owner, input), code("unknown"));
    assert.deepEqual(await snapshot(f), before);
    f.state.hook = async (calls) => {
      await f.rawStore.batch(calls);
      throw new Error("response lost after commit");
    };
    const result = await f.api[method](f.owner, input);
    const committed = await snapshot(f);
    f.state.hook = null;
    assert.deepEqual(await f.api[method](f.owner, input), result);
    await assert.rejects(f.api[method](f.owner, { ...input, ...changed }), code("conflict"));
    assert.deepEqual(await snapshot(f), committed);
    assert.deepEqual(await f.api.readOperation(f.owner, input.operationId), result);
    const event = (await f.api.readEvents(f.eventReader, "w1", 0, 100)).at(-1);
    assert.equal(event.aggregateId, result.id);
    assert.equal(event.aggregateVersion, result.version);
    assert.equal(event.payload.actorId, "owner");
    assert.equal(event.source, "projects");
    assert.equal(event.schemaVersion, 1);
    assert.equal(event.workspaceId, "w1");
    assert.equal(event.occurredAt, f.state.now);
    assert.equal(
      event.type,
      method === "archiveProject"
        ? "ProjectArchived"
        : method.includes("Role")
          ? "ProjectGrantChanged"
          : "ProjectChanged",
    );
    assert.equal(committed.projects_guards.length, 0);
    // Reconstruct the module over the same D1 database, with new capability handles.
    const restarted = platform.createProjects({
      store: f.rawStore,
      access: f.access.access,
      clock: { now: () => f.state.now },
      ids: { next: () => crypto.randomUUID() },
    });
    assert.deepEqual(await restarted.api.readOperation(f.owner, input.operationId), result);
    assert.deepEqual(await restarted.api[method](f.owner, input), result);
  });
}

test("all CAS commands reject stale versions without changing any table; concurrent writers have one winner", async () => {
  const f = await prepared("revokeProjectRole");
  for (const [method, makeInput] of commands.slice(1)) {
    const before = await snapshot(f);
    await assert.rejects(
      f.api[method](f.owner, {
        ...makeInput(),
        expectedVersion: 1,
        operationId: `stale-${method}`,
      }),
      code("conflict"),
    );
    assert.deepEqual(await snapshot(f), before, method);
    assert.equal(await f.api.readOperation(f.owner, `stale-${method}`), null);
  }
  const outcomes = await Promise.allSettled([
    f.api.renameProject(f.owner, edit("p1", 2, "race-a")),
    f.api.archiveProject(f.owner, { projectId: "p1", expectedVersion: 2, operationId: "race-b" }),
  ]);
  assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    outcomes.filter((r) => r.status === "rejected" && r.reason.code === "conflict").length,
    1,
  );
  assert.equal((await snapshot(f)).projects_events.length, 3);
});

test("unchanged grants and absent/inactive revocations roll back the project version and receipt", async () => {
  const f = await prepared("revokeProjectRole");
  const before = await snapshot(f);
  for (const input of [
    [
      "grantProjectRole",
      {
        projectId: "p1",
        expectedVersion: 2,
        principalId: "target",
        role: "editor",
        operationId: "same-grant",
      },
    ],
    [
      "revokeProjectRole",
      { projectId: "p1", expectedVersion: 2, principalId: "absent", operationId: "absent-revoke" },
    ],
  ]) {
    await assert.rejects(f.api[input[0]](f.owner, input[1]), code("conflict"));
    assert.deepEqual(await snapshot(f), before);
  }
  await f.api.revokeProjectRole(f.owner, {
    projectId: "p1",
    expectedVersion: 2,
    principalId: "target",
    operationId: "revoke",
  });
  const revoked = await snapshot(f);
  await assert.rejects(
    f.api.revokeProjectRole(f.owner, {
      projectId: "p1",
      expectedVersion: 3,
      principalId: "target",
      operationId: "again",
    }),
    code("conflict"),
  );
  assert.deepEqual(await snapshot(f), revoked);
  await f.api.grantProjectRole(f.owner, {
    projectId: "p1",
    expectedVersion: 3,
    principalId: "target",
    role: "viewer",
    operationId: "restore",
  });
  assert.equal((await f.rawStore.run("grant", ["w1", "p1", "target"])).rows[0].active, 1);
});

test("project role matrix is capped by live workspace role and credential scope", async () => {
  const f = await fixture();
  await f.api.createProject(f.owner, create("p1", "ONE"));
  let version = 1;
  const scopes = {};
  for (const projectRole of ["viewer", "editor", "manager"]) {
    const person = actor(projectRole, "w1");
    const scope = f.access.issue(person);
    scopes[projectRole] = scope;
    await f.api.grantProjectRole(f.owner, {
      projectId: "p1",
      expectedVersion: version++,
      principalId: person.id,
      role: projectRole,
      operationId: `grant-${projectRole}`,
    });
    assert.equal((await f.api.getProject(scope, "p1")).role, projectRole);
    for (const permission of ["read", "write", "manage"]) {
      const allowed =
        permission === "read" ||
        projectRole === "manager" ||
        (permission === "write" && projectRole === "editor");
      if (allowed) await f.api.authorizeProject(scope, "p1", permission);
      else await assert.rejects(f.api.authorizeProject(scope, "p1", permission), code("forbidden"));
    }
    for (const [method, makeInput] of commands) {
      if (projectRole === "manager" && method !== "createProject") continue;
      await assert.rejects(f.api[method](scope, makeInput()), code("forbidden"));
    }
    person.scope = "read";
    await assert.rejects(f.api.authorizeProject(scope, "p1", "write"), code("forbidden"));
    person.scope = "write";
  }
  await projectsConsumerContract({
    api: f.api,
    editor: scopes.editor,
    viewer: scopes.viewer,
    projectId: "p1",
    assigneeId: "viewer",
    missingPrincipalId: "contract-absent",
  });
  const adminActor = actor("admin", "w1", "admin");
  const admin = f.access.issue(adminActor);
  assert.equal((await f.api.getProject(admin, "p1")).role, "manager");
  await f.api.createProject(admin, create("p2", "TWO"));
  adminActor.role = "member";
  await assert.rejects(f.api.getProject(admin, "p1"), code("not_found"));
  await assert.rejects(f.api.createProject(admin, create("p3", "THREE")), code("forbidden"));
});

test("every scope-bearing entry rejects copied and revoked scopes, including retries and receipt recovery", async () => {
  const f = await fixture();
  await f.api.createProject(f.owner, create("p1", "ONE"));
  const calls = [
    ...commands.map(
      ([method, makeInput]) =>
        (scope) =>
          f.api[method](scope, makeInput()),
    ),
    (scope) => f.api.getProject(scope, "p1"),
    (scope) => f.api.authorizeProject(scope, "p1"),
    (scope) => f.api.listVisibleProjects(scope),
    (scope) => f.api.readOperation(scope, "create-p1"),
    (scope) => f.api.authorizeProjectPrincipal(scope, "p1", "owner"),
    (scope) => f.api.createProject(scope, create("p1", "ONE")),
  ];
  for (const call of calls) await assert.rejects(call({ ...f.owner }), code("forbidden"));
  f.access.revoke(f.owner);
  for (const call of calls) await assert.rejects(call(f.owner), code("forbidden"));
});

test("Q1 admitted write may commit after revoke; following write and operation lookup reject", async () => {
  const f = await fixture();
  let release;
  let entered;
  const reached = new Promise((resolve) => {
    entered = resolve;
  });
  const proceed = new Promise((resolve) => {
    release = resolve;
  });
  f.state.hook = async (calls) => {
    entered();
    await proceed;
    return f.rawStore.batch(calls);
  };
  const pending = f.api.createProject(f.owner, create("p1", "ONE"));
  await reached;
  f.access.revoke(f.owner);
  release();
  assert.deepEqual(await pending, { id: "p1", version: 1 });
  await assert.rejects(f.api.createProject(f.owner, create("p2", "TWO")), code("forbidden"));
  await assert.rejects(f.api.readOperation(f.owner, "create-p1"), code("forbidden"));
  assert.equal((await f.rawStore.run("project", ["w1", "p1"])).rows.length, 1);
});

test("tenant, project and actor scope isolate rows, grants, receipts and event cursors", async () => {
  const f = await fixture();
  const w2 = f.access.issue(actor("owner", "w2", "owner"));
  const member = f.access.issue(actor("member", "w1"));
  const member2 = f.access.issue(actor("member", "w2"));
  await f.api.createProject(f.owner, { ...create("p1", "ONE", "same-op"), name: "workspace-one" });
  await f.api.createProject(w2, { ...create("p1", "ONE", "same-op"), name: "workspace-two" });
  await f.api.createProject(w2, create("foreign", "FOREIGN"));
  await f.api.grantProjectRole(f.owner, {
    projectId: "p1",
    principalId: "member",
    role: "manager",
    expectedVersion: 1,
    operationId: "grant",
  });
  await assert.rejects(f.api.getProject(member2, "p1"), code("not_found"));
  await assert.rejects(f.api.getProject(f.owner, "foreign"), code("not_found"));
  await assert.rejects(f.api.getProject(f.owner, "missing"), code("not_found"));
  await assert.rejects(f.api.renameProject(f.owner, edit("foreign", 1)), code("not_found"));
  assert.equal((await f.api.getProject(w2, "p1")).name, "workspace-two");
  assert.equal((await f.api.getProject(member, "p1")).name, "workspace-one");
  assert.equal(await f.api.readOperation(member, "same-op"), null);
  await f.api.renameProject(member, edit("p1", 2, "same-op"));
  assert.deepEqual(await f.api.readOperation(member, "same-op"), { id: "p1", version: 3 });
  assert.deepEqual(await f.api.readOperation(w2, "same-op"), { id: "p1", version: 1 });
  assert.deepEqual((await f.api.listVisibleProjects(member2)).projects, []);
  assert.deepEqual(
    (await f.api.readEvents(f.eventReader, "w2", 1, 1)).map((e) => [e.cursor, e.aggregateId]),
    [[2, "foreign"]],
  );
  const before = await snapshot(f);
  await f.api.revokeProjectRole(f.owner, {
    projectId: "p1",
    principalId: "member",
    expectedVersion: 3,
    operationId: "revoke",
  });
  await assert.rejects(f.api.readOperation(member, "same-op"), code("not_found"));
  await assert.rejects(f.api.renameProject(member, edit("p1", 2, "same-op")), code("not_found"));
  assert.deepEqual(
    (await snapshot(f)).projects_projects.filter((p) => p.workspace_id === "w2"),
    before.projects_projects.filter((p) => p.workspace_id === "w2"),
  );
});

test("keyset pagination excludes hidden and archived projects without duplicates or a phantom final cursor", async () => {
  const f = await fixture();
  const member = f.access.issue(actor("member", "w1"));
  for (const p of ["z", "a", "m", "hidden", "archived"]) {
    await f.api.createProject(f.owner, create(p, `P${p}`));
    if (p !== "hidden")
      await f.api.grantProjectRole(f.owner, {
        projectId: p,
        expectedVersion: 1,
        principalId: "member",
        role: "viewer",
        operationId: `grant-${p}`,
      });
  }
  await f.api.archiveProject(f.owner, {
    projectId: "archived",
    expectedVersion: 2,
    operationId: "archive",
  });
  const first = await f.api.listVisibleProjects(member, "", 2);
  assert.deepEqual(
    first.projects.map((p) => [p.id, p.role, p.archived]),
    [
      ["a", "viewer", false],
      ["m", "viewer", false],
    ],
  );
  assert.equal(first.nextCursor, "m");
  const last = await f.api.listVisibleProjects(member, first.nextCursor, 2);
  assert.deepEqual(
    last.projects.map((p) => p.id),
    ["z"],
  );
  assert.equal(last.nextCursor, null);
  assert.deepEqual(await f.api.listVisibleProjects(member, "z", 2), {
    projects: [],
    nextCursor: null,
  });
  assert.equal((await f.api.listVisibleProjects(member, "", 3)).nextCursor, null);
  for (const [method, makeInput] of commands.slice(1))
    await assert.rejects(
      f.api[method](f.owner, { ...makeInput(), projectId: "archived", expectedVersion: 3 }),
      code(method === "archiveProject" ? "conflict" : "not_found"),
    );
});

test("assignee checks live membership and project grant; unknown or foreign grant targets do not mutate", async () => {
  const f = await fixture();
  await f.api.createProject(f.owner, create("p1", "ONE"));
  const viewerActor = actor("viewer", "w1");
  const viewer = f.access.issue(viewerActor);
  f.access.issue(actor("foreign", "w2"));
  f.access.issue(actor("admin", "w1", "admin"));
  await f.api.authorizeProjectPrincipal(f.owner, "p1", "admin");
  await assert.rejects(f.api.authorizeProjectPrincipal(f.owner, "p1", "viewer"), code("not_found"));
  for (const principalId of ["foreign", "absent"]) {
    const before = await snapshot(f);
    await assert.rejects(
      f.api.grantProjectRole(f.owner, {
        projectId: "p1",
        expectedVersion: 1,
        principalId,
        role: "editor",
        operationId: `grant-${principalId}`,
      }),
      code("not_found"),
    );
    await assert.rejects(
      f.api.authorizeProjectPrincipal(f.owner, "p1", principalId),
      code("not_found"),
    );
    assert.deepEqual(await snapshot(f), before);
  }
  await f.api.grantProjectRole(f.owner, {
    projectId: "p1",
    expectedVersion: 1,
    principalId: "viewer",
    role: "viewer",
    operationId: "grant",
  });
  await f.api.authorizeProjectPrincipal(f.owner, "p1", "viewer");
  await assert.rejects(f.api.authorizeProjectPrincipal(viewer, "p1", "owner"), code("forbidden"));
  f.access.revoke(viewer);
  await assert.rejects(f.api.authorizeProjectPrincipal(f.owner, "p1", "viewer"), code("not_found"));
  const before = await snapshot(f);
  await assert.rejects(
    f.api.grantProjectRole(f.owner, {
      projectId: "p1",
      expectedVersion: 2,
      principalId: "viewer",
      role: "editor",
      operationId: "inactive",
    }),
    code("not_found"),
  );
  assert.deepEqual(await snapshot(f), before);
});

test("event readers are composition-bound capabilities with workspace-local ordered pagination", async () => {
  const f = await fixture();
  const other = platform.createProjects({
    store: f.rawStore,
    access: f.access.access,
    clock: { now: () => 1 },
    ids: { next: () => crypto.randomUUID() },
    eventConsumer: "other",
  });
  for (const cap of [{}, undefined, other.eventReader])
    await assert.rejects(f.api.readEvents(cap, "w1", 0, 10), code("forbidden"));
  const noReader = platform.createProjects({
    store: f.rawStore,
    access: f.access.access,
    clock: { now: () => 1 },
    ids: { next: () => crypto.randomUUID() },
  });
  await assert.rejects(noReader.api.readEvents(f.eventReader, "w1", 0, 10), code("forbidden"));
  await f.api.createProject(f.owner, create("p1", "ONE"));
  await f.api.renameProject(f.owner, edit("p1", 1));
  const a = await f.api.readEvents(f.eventReader, "w1", 0, 1);
  const b = await f.api.readEvents(f.eventReader, "w1", a[0].cursor, 1);
  assert.deepEqual(
    [...a, ...b].map((e) => [e.cursor, e.aggregateVersion]),
    [
      [1, 1],
      [2, 2],
    ],
  );
  assert.notEqual(a[0].eventId, b[0].eventId);
  assert.deepEqual(await f.api.readEvents(f.eventReader, "w1", b[0].cursor, 1), []);
  assert.deepEqual(await f.api.readEvents(f.eventReader, "w2", 0, 100), []);
});

test("validation covers all public argument boundaries and accepts documented maxima", async () => {
  const f = await fixture();
  await f.api.createProject(f.owner, create("p1", "ONE"));
  const before = await snapshot(f);
  for (const [method, makeInput] of commands) {
    for (const value of [null, [], "input"])
      await assert.rejects(f.api[method](f.owner, value), code("validation"));
    for (const value of ["", "x".repeat(129), "a/b", 1, null]) {
      await assert.rejects(
        f.api[method](f.owner, { ...makeInput(), projectId: value }),
        code("validation"),
      );
      await assert.rejects(
        f.api[method](f.owner, { ...makeInput(), operationId: value }),
        code("validation"),
      );
    }
    if (method.includes("Role")) {
      for (const value of ["", "x".repeat(129), "a/b", null])
        await assert.rejects(
          f.api[method](f.owner, { ...makeInput(), principalId: value }),
          code("validation"),
        );
    }
    if (method !== "createProject")
      for (const value of [0, -1, 1.5, "1", null, Number.MAX_SAFE_INTEGER, Infinity])
        await assert.rejects(
          f.api[method](f.owner, { ...makeInput(), expectedVersion: value }),
          code("validation"),
        );
    if (method === "createProject" || method === "renameProject") {
      for (const value of ["", " ", "x".repeat(513), null, 1])
        await assert.rejects(
          f.api[method](f.owner, { ...makeInput(), name: value }),
          code("validation"),
        );
      for (const value of ["A", "A".repeat(17), "1A", "A_", "認証", null])
        await assert.rejects(
          f.api[method](f.owner, { ...makeInput(), key: value }),
          code("validation"),
        );
    }
  }
  for (const role of ["owner", "", null])
    await assert.rejects(
      f.api.grantProjectRole(f.owner, {
        projectId: "p1",
        expectedVersion: 1,
        principalId: "owner",
        operationId: "bad-role",
        role,
      }),
      code("validation"),
    );
  for (const value of ["", "x".repeat(129), "a/b", null]) {
    await assert.rejects(f.api.getProject(f.owner, value), code("validation"));
    await assert.rejects(f.api.authorizeProjectPrincipal(f.owner, "p1", value), code("validation"));
    await assert.rejects(f.api.readOperation(f.owner, value), code("validation"));
  }
  for (const permission of ["admin", null, ""])
    await assert.rejects(f.api.authorizeProject(f.owner, "p1", permission), code("validation"));
  for (const limit of [0, 101, 1.5, "1", null, Infinity]) {
    await assert.rejects(f.api.listVisibleProjects(f.owner, "", limit), code("validation"));
    await assert.rejects(f.api.readEvents(f.eventReader, "w1", 0, limit), code("validation"));
  }
  for (const cursor of [null, 0, false, "a/b", "x".repeat(129)])
    await assert.rejects(f.api.listVisibleProjects(f.owner, cursor), code("validation"));
  for (const cursor of [-1, 1.5, "0", null, Infinity])
    await assert.rejects(f.api.readEvents(f.eventReader, "w1", cursor, 1), code("validation"));
  assert.deepEqual(await snapshot(f), before);
  const max = {
    projectId: "x".repeat(128),
    operationId: "o".repeat(128),
    key: "a".repeat(16),
    name: "n".repeat(512),
  };
  await f.api.createProject(f.owner, max);
  assert.equal((await f.api.getProject(f.owner, max.projectId)).key, "A".repeat(16));
  await f.api.createProject(f.owner, { ...max, key: "A".repeat(16) });
  const normalized = { ...edit(max.projectId, 1, "trim-name"), name: " final " };
  assert.deepEqual(await f.api.renameProject(f.owner, normalized), {
    id: max.projectId,
    version: 2,
  });
  assert.equal((await f.api.getProject(f.owner, max.projectId)).name, "final");
  assert.deepEqual(await f.api.renameProject(f.owner, { ...normalized, name: "final" }), {
    id: max.projectId,
    version: 2,
  });
  await assert.rejects(
    f.api.createProject(f.owner, { ...max, operationId: "other", projectId: "different" }),
    code("conflict"),
  );
});

test("concurrent duplicate operations recover one result and cross-command ID reuse conflicts", async () => {
  const f = await fixture();
  const input = create("p1", "ONE");
  const results = await Promise.all([
    f.api.createProject(f.owner, input),
    f.api.createProject(f.owner, input),
  ]);
  assert.deepEqual(results, [
    { id: "p1", version: 1 },
    { id: "p1", version: 1 },
  ]);
  await assert.rejects(
    f.api.renameProject(f.owner, edit("p1", 1, input.operationId)),
    code("conflict"),
  );
  const rename = edit("p1", 1);
  const renamed = await Promise.all([
    f.api.renameProject(f.owner, rename),
    f.api.renameProject(f.owner, rename),
  ]);
  assert.deepEqual(renamed, [
    { id: "p1", version: 2 },
    { id: "p1", version: 2 },
  ]);
  const stored = await snapshot(f);
  assert.equal(stored.projects_projects[0].version, 2);
  assert.equal(stored.projects_receipts.length, 2);
  assert.equal(stored.projects_events.length, 2);
});

test("10a getProjectIncludingArchived preserves grants, provenance and tenant isolation", async () => {
  const { planningHistoricalContract } = await import("./planning-provider-contract.mjs");
  const f = await fixture();
  await f.api.createProject(f.owner, create("p1", "ONE"));
  const viewer = f.access.issue(actor("reader", "w1"));
  await f.api.grantProjectRole(f.owner, {
    operationId: "grant-reader",
    projectId: "p1",
    principalId: "reader",
    role: "viewer",
    expectedVersion: 1,
  });
  await planningHistoricalContract({
    get: f.api.getProjectIncludingArchived,
    id: "p1",
    authorized: viewer,
    denied: f.access.issue(actor("outsider", "w1")),
    archive: () =>
      f.api.archiveProject(f.owner, {
        operationId: "archive",
        projectId: "p1",
        expectedVersion: 2,
      }),
  });
  await assert.rejects(
    f.api.getProjectIncludingArchived(f.access.issue(actor("owner", "w2", "owner")), "p1"),
    code("not_found"),
  );
  await assert.rejects(f.api.authorizeProject(f.owner, "p1", "write"), code("not_found"));
});
