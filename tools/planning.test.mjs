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
    d1Databases: Array.from({ length: 16 }, (_, i) => `PLAN${i}`),
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
      if (id !== "p1" || archivedProject) throw new p.PlatformError("not_found", "project");
      return { id, archived: false };
    },
    async getProjectIncludingArchived(s, id) {
      await fake.access.authorize(s);
      if (id !== "p1") throw new p.PlatformError("not_found", "project");
      return { id, archived: archivedProject };
    },
  };
  let archivedProject = false,
    archivedIssue = false,
    calls = 0,
    deniedIssue = false;
  const issues = {
    async authorizeIssue(s, id) {
      calls++;
      await fake.access.authorize(s);
      if (id !== "i1" && id !== "i2") throw new p.PlatformError("not_found", "issue");
      if (archivedIssue || deniedIssue) throw new p.PlatformError("not_found", "issue unavailable");
      return { id, projectId: id === "i2" ? "p2" : "p1", archived: false };
    },
    async getIssueIncludingArchived(s, id) {
      await fake.access.authorize(s);
      return {
        id,
        projectId: "p1",
        reference: id,
        title: `Title ${id}`,
        state: "todo",
        archived: archivedIssue,
      };
    },
  };
  const raw = p.createModuleStore(db, "planning");
  let failBatch = false;
  let failAfter = false;
  const store = {
    ...raw,
    async batch(c) {
      if (failBatch) {
        failBatch = false;
        throw Error("response lost");
      }
      const result = await raw.batch(c);
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
