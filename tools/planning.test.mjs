import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

let p,
  mf,
  serial = 0;
const code = (c) => (e) => e?.code === c;
before(async () => {
  fs.mkdirSync(".tmp", { recursive: true });
  const built = await build({
    entryPoints: ["tools/planning-test-entry.ts"],
    outfile: ".tmp/test-entry.mjs",
    bundle: true,
    format: "esm",
    platform: "node",
    metafile: true,
  });
  assert(
    Object.keys(built.metafile.inputs).every(
      (x) =>
        !x.startsWith("modules/issues/internal/") && !x.startsWith("modules/projects/internal/"),
    ),
  );
  p = await import("../.tmp/test-entry.mjs");
  mf = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('ok')}}",
    compatibilityDate: "2026-07-30",
    d1Databases: Array.from({ length: 40 }, (_, i) => `PLAN${i}`),
  });
});
after(async () => mf?.dispose());
async function fixture() {
  const db = await mf.getD1Database(`PLAN${serial++}`);
  await p.migrate(db, ["planning"]);
  const fake = p.fakeAccess();
  const scope = (workspaceId = "w1", id = "editor", role = "member") =>
    fake.issue({ id, workspaceId, kind: "machine", role, scope: "write", active: true });
  const editor = scope();
  const projects = {
    async authorizeProject(s, id, mode = "read") {
      await fake.access.authorize(s, mode);
      if (s.principalId === "outsider" || !["p1", "p12"].includes(id) || archivedProject)
        throw new p.PlatformError("not_found", "project");
      return { id, archived: false };
    },
    async getProjectIncludingArchived(s, id) {
      await fake.access.authorize(s);
      if (s.principalId === "outsider" || !["p1", "p12"].includes(id))
        throw new p.PlatformError("not_found", "project");
      return { id, archived: archivedProject };
    },
  };
  let archivedProject = false,
    archivedIssue = false,
    calls = 0,
    deniedIssue = false;
  let liveState = "todo",
    reads = [],
    writes = [];
  const issues = {
    async authorizeIssue(s, id) {
      calls++;
      await fake.access.authorize(s);
      if (id !== "i1" && id !== "i2") throw new p.PlatformError("not_found", "issue");
      if (archivedIssue || deniedIssue) throw new p.PlatformError("not_found", "issue unavailable");
      return { id, projectId: id === "i2" ? "p2" : "p1", archived: false };
    },
    async getIssueIncludingArchived(s, id) {
      reads.push(id);
      await fake.access.authorize(s);
      if (s.principalId === "outsider" || deniedIssue || !/^i[0-9]+$/.test(id))
        throw new p.PlatformError("not_found", "issue");
      return {
        id,
        projectId: "p1",
        reference: id,
        title: `Title ${id}`,
        state: liveState,
        archived: archivedIssue,
      };
    },
  };
  for (const method of [
    "createIssue",
    "editIssue",
    "transitionIssue",
    "assignIssue",
    "addComment",
    "archiveIssue",
  ])
    issues[method] = async (...args) => {
      writes.push({ method, args });
      return { id: "i1", version: 2 };
    };
  const raw = p.createModuleStore(db, "planning");
  let failBatch = false;
  let failAfter = false;
  let batchHook;
  const store = {
    ...raw,
    async batch(c) {
      if (failBatch) {
        failBatch = false;
        throw Error("response lost");
      }
      const result = await raw.batch(batchHook ? await batchHook(c) : c);
      if (failAfter) {
        failAfter = false;
        throw Error("response lost after commit");
      }
      return result;
    },
  };
  let n = 0;
  const result = p.createPlanning({
    store,
    access: fake.access,
    projects,
    issues,
    clock: { now: () => 123 },
    ids: { next: () => `id${++n}` },
    eventConsumer: "test",
  });
  return {
    ...result,
    db,
    scope,
    editor,
    fake,
    issues,
    projects,
    reads,
    writes,
    setState: (value) => {
      liveState = value;
    },
    setBatchHook: (hook) => {
      batchHook = hook;
    },
    getCalls: () => calls,
    archiveIssue: () => (archivedIssue = true),
    denyIssue: () => (deniedIssue = true),
    archiveProject: () => (archivedProject = true),
    failBatch: () => (failBatch = true),
    failAfter: () => (failAfter = true),
  };
}
const create = (op = "create") => ({
  operationId: op,
  sprintId: "s1",
  projectId: "p1",
  name: "Next",
});
test("rules, CAS, retry, membership uniqueness and historical reads", async () => {
  const f = await fixture();
  const { api, editor } = f;
  assert.deepEqual(await api.createSprint(editor, create()), { id: "s1", version: 1 });
  assert.deepEqual(await api.createSprint(editor, create()), { id: "s1", version: 1 });
  await assert.rejects(api.createSprint(editor, { ...create(), name: "Other" }), code("conflict"));
  await assert.rejects(
    api.createSprint(editor, { ...create("blank"), name: " " }),
    code("validation"),
  );
  const a = { operationId: "schedule", sprintId: "s1", issueId: "i1", expectedVersion: 1 };
  assert.deepEqual(await api.scheduleIssue(editor, a), { id: "s1", version: 2 });
  assert.deepEqual(await api.scheduleIssue(editor, a), { id: "s1", version: 2 });
  assert.equal((await api.getSprintItems(editor, "s1")).items.length, 1);
  await assert.rejects(api.scheduleIssue(editor, { ...a, operationId: "stale" }), code("conflict"));
  await assert.rejects(
    api.scheduleIssue(editor, { ...a, operationId: "duplicate", expectedVersion: 2 }),
    code("conflict"),
  );
  f.archiveIssue();
  assert.equal((await api.getSprintItems(editor, "s1")).items[0].archived, true);
  f.archiveProject();
  assert.equal((await api.getSprintItems(editor, "s1")).sprint.archived, true);
  await assert.rejects(
    api.scheduleIssue(editor, {
      operationId: "archived",
      sprintId: "s1",
      issueId: "i2",
      expectedVersion: 2,
    }),
    code("not_found"),
  );
  const closed = await api
    .closeSprint(editor, { operationId: "close", sprintId: "s1", expectedVersion: 2 })
    .catch((e) => e);
  assert.equal(closed.code, "not_found");
});
test("unschedule removes membership, enforces CAS, and archived items are read-only", async () => {
  const f = await fixture(),
    { api, editor } = f;
  await api.createSprint(editor, create());
  await assert.rejects(
    api.scheduleIssue(editor, {
      operationId: "wrong-project",
      sprintId: "s1",
      issueId: "i2",
      expectedVersion: 1,
    }),
    code("not_found"),
  );
  f.denyIssue();
  await assert.rejects(
    api.scheduleIssue(editor, {
      operationId: "invisible",
      sprintId: "s1",
      issueId: "i1",
      expectedVersion: 1,
    }),
    code("not_found"),
  );
  const g = await fixture(),
    a = g.api,
    u = g.editor;
  await a.createSprint(u, create());
  await a.scheduleIssue(u, {
    operationId: "schedule",
    sprintId: "s1",
    issueId: "i1",
    expectedVersion: 1,
  });
  await assert.rejects(
    a.unscheduleIssue(u, {
      operationId: "stale",
      sprintId: "s1",
      issueId: "i1",
      expectedVersion: 1,
    }),
    code("conflict"),
  );
  g.archiveIssue();
  await assert.rejects(
    a.unscheduleIssue(u, {
      operationId: "archived",
      sprintId: "s1",
      issueId: "i1",
      expectedVersion: 2,
    }),
    code("not_found"),
  );
  // A fresh fixture proves the normal unschedule path and its duplicate-retry receipt.
  const h = await fixture(),
    b = h.api,
    v = h.editor;
  await b.createSprint(v, create());
  await b.scheduleIssue(v, {
    operationId: "schedule",
    sprintId: "s1",
    issueId: "i1",
    expectedVersion: 1,
  });
  const remove = { operationId: "remove", sprintId: "s1", issueId: "i1", expectedVersion: 2 };
  assert.deepEqual(await b.unscheduleIssue(v, remove), { id: "s1", version: 3 });
  assert.deepEqual(await b.unscheduleIssue(v, remove), { id: "s1", version: 3 });
  assert.equal((await b.getSprintItems(v, "s1")).items.length, 0);
});
test("close keeps items readable and releases open membership without Issues writes", async () => {
  const f = await fixture();
  const { api, editor } = f;
  await api.createSprint(editor, create());
  await api.scheduleIssue(editor, {
    operationId: "s",
    sprintId: "s1",
    issueId: "i1",
    expectedVersion: 1,
  });
  await api.closeSprint(editor, { operationId: "c", sprintId: "s1", expectedVersion: 2 });
  assert.equal((await api.getSprintItems(editor, "s1")).items.length, 1);
  await api.createSprint(editor, {
    operationId: "c2",
    sprintId: "s2",
    projectId: "p1",
    name: "Later",
  });
  await api.scheduleIssue(editor, {
    operationId: "s2",
    sprintId: "s2",
    issueId: "i1",
    expectedVersion: 1,
  });
  assert.equal((await api.getSprintItems(editor, "s2")).items.length, 1);
  assert.equal(f.getCalls(), 2);
});
test("two workspaces, authorization, rollback and operation recovery", async () => {
  const f = await fixture();
  const { api, editor } = f;
  await api.createSprint(editor, create());
  const other = f.scope("w2");
  assert.deepEqual(await api.listSprints(other, "p1"), []);
  await assert.rejects(api.getSprintItems(other, "s1"), code("not_found"));
  const viewer = f.scope("w1", "viewer", "viewer");
  await assert.rejects(api.createSprint(viewer, create("denied")), code("forbidden"));
  f.failBatch();
  await assert.rejects(
    api.scheduleIssue(editor, {
      operationId: "failed",
      sprintId: "s1",
      issueId: "i1",
      expectedVersion: 1,
    }),
    code("unknown"),
  );
  assert.equal((await api.getSprintItems(editor, "s1")).items.length, 0);
  assert.equal(await api.readOperation(editor, "failed"), null);
  await api.scheduleIssue(editor, {
    operationId: "retry",
    sprintId: "s1",
    issueId: "i1",
    expectedVersion: 1,
  });
  assert.deepEqual(await api.readOperation(editor, "retry"), { id: "s1", version: 2 });
  assert.equal((await api.readEvents(f.eventReader, "w1", 0, 10)).length, 2);
});

test("committed response loss and concurrent schedules recover one winner", async () => {
  const f = await fixture(),
    { api, editor } = f;
  await api.createSprint(editor, create());
  f.failAfter();
  const first = { operationId: "lost", sprintId: "s1", issueId: "i1", expectedVersion: 1 };
  assert.deepEqual(await api.scheduleIssue(editor, first), { id: "s1", version: 2 });
  assert.deepEqual(await api.scheduleIssue(editor, first), { id: "s1", version: 2 });
  assert.equal((await api.getSprintItems(editor, "s1")).items.length, 1);
  await api.createSprint(editor, {
    operationId: "second",
    sprintId: "s2",
    projectId: "p1",
    name: "Second",
  });
  const results = await Promise.allSettled([
    api.scheduleIssue(editor, {
      operationId: "race-a",
      sprintId: "s2",
      issueId: "i1",
      expectedVersion: 1,
    }),
    api.scheduleIssue(editor, {
      operationId: "race-b",
      sprintId: "s2",
      issueId: "i1",
      expectedVersion: 1,
    }),
  ]);
  assert(results.every((r) => r.status === "rejected" && r.reason.code === "conflict"));
  assert.equal((await api.getSprintItems(editor, "s2")).items.length, 0);
});

const schedule = (overrides = {}) => ({
  operationId: "schedule",
  sprintId: "s1",
  issueId: "i1",
  expectedVersion: 1,
  ...overrides,
});
async function snapshot(f) {
  const result = {};
  for (const table of ["sprints", "items", "history", "receipts", "events", "guards"])
    result[table] = (
      await f.db.prepare(`SELECT * FROM planning_${table} ORDER BY rowid`).all()
    ).results;
  return result;
}
test("10a scheduling rejects foreign project/workspace and invisible issue without writes", async () => {
  const f = await fixture();
  await f.api.createSprint(f.editor, create());
  const before = await snapshot(f);
  for (const [scope, input] of [
    [f.editor, schedule({ issueId: "i2" })],
    [f.scope("w2"), schedule()],
  ])
    await assert.rejects(f.api.scheduleIssue(scope, input), code("not_found"));
  f.denyIssue();
  await assert.rejects(f.api.scheduleIssue(f.editor, schedule()), code("not_found"));
  assert.deepEqual(await snapshot(f), before);
});
test("10a closed sprint rejects schedule and unschedule and close performs zero Issues writes", async () => {
  const f = await fixture();
  await f.api.createSprint(f.editor, create());
  await f.api.scheduleIssue(f.editor, schedule());
  await assert.doesNotReject(
    f.api.closeSprint(f.editor, { operationId: "close", sprintId: "s1", expectedVersion: 2 }),
  );
  assert.deepEqual(f.writes, []);
  const before = await snapshot(f);
  for (const method of ["scheduleIssue", "unscheduleIssue"])
    await assert.rejects(
      f.api[method](f.editor, schedule({ operationId: method, expectedVersion: 3 })),
      code("conflict"),
    );
  assert.deepEqual(await snapshot(f), before);
});
for (const method of ["createSprint", "scheduleIssue", "unscheduleIssue", "closeSprint"]) {
  test(`10a ${method} fingerprint, retry and atomic rollback`, async () => {
    const f = await fixture(),
      a = f.api,
      u = f.editor;
    if (method !== "createSprint") await a.createSprint(u, create());
    if (method === "unscheduleIssue") await a.scheduleIssue(u, schedule());
    const input =
      method === "createSprint"
        ? create("audit")
        : method === "closeSprint"
          ? { operationId: "audit", sprintId: "s1", expectedVersion: 1 }
          : schedule({
              operationId: "audit",
              expectedVersion: method === "unscheduleIssue" ? 2 : 1,
            });
    const before = await snapshot(f);
    f.setBatchHook((calls) =>
      calls.map((c) =>
        c.name === "event"
          ? { ...c, values: [...c.values.slice(0, 2), null, ...c.values.slice(3)] }
          : c,
      ),
    );
    await assert.rejects(a[method](u, input));
    assert.deepEqual(
      await snapshot(f),
      before,
      "late transaction failure must roll everything back",
    );
    f.setBatchHook(undefined);
    const result = await a[method](u, input),
      committed = await snapshot(f);
    assert.deepEqual(await a[method](u, input), result);
    assert.deepEqual(
      await snapshot(f),
      committed,
      "retry must not duplicate items or audit records",
    );
    for (const key of Object.keys(input).filter((k) => k !== "operationId")) {
      const changed = {
        ...input,
        [key]: key === "expectedVersion" ? input[key] + 1 : `${input[key]}2`,
      };
      await assert.rejects(
        a[method](u, changed),
        code("conflict"),
        `${method} fingerprint binds ${key}`,
      );
    }
    assert.deepEqual(await snapshot(f), committed);
  });
}
for (const method of ["scheduleIssue", "unscheduleIssue", "closeSprint"]) {
  test(`10a ${method} storage CAS rejects a race after admission`, async () => {
    const f = await fixture();
    await f.api.createSprint(f.editor, create());
    if (method === "unscheduleIssue") await f.api.scheduleIssue(f.editor, schedule());
    const expectedVersion = method === "unscheduleIssue" ? 2 : 1;
    f.setBatchHook(async (calls) => {
      await f.db
        .prepare(
          "UPDATE planning_sprints SET version=version+1 WHERE workspace_id='w1' AND id='s1'",
        )
        .run();
      return calls;
    });
    const before = await snapshot(f);
    await assert.rejects(
      f.api[method](f.editor, { ...schedule({ operationId: "race", expectedVersion }) }),
      code("conflict"),
    );
    before.sprints[0].version++;
    assert.deepEqual(
      await snapshot(f),
      before,
      "loser must leave no item, receipt, event or history",
    );
  });
}
test("10a two open sprints race for one issue and a retry cannot duplicate the winner", async () => {
  const f = await fixture();
  await f.api.createSprint(f.editor, create());
  await f.api.createSprint(f.editor, { ...create("second"), sprintId: "s2" });
  const inputs = [schedule(), schedule({ operationId: "second-schedule", sprintId: "s2" })];
  const result = await Promise.allSettled(inputs.map((i) => f.api.scheduleIssue(f.editor, i)));
  assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(result.find((r) => r.status === "rejected")?.reason.code, "conflict");
  const winner = result.findIndex((r) => r.status === "fulfilled");
  const before = await snapshot(f);
  assert.deepEqual(await f.api.scheduleIssue(f.editor, inputs[winner]), result[winner].value);
  assert.deepEqual(await snapshot(f), before);
  assert.equal(before.items.length, 1);
});
test("10a item reads are live, bounded and exactly once per returned item", async () => {
  const f = await fixture();
  await f.api.createSprint(f.editor, create());
  // Seed only the owning table: isolate paging from 101 command round trips.
  await f.db.batch(
    Array.from({ length: 101 }, (_, i) =>
      f.db
        .prepare("INSERT INTO planning_items VALUES('w1','s1',?,1,1)")
        .bind(`i${String(i).padStart(3, "0")}`),
    ),
  );
  let page = await f.api.getSprintItems(f.editor, "s1");
  assert.equal(page.items.length, 50);
  assert.equal(page.nextCursor, "i049");
  assert.equal(f.reads.length, 50);
  f.reads.length = 0;
  page = await f.api.getSprintItems(f.editor, "s1", { limit: 100 });
  assert.equal(page.items.length, 100);
  assert.equal(page.nextCursor, "i099");
  assert.deepEqual(
    f.reads,
    page.items.map((i) => i.issueId),
  );
  f.setState("done");
  f.reads.length = 0;
  const tail = await f.api.getSprintItems(f.editor, "s1", { cursor: page.nextCursor, limit: 100 });
  assert.deepEqual(
    tail.items.map((i) => i.issueId),
    ["i100"],
  );
  assert.equal(tail.nextCursor, null);
  assert.equal(tail.items[0].issue.state, "done");
  assert.deepEqual(f.reads, ["i100"]);
  const changed = await f.api.getSprintItems(f.editor, "s1", { limit: 1 });
  assert.equal(changed.items[0].issue.state, "done");
  for (const limit of [0, 101, -1, 1.5, null])
    await assert.rejects(f.api.getSprintItems(f.editor, "s1", { limit }), code("validation"));
  for (const cursor of [null, false, "", "../bad"])
    await assert.rejects(f.api.getSprintItems(f.editor, "s1", { cursor }), code("validation"));
  f.denyIssue();
  assert.deepEqual((await f.api.getSprintItems(f.editor, "s1", { limit: 1 })).items, [
    { issueId: "i000", issue: null, archived: true },
  ]);
});
test("10a event reader requires exact factory capability and tenant page bounds", async () => {
  const f = await fixture(),
    g = await fixture();
  await f.api.createSprint(f.editor, create());
  for (const reader of [undefined, {}, { ...f.eventReader }, g.eventReader])
    await assert.rejects(f.api.readEvents(reader, "w1", 0, 10), code("forbidden"));
  assert.deepEqual(await f.api.readEvents(f.eventReader, "w2", 0, 10), []);
  const [event] = await f.api.readEvents(f.eventReader, "w1", 0, 1);
  assert.equal(event.type, "SprintChanged");
  assert.deepEqual(await f.api.readEvents(f.eventReader, "w1", event.cursor, 1), []);
});

test("10a Planning historical provider fakes obey the owner contract", async () => {
  const { planningHistoricalContract } = await import("./planning-provider-contract.mjs");
  const f = await fixture();
  for (const [get, id, archive] of [
    [f.projects.getProjectIncludingArchived, "p1", f.archiveProject],
    [f.issues.getIssueIncludingArchived, "i1", f.archiveIssue],
  ])
    await planningHistoricalContract({
      get,
      id,
      archive,
      authorized: f.editor,
      denied: f.scope("w1", "outsider"),
    });
});

test("10a populated tenants isolate identical sprint, issue and operation IDs", async () => {
  const f = await fixture(),
    other = f.scope("w2");
  for (const scope of [f.editor, other]) {
    await f.api.createSprint(scope, { ...create(), name: scope.workspaceId });
    await f.api.scheduleIssue(scope, schedule());
  }
  await f.api.unscheduleIssue(f.editor, schedule({ operationId: "remove", expectedVersion: 2 }));
  assert.equal((await f.api.getSprintItems(f.editor, "s1")).items.length, 0);
  const foreign = await f.api.getSprintItems(other, "s1");
  assert.equal(foreign.sprint.name, "w2");
  assert.equal(foreign.sprint.version, 2);
  assert.deepEqual(
    foreign.items.map((i) => i.issueId),
    ["i1"],
  );
  assert.equal(await f.api.readOperation(other, "remove"), null);
  assert.equal(await f.api.readOperation(f.scope("w1", "another-actor"), "schedule"), null);
  assert.equal((await f.api.readEvents(f.eventReader, "w2", 0, 100)).length, 2);
  await assert.rejects(f.api.getSprintItems(f.scope("w1", "outsider"), "s1"), code("not_found"));
});
