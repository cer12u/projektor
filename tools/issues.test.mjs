import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { projectsConsumerContract } from "./projects-consumer-contract.mjs";

let platform;
let mf;
let counter = 0;
const code = (name) => (error) => error.code === name;
const input = (issueId, operationId = `create-${issueId}`, projectId = "p1") => ({
  issueId,
  operationId,
  projectId,
  title: "First title",
  description: "initial body",
  priority: "medium",
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
    d1Databases: Array.from({ length: 60 }, (_, i) => `ISSUES${i}`),
  });
});
after(async () => {
  await mf?.dispose();
});

async function fixture() {
  const db = await mf.getD1Database(`ISSUES${counter++}`);
  await platform.migrate(db, ["issues"]);
  const rawStore = platform.createModuleStore(db, "issues");
  const state = {
    hook: null,
    denied: new Set(),
    archived: new Set(),
    readHook: null,
    grants: new Map(),
    members: new Map(),
  };
  const store = {
    owner: "issues",
    run: async (...args) => {
      const result = await rawStore.run(...args);
      return state.readHook ? state.readHook(args, result) : result;
    },
    batch: (calls) => (state.hook ? state.hook(calls) : rawStore.batch(calls)),
  };
  const auth = platform.fakeAccess();
  const issueScope = (w, p, kind = "human", overrides = {}) =>
    auth.issue({
      id: p,
      workspaceId: w,
      kind,
      role: "member",
      scope: "write",
      active: true,
      ...overrides,
    });
  const projectKey = (projectId) => (projectId === "p2" ? "TWO" : "ONE");
  const projects = {
    async authorizeProject(s, projectId, permission = "read") {
      await auth.access.authorize(s, "read");
      if (!["p1", "p2"].includes(projectId) || state.archived.has(`${s.workspaceId}:${projectId}`))
        throw new platform.PlatformError("not_found", "Project absent");
      if (state.denied.has(`${s.workspaceId}:${s.principalId}:${projectId}`))
        throw new platform.PlatformError("not_found", "Project absent");
      if (permission !== "read") {
        if (state.grants.get(`${s.workspaceId}:${s.principalId}:${projectId}`) === "viewer")
          throw new platform.PlatformError("forbidden", "Read only");
        await auth.access.authorize(s, "write");
      }
      return {
        id: projectId,
        key: projectKey(projectId),
        name: projectId,
        version: 1,
        archived: false,
        role: "editor",
      };
    },
    async getProjectIncludingArchived(s, projectId) {
      await auth.access.authorize(s, "read");
      if (
        !["p1", "p2"].includes(projectId) ||
        state.denied.has(`${s.workspaceId}:${s.principalId}:${projectId}`)
      )
        throw new platform.PlatformError("not_found", "Project absent");
      return {
        id: projectId,
        key: projectKey(projectId),
        archived: state.archived.has(`${s.workspaceId}:${projectId}`),
      };
    },
    async getProject(s, projectId) {
      return this.authorizeProject(s, projectId);
    },
    async listVisibleProjects(s, cursor = "") {
      const all = ["p1", "p2"];
      const visible = [];
      for (const projectId of all) {
        if (projectId <= cursor) continue;
        try {
          visible.push(await this.authorizeProject(s, projectId));
        } catch (error) {
          if (!(error instanceof platform.PlatformError) || error.code !== "not_found") throw error;
        }
      }
      return { projects: visible, nextCursor: null };
    },
    async authorizeProjectPrincipal(s, projectId, principalId) {
      await this.authorizeProject(s, projectId, "write");
      if (
        !state.members.has(`${s.workspaceId}:${principalId}`) ||
        state.denied.has(`${s.workspaceId}:${principalId}:${projectId}`)
      )
        throw new platform.PlatformError("not_found", "Assignee lacks project access");
    },
  };
  const access = auth.access;
  state.members.set("w1:human", "human");
  state.members.set("w1:bot", "machine");
  state.members.set("w2:human", "human");
  const deps = {
    store,
    projects,
    access,
    clock: { now: () => 1800000000 },
    ids: { next: () => crypto.randomUUID() },
    eventConsumer: "test",
  };
  const { api, eventReader } = platform.createIssues(deps);
  return {
    db,
    rawStore,
    state,
    api,
    eventReader,
    deps,
    auth,
    issueScope,
    projects,
    human: issueScope("w1", "human"),
    bot: issueScope("w1", "bot", "machine"),
    other: issueScope("w2", "human"),
  };
}

test("fixed state graph and literal FTS tokenization without storage", () => {
  const rules = platform.issuesRules;
  const allowed = new Set([
    "todo:in_progress",
    "todo:cancelled",
    "in_progress:todo",
    "in_progress:done",
    "in_progress:cancelled",
    "done:in_progress",
    "cancelled:todo",
  ]);
  for (const from of ["todo", "in_progress", "done", "cancelled"])
    for (const to of ["todo", "in_progress", "done", "cancelled"])
      assert.equal(rules.canTransition(from, to), allowed.has(`${from}:${to}`), `${from}:${to}`);
  assert.equal(
    rules.searchExpression(rules.searchTerms('hello" OR * world')),
    '"hello""" AND "OR" AND "world"',
  );
  assert.deepEqual(rules.searchTerms("***"), []);
});

test("rules, fixed transitions, assignee admission and machine history", async () => {
  const f = await fixture();
  await assert.rejects(
    f.api.createIssue(f.human, { ...input("x"), title: "" }),
    code("validation"),
  );
  await assert.rejects(
    f.api.createIssue(f.human, { ...input("x"), priority: "blocker" }),
    code("validation"),
  );
  await f.api.createIssue(f.bot, input("x"));
  await assert.rejects(
    f.api.transitionIssue(f.bot, {
      issueId: "x",
      expectedVersion: 1,
      state: "done",
      operationId: "skip",
    }),
    code("conflict"),
  );
  const moved = await f.api.transitionIssue(f.bot, {
    issueId: "x",
    expectedVersion: 1,
    state: "in_progress",
    operationId: "start",
  });
  assert.equal(moved.version, 2);
  await assert.rejects(
    f.api.assignIssue(f.bot, {
      issueId: "x",
      expectedVersion: 2,
      assigneeId: "absent",
      operationId: "bad-assignee",
    }),
    code("not_found"),
  );
  f.state.denied.add("w1:human:p1");
  await assert.rejects(
    f.api.assignIssue(f.bot, {
      issueId: "x",
      expectedVersion: 2,
      assigneeId: "human",
      operationId: "no-grant",
    }),
    code("not_found"),
  );
  f.state.denied.delete("w1:human:p1");
  await f.api.assignIssue(f.bot, {
    issueId: "x",
    expectedVersion: 2,
    assigneeId: "human",
    operationId: "assign",
  });
  await f.api.addComment(f.bot, {
    issueId: "x",
    expectedVersion: 3,
    commentId: "c1",
    body: "Agent update",
    operationId: "comment",
  });
  const history = await f.api.getHistory(f.bot, "x");
  assert.deepEqual(
    history.map((h) => h.action),
    ["create", "transition", "assign", "comment"],
  );
  assert(history.every((h) => h.actorKind === "machine"));
  assert.equal((await f.api.getIssue(f.bot, { projectId: "p1", number: 1 })).reference, "ONE-1");
  assert.equal((await f.api.getIssue(f.bot, { projectId: "p1", reference: "ONE-1" })).id, "x");
  await assert.rejects(
    f.api.getIssue(f.bot, { projectId: "p1", reference: "TWO-1" }),
    code("not_found"),
  );
});

test("concurrent counter allocation, CAS, retry, conflicting reuse and response loss", async () => {
  const f = await fixture();
  const created = await Promise.all(
    Array.from({ length: 10 }, (_, n) => f.api.createIssue(f.human, input(`i${n}`))),
  );
  assert.deepEqual(
    created.map((r) => r.number).sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
  assert.deepEqual(await f.api.createIssue(f.human, input("i0")), created[0]);
  await assert.rejects(
    f.api.createIssue(f.human, { ...input("i0"), title: "changed" }),
    code("conflict"),
  );
  await assert.rejects(
    f.api.editIssue(f.human, {
      issueId: "i0",
      expectedVersion: 8,
      title: "bad",
      description: "",
      priority: "low",
      operationId: "stale",
    }),
    code("conflict"),
  );
  assert.equal(await f.api.readOperation(f.human, "stale"), null);
  const edit = {
    issueId: "i0",
    expectedVersion: 1,
    title: "edited",
    description: "new body",
    priority: "high",
    operationId: "lost",
  };
  f.state.hook = async (calls) => {
    await f.rawStore.batch(calls);
    throw new Error("response lost");
  };
  assert.equal((await f.api.editIssue(f.human, edit)).version, 2);
  f.state.hook = null;
  assert.equal((await f.api.readOperation(f.human, "lost")).version, 2);
  assert.equal((await f.api.editIssue(f.human, edit)).version, 2);
  const racing = await Promise.allSettled([
    f.api.editIssue(f.human, { ...edit, expectedVersion: 2, operationId: "race-a", title: "a" }),
    f.api.editIssue(f.human, { ...edit, expectedVersion: 2, operationId: "race-b", title: "b" }),
  ]);
  assert.equal(racing.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    racing.filter((r) => r.status === "rejected" && r.reason.code === "conflict").length,
    1,
  );
});

test("failed batch rolls back body, FTS, history, receipt and event; edit/archive search consistency", async () => {
  const f = await fixture();
  await f.api.createIssue(f.human, input("x"));
  assert.equal((await f.api.searchIssues(f.human, { projectId: "p1", text: "initial" })).length, 1);
  f.state.hook = (calls) =>
    f.rawStore.batch(
      calls.map((call) =>
        call.name === "event"
          ? { ...call, values: [call.values[0], call.values[1], null, ...call.values.slice(3)] }
          : call,
      ),
    );
  await assert.rejects(
    f.api.editIssue(f.human, {
      issueId: "x",
      expectedVersion: 1,
      title: "changed",
      description: "replacement",
      priority: "high",
      operationId: "failed",
    }),
    code("unknown"),
  );
  assert.equal((await f.api.getIssue(f.human, { issueId: "x" })).version, 1);
  assert.equal((await f.api.searchIssues(f.human, { projectId: "p1", text: "initial" })).length, 1);
  assert.equal(
    (await f.api.searchIssues(f.human, { projectId: "p1", text: "replacement" })).length,
    0,
  );
  assert.equal((await f.api.getHistory(f.human, "x")).length, 1);
  assert.equal(await f.api.readOperation(f.human, "failed"), null);
  f.state.hook = null;
  await f.api.editIssue(f.human, {
    issueId: "x",
    expectedVersion: 1,
    title: "changed",
    description: "replacement",
    priority: "high",
    operationId: "edit",
  });
  assert.equal(
    (await f.api.searchIssues(f.human, { projectId: "p1", text: "replacement" })).length,
    1,
  );
  assert.equal((await f.api.searchIssues(f.human, { projectId: "p1", text: "initial" })).length, 0);
  assert.equal((await f.api.searchIssues(f.human, { projectId: "p1", text: '" OR *' })).length, 0);
  await f.api.archiveIssue(f.human, { issueId: "x", expectedVersion: 2, operationId: "archive" });
  assert.equal((await f.api.readOperation(f.human, "edit")).version, 2);
  assert.equal(
    (
      await f.api.archiveIssue(f.human, {
        issueId: "x",
        expectedVersion: 2,
        operationId: "archive",
      })
    ).version,
    3,
  );
  assert.equal(
    (await f.api.searchIssues(f.human, { projectId: "p1", text: "replacement" })).length,
    0,
  );
  assert.equal((await f.api.listIssues(f.human, { projectId: "p1" })).issues.length, 0);
  assert.deepEqual(
    (await f.api.readEvents(f.eventReader, "w1", 0, 10)).map((e) => e.type),
    ["IssueCreated", "IssueChanged", "IssueArchived"],
  );
});

test("two workspaces, two projects, keyset filters and live revocation", async () => {
  const f = await fixture();
  await f.api.createIssue(f.human, input("same", "w1-create"));
  await f.api.createIssue(f.other, input("same", "w2-create"));
  await f.api.createIssue(f.human, input("second", "w1-second"));
  await f.api.createIssue(f.human, input("p2item", "p2-create", "p2"));
  assert.equal((await f.api.getIssue(f.other, { issueId: "same" })).reference, "ONE-1");
  assert.equal(
    (await f.api.listIssues(f.human, { projectId: "p1", state: "todo", priority: "medium" })).issues
      .length,
    2,
  );
  const page = await f.api.listIssues(f.human, { projectId: "p1", limit: 1 });
  assert.equal(page.issues[0].id, "second");
  assert.equal(
    (await f.api.listIssues(f.human, { projectId: "p1", cursor: page.nextCursor, limit: 1 }))
      .issues[0].id,
    "same",
  );
  assert.equal(
    (await f.api.listIssues(f.human, { projectId: "p1", assigneeId: null })).issues.length,
    2,
  );
  assert.equal((await f.api.searchIssues(f.human, { projectId: "p2", text: "initial" })).length, 1);
  assert.equal((await f.api.searchIssues(f.human, { projectId: "p1", text: "initial" })).length, 2);
  f.state.denied.add("w1:human:p1");
  await assert.rejects(
    f.api.editIssue(f.human, {
      issueId: "same",
      expectedVersion: 1,
      title: "blocked",
      description: "",
      priority: "low",
      operationId: "revoked",
    }),
    code("not_found"),
  );
  await assert.rejects(f.api.readOperation(f.human, "w1-create"), code("not_found"));
  await assert.rejects(
    f.api.searchIssues(f.human, { projectId: "p1", text: "initial" }),
    code("not_found"),
  );
  assert.equal((await f.api.listIssues(f.human, { projectId: "p2" })).issues.length, 1);
  assert.equal((await f.api.getIssue(f.other, { issueId: "same" })).version, 1);
});

const mutations = (issueId = "x", expectedVersion = 1) => [
  [
    "editIssue",
    {
      issueId,
      expectedVersion,
      operationId: "edit",
      title: "Revised",
      description: "new",
      priority: "urgent",
    },
  ],
  [
    "transitionIssue",
    { issueId, expectedVersion, operationId: "transition", state: "in_progress" },
  ],
  ["assignIssue", { issueId, expectedVersion, operationId: "assign", assigneeId: "bot" }],
  [
    "addComment",
    { issueId, expectedVersion, operationId: "comment", commentId: "comment", body: "Note" },
  ],
  ["archiveIssue", { issueId, expectedVersion, operationId: "archive" }],
];
const reads = (f, s) => [
  () => f.api.getIssue(s, { issueId: "x" }),
  () => f.api.getIssue(s, { projectId: "p1", number: 1 }),
  () => f.api.getIssue(s, { projectId: "p1", reference: "ONE-1" }),
  () => f.api.listIssues(s, { projectId: "p1" }),
  () => f.api.searchIssues(s, { projectId: "p1", text: "title" }),
  () => f.api.getHistory(s, "x"),
  () => f.api.authorizeIssue(s, "x"),
  () => f.api.readOperation(s, "create-x"),
];
async function counts(f, workspace = "w1") {
  const result = {};
  for (const table of [
    "issues",
    "counters",
    "comments",
    "history",
    "receipts",
    "events",
    "guards",
    "search",
  ]) {
    result[table] = (
      await f.db
        .prepare(`SELECT COUNT(*) AS n FROM issues_${table} WHERE workspace_id=?`)
        .bind(workspace)
        .first()
    ).n;
  }
  return result;
}

test("all public operations enforce live membership, capability provenance and project visibility", async () => {
  const f = await fixture();
  await f.api.createIssue(f.human, input("x"));
  for (const s of [{ ...f.human }, f.issueScope("w1", "revoked")]) {
    if (s.principalId === "revoked") f.auth.revoke(s);
    for (const call of reads(f, s)) await assert.rejects(call(), code("forbidden"));
    for (const [method, data] of mutations())
      await assert.rejects(f.api[method](s, data), code("forbidden"));
    await assert.rejects(f.api.createIssue(s, input("new")), code("forbidden"));
  }
  f.state.denied.add("w1:human:p1");
  for (const call of reads(f, f.human)) await assert.rejects(call(), code("not_found"));
  for (const [method, data] of mutations())
    await assert.rejects(f.api[method](f.human, data), code("not_found"));
  await assert.rejects(f.api.createIssue(f.human, input("x")), code("not_found"));
  await assert.rejects(f.api.getIssue(f.human, { issueId: "absent" }), code("not_found"));
  f.state.denied.clear();
  f.state.archived.add("w1:p1");
  for (const call of reads(f, f.human)) await assert.rejects(call(), code("not_found"));
  for (const [method, data] of mutations())
    await assert.rejects(f.api[method](f.human, data), code("not_found"));
  assert.deepEqual(await counts(f), {
    issues: 1,
    counters: 1,
    comments: 0,
    history: 1,
    receipts: 1,
    events: 1,
    guards: 0,
    search: 1,
  });
});

test("every write rejects workspace viewer, project viewer, and read-only machine/OAuth scopes", async () => {
  const f = await fixture();
  await f.api.createIssue(f.human, input("x"));
  const viewers = [
    f.issueScope("w1", "workspace-viewer", "human", { role: "viewer" }),
    f.issueScope("w1", "project-viewer"),
    f.issueScope("w1", "readonly-bot", "machine", { scope: "read" }),
    f.issueScope("w1", "oauth-reader", "human", { scope: "read", clientId: "claude-code" }),
  ];
  f.state.grants.set("w1:project-viewer:p1", "viewer");
  for (const s of viewers) {
    assert.equal((await f.api.getIssue(s, { issueId: "x" })).id, "x");
    for (const [method, data] of mutations())
      await assert.rejects(f.api[method](s, data), code("forbidden"));
    await assert.rejects(f.api.createIssue(s, input("new")), code("forbidden"));
    await assert.rejects(f.api.authorizeIssue(s, "x", "write"), code("forbidden"));
  }
  assert.equal((await f.api.getIssue(f.human, { issueId: "x" })).version, 1);
});

test("distinct tenant data, receipts, history, counters and event reader pagination cannot bleed", async () => {
  const f = await fixture();
  await f.api.createIssue(f.human, { ...input("same", "same-op"), title: "Workspace One" });
  await f.api.createIssue(f.other, { ...input("same", "same-op"), title: "Workspace Two" });
  await f.api.createIssue(f.human, input("only-one"));
  await f.api.createIssue(f.human, input("project-two", "p2", "p2"));
  assert.equal((await f.api.getIssue(f.human, { projectId: "p2", number: 1 })).id, "project-two");
  assert.equal((await f.api.getIssue(f.other, { issueId: "same" })).title, "Workspace Two");
  assert.equal(
    (await f.api.getIssue(f.other, { projectId: "p1", number: 1 })).title,
    "Workspace Two",
  );
  assert.equal(
    JSON.parse((await f.api.getHistory(f.other, "same"))[0].detail).title,
    "Workspace Two",
  );
  await assert.rejects(f.api.getIssue(f.other, { issueId: "only-one" }), code("not_found"));
  assert.equal(await f.api.readOperation(f.other, "create-only-one"), null);
  assert.equal(await f.api.readOperation(f.bot, "same-op"), null);
  assert.equal((await f.api.listIssues(f.other, { projectId: "p1" })).issues.length, 1);
  assert.equal((await f.api.searchIssues(f.other, { projectId: "p1", text: "One" })).length, 0);
  const one = await f.api.readEvents(f.eventReader, "w1", 0, 1);
  const rest = await f.api.readEvents(f.eventReader, "w1", one[0].cursor, 100);
  assert.deepEqual(
    [...one, ...rest].map((e) => e.aggregateId),
    ["same", "only-one", "project-two"],
  );
  assert.deepEqual(
    (await f.api.readEvents(f.eventReader, "w2", 0, 100)).map((e) => e.aggregateId),
    ["same"],
  );
  assert.equal((await f.api.readEvents(f.eventReader, "w1", rest.at(-1).cursor, 1)).length, 0);
  assert.equal(new Set([...one, ...rest].map((e) => e.eventId)).size, 3);
  const restarted = platform.createIssues(f.deps);
  await assert.rejects(restarted.api.readEvents(f.eventReader, "w1", 0, 10), code("forbidden"));
  await assert.rejects(f.api.readEvents({}, "w1", 0, 10), code("forbidden"));
  const noReader = platform.createIssues({ ...f.deps, eventConsumer: undefined });
  await assert.rejects(noReader.api.readEvents(undefined, "w1", 0, 10), code("forbidden"));
});

for (const [method, original] of mutations()) {
  test(`${method}: stale CAS, exact retry, changed fingerprint, receipt after restart, atomic failure`, async () => {
    const f = await fixture();
    await f.api.createIssue(f.human, input("x"));
    const baseline = await counts(f);
    await assert.rejects(
      f.api[method](f.human, { ...original, expectedVersion: 8 }),
      code("conflict"),
    );
    assert.deepEqual(await counts(f), baseline);
    assert.equal(await f.api.readOperation(f.human, original.operationId), null);
    f.state.hook = (calls) =>
      f.rawStore.batch(
        calls.map((call) =>
          call.name === "event"
            ? { ...call, values: [call.values[0], call.values[1], null, ...call.values.slice(3)] }
            : call,
        ),
      );
    await assert.rejects(f.api[method](f.human, original), code("unknown"));
    assert.deepEqual(await counts(f), baseline);
    assert.equal((await f.api.getIssue(f.human, { issueId: "x" })).version, 1);
    assert.equal(
      (await f.api.searchIssues(f.human, { projectId: "p1", text: "initial" })).length,
      1,
    );
    f.state.hook = null;
    const result = await f.api[method](f.human, original);
    assert.equal(result.version, 2);
    assert.deepEqual(await f.api[method](f.human, original), result);
    await assert.rejects(
      f.api[method](f.human, { ...original, expectedVersion: 2 }),
      code("conflict"),
    );
    const restart = platform.createIssues(f.deps).api;
    assert.deepEqual(await restart.readOperation(f.human, original.operationId), result);
    assert.deepEqual(await restart[method](f.human, original), result);
    assert.deepEqual(await counts(f), {
      ...baseline,
      comments: method === "addComment" ? 1 : 0,
      history: 2,
      receipts: 2,
      events: 2,
    });
    const events = await f.api.readEvents(f.eventReader, "w1", 0, 100);
    assert.deepEqual(
      events.map((e) => e.aggregateVersion),
      [1, 2],
    );
    assert(
      events.every(
        (e) => e.aggregateId === "x" && e.payload.actorId === "human" && e.schemaVersion === 1,
      ),
    );
  });
}

test("create rollback restores counter; concurrent identical retry emits one result and one event", async () => {
  const f = await fixture();
  f.state.hook = (calls) =>
    f.rawStore.batch(
      calls.map((call) =>
        call.name === "event"
          ? { ...call, values: [call.values[0], call.values[1], null, ...call.values.slice(3)] }
          : call,
      ),
    );
  await assert.rejects(f.api.createIssue(f.human, input("x")), code("unknown"));
  assert.deepEqual(await counts(f), {
    issues: 0,
    counters: 0,
    comments: 0,
    history: 0,
    receipts: 0,
    events: 0,
    guards: 0,
    search: 0,
  });
  f.state.hook = null;
  const [a, b] = await Promise.all([
    f.api.createIssue(f.human, input("x")),
    f.api.createIssue(f.human, input("x")),
  ]);
  assert.deepEqual(a, b);
  assert.equal(a.number, 1);
  await assert.rejects(f.api.createIssue(f.human, input("x", "duplicate")), code("conflict"));
  assert.equal((await f.api.createIssue(f.human, input("next"))).number, 2);
  assert.equal((await f.api.readEvents(f.eventReader, "w1", 0, 100)).length, 2);
});

test("Projects fake satisfies the same consumer contract as the real provider", async () => {
  const f = await fixture();
  const viewer = f.issueScope("w1", "viewer");
  f.state.members.set("w1:viewer", "human");
  f.state.grants.set("w1:viewer:p1", "viewer");
  await projectsConsumerContract({
    api: f.projects,
    editor: f.human,
    viewer,
    projectId: "p1",
    assigneeId: "viewer",
    missingPrincipalId: "absent",
  });
  f.auth.revoke(f.human);
  await assert.rejects(f.projects.authorizeProject(f.human, "p1"), code("forbidden"));
});

test("Japanese, English, mixed and short literal substrings use scoped bounded search", async () => {
  const f = await fixture();
  const add = (s, id, title, projectId = "p1") =>
    f.api.createIssue(s, {
      ...input(id, `create-${id}`, projectId),
      title,
      description: "詳細 body",
    });
  await add(f.human, "japanese", "認証の不具合 OAuth login API");
  await add(f.human, "english", "Authentication LOGIN worker");
  await add(f.human, "literal", "a_ b% c\\ path");
  await add(f.human, "decoy", "ax by cZ path");
  await add(f.human, "foreign-project", "認証の不具合 OAuth login API", "p2");
  await add(f.other, "foreign-workspace", "認証の不具合 OAuth login API");
  for (const text of [
    "認証の",
    "認証",
    "認",
    "不具合",
    "oauth 認証",
    "API 認",
    "認証 login",
    "詳細 OAuth",
  ]) {
    assert.deepEqual(
      (await f.api.searchIssues(f.human, { projectId: "p1", text })).map((i) => i.id),
      ["japanese"],
      text,
    );
  }
  assert.deepEqual(
    (await f.api.searchIssues(f.human, { projectId: "p1", text: "authent" })).map((i) => i.id),
    ["english"],
  );
  assert.equal((await f.api.searchIssues(f.human, { projectId: "p1", text: "LOGIN" })).length, 2);
  for (const text of ["a_", "b%", "c\\", "a_ path"]) {
    assert.deepEqual(
      (await f.api.searchIssues(f.human, { projectId: "p1", text })).map((i) => i.id),
      ["literal"],
      text,
    );
  }
  for (const text of ['認証" OR login', "認証 -login", "a_ OR *"]) {
    assert.equal((await f.api.searchIssues(f.human, { projectId: "p1", text })).length, 0);
  }
  assert.equal(
    (await f.api.searchIssues(f.human, { projectId: "p1", text: "body", limit: 1 })).length,
    1,
  );
  assert.equal(
    (await f.api.searchIssues(f.human, { projectId: "p1", text: "b", limit: 1 })).length,
    1,
  );
  await f.api.editIssue(f.human, {
    ...mutations("japanese")[0][1],
    title: "修正済み",
    description: "resolved",
  });
  assert.equal((await f.api.searchIssues(f.human, { projectId: "p1", text: "認証" })).length, 0);
  assert.equal((await f.api.searchIssues(f.human, { projectId: "p1", text: "修正済" })).length, 1);
  await f.api.archiveIssue(f.human, {
    issueId: "japanese",
    operationId: "archive",
    expectedVersion: 2,
  });
  assert.equal((await f.api.searchIssues(f.human, { projectId: "p1", text: "修" })).length, 0);
});

test("actor and acting client persist across all history/comments/events and replay", async () => {
  const f = await fixture();
  const oauth = f.issueScope("w1", "human", "human", { clientId: "claude-code-client" });
  await f.api.createIssue(oauth, input("x"));
  let v = 1;
  for (const [method, data] of mutations().slice(0, 4))
    await f.api[method](oauth, { ...data, expectedVersion: v++ });
  const history = await f.api.getHistory(oauth, "x");
  assert.deepEqual(
    history.map((h) => h.version),
    [1, 2, 3, 4, 5],
  );
  assert(
    history.every(
      (h) =>
        h.actorId === "human" &&
        h.actorKind === "human" &&
        h.clientId === "claude-code-client" &&
        h.occurredAt === 1800000000,
    ),
  );
  const comment = await f.db
    .prepare(
      "SELECT actor_id,actor_kind,client_id,body FROM issues_comments WHERE workspace_id=? AND id=?",
    )
    .bind("w1", "comment")
    .first();
  assert.deepEqual(comment, {
    actor_id: "human",
    actor_kind: "human",
    client_id: "claude-code-client",
    body: "Note",
  });
  await f.api.archiveIssue(oauth, { issueId: "x", operationId: "archive", expectedVersion: 5 });
  assert(
    (await f.api.readEvents(f.eventReader, "w1", 0, 100)).every(
      (e) => e.payload.actorKind === "human" && e.payload.clientId === "claude-code-client",
    ),
  );
  const otherClient = f.issueScope("w1", "human", "human", { clientId: "codex-client" });
  assert.equal((await f.api.createIssue(otherClient, input("x"))).version, 1);
  assert.equal((await counts(f)).events, 6);
  await f.api.createIssue(f.human, input("direct"));
  await f.api.createIssue(f.bot, input("machine"));
  for (const [id, kind] of [
    ["direct", "human"],
    ["machine", "machine"],
  ]) {
    const h = (await f.api.getHistory(f.human, id))[0];
    assert.equal(h.actorKind, kind);
    assert.equal(h.clientId, null);
  }
});

test("pagination applies all filters before limit and remains stable across new inserts", async () => {
  const f = await fixture();
  for (const id of ["a", "b", "c", "d"])
    await f.api.createIssue(f.human, { ...input(id), priority: id === "b" ? "high" : "low" });
  await f.api.assignIssue(f.human, {
    issueId: "c",
    operationId: "assign",
    expectedVersion: 1,
    assigneeId: "bot",
  });
  await f.api.transitionIssue(f.human, {
    issueId: "c",
    operationId: "start",
    expectedVersion: 2,
    state: "in_progress",
  });
  const first = await f.api.listIssues(f.human, { projectId: "p1", limit: 1, priority: "low" });
  assert.equal(first.issues[0].id, "d");
  await f.api.createIssue(f.human, input("new"));
  const second = await f.api.listIssues(f.human, {
    projectId: "p1",
    limit: 1,
    priority: "low",
    cursor: first.nextCursor,
  });
  const last = await f.api.listIssues(f.human, {
    projectId: "p1",
    limit: 1,
    priority: "low",
    cursor: second.nextCursor,
  });
  assert.deepEqual([second.issues[0].id, last.issues[0].id], ["c", "a"]);
  assert.equal(last.nextCursor, null);
  assert.deepEqual(
    (
      await f.api.listIssues(f.human, {
        projectId: "p1",
        assigneeId: "bot",
        state: "in_progress",
        priority: "low",
      })
    ).issues.map((i) => i.id),
    ["c"],
  );
  assert.deepEqual(
    (
      await f.api.listIssues(f.human, {
        projectId: "p1",
        assigneeId: null,
        state: "todo",
        priority: "high",
      })
    ).issues.map((i) => i.id),
    ["b"],
  );
  assert.equal(
    (await f.api.listIssues(f.human, { projectId: "p1", cursor: "1" })).nextCursor,
    null,
  );
});

test("Q1 admission permits in-flight commit but revoke blocks recovery and subsequent commands", async () => {
  const f = await fixture();
  await f.api.createIssue(f.human, input("x"));
  f.state.hook = async (calls) => {
    f.auth.revoke(f.human);
    return f.rawStore.batch(calls);
  };
  await assert.rejects(f.api.editIssue(f.human, mutations()[0][1]), code("forbidden"));
  f.state.hook = null;
  assert.equal((await counts(f)).events, 2);
  await assert.rejects(f.api.editIssue(f.human, mutations()[0][1]), code("forbidden"));
  await assert.rejects(f.api.readOperation(f.human, "edit"), code("forbidden"));
  const fresh = f.issueScope("w1", "human");
  assert.equal((await f.api.readOperation(fresh, "edit")).version, 2);
  assert.equal((await f.api.getIssue(fresh, { issueId: "x" })).title, "Revised");
});

test("unknown outcomes recover after restart without duplicate comments or history", async () => {
  const f = await fixture();
  await f.api.createIssue(f.human, input("x"));
  const comment = mutations()[3][1];
  f.state.hook = async (calls) => {
    await f.rawStore.batch(calls);
    f.state.readHook = () => {
      throw new Error("storage unavailable");
    };
    throw new Error("lost response");
  };
  await assert.rejects(f.api.addComment(f.human, comment), code("unknown"));
  f.state.hook = f.state.readHook = null;
  const restarted = platform.createIssues(f.deps).api;
  assert.equal((await restarted.readOperation(f.human, "comment")).version, 2);
  assert.equal((await restarted.addComment(f.human, comment)).version, 2);
  assert.equal((await counts(f)).comments, 1);
  assert.equal((await restarted.getHistory(f.human, "x")).length, 2);
});

test("public inputs enforce text, IDs, versions, enums, limits and cursor boundaries", async () => {
  const f = await fixture();
  await f.api.createIssue(f.human, input("x"));
  for (const bad of [null, [], "x"]) {
    await assert.rejects(f.api.createIssue(f.human, bad), code("validation"));
    await assert.rejects(f.api.getIssue(f.human, bad), code("validation"));
    await assert.rejects(f.api.listIssues(f.human, bad), code("validation"));
    await assert.rejects(f.api.searchIssues(f.human, bad), code("validation"));
  }
  for (const patch of [
    { title: " " },
    { title: "x".repeat(513) },
    { description: "x".repeat(100001) },
    { priority: "critical" },
    { issueId: "bad id" },
    { operationId: "" },
    { projectId: "x".repeat(129) },
  ]) {
    await assert.rejects(
      f.api.createIssue(f.human, { ...input("invalid"), ...patch }),
      code("validation"),
    );
  }
  for (const [method, data] of mutations()) {
    for (const expectedVersion of [0, -1, 1.5, "1", null, Number.MAX_SAFE_INTEGER, Number.NaN])
      await assert.rejects(
        f.api[method](f.human, { ...data, expectedVersion }),
        code("validation"),
      );
    await assert.rejects(
      f.api[method](f.human, { ...data, operationId: "bad id" }),
      code("validation"),
    );
  }
  for (const [method, patch] of [
    ["editIssue", { title: "x".repeat(513) }],
    ["editIssue", { description: "x".repeat(100001) }],
    ["editIssue", { priority: "critical" }],
    ["transitionIssue", { state: "unknown" }],
    ["assignIssue", { assigneeId: "bad id" }],
    ["addComment", { body: " " }],
    ["addComment", { body: "x".repeat(100001) }],
    ["addComment", { commentId: "" }],
  ]) {
    await assert.rejects(
      f.api[method](f.human, { ...mutations().find(([m]) => m === method)[1], ...patch }),
      code("validation"),
    );
  }
  for (const limit of [0, -1, 101, 1.5, "1"]) {
    await assert.rejects(f.api.listIssues(f.human, { projectId: "p1", limit }), code("validation"));
    await assert.rejects(
      f.api.searchIssues(f.human, { projectId: "p1", text: "a", limit }),
      code("validation"),
    );
    await assert.rejects(f.api.readEvents(f.eventReader, "w1", 0, limit), code("validation"));
  }
  for (const cursor of [null, 2, "", "0", "-1", "1.1", "1e2", "0x10", " 1", "bad"]) {
    await assert.rejects(
      f.api.listIssues(f.human, { projectId: "p1", cursor }),
      code("validation"),
    );
  }
  for (const patch of [
    { state: "bad" },
    { priority: "bad" },
    { assigneeId: 3 },
    { assigneeId: "bad id" },
  ]) {
    await assert.rejects(
      f.api.listIssues(f.human, { projectId: "p1", ...patch }),
      code("validation"),
    );
  }
  for (const text of ["", " ", "***", "a".repeat(257), Array(13).fill("term").join(" ")]) {
    await assert.rejects(
      f.api.searchIssues(f.human, { projectId: "p1", text }),
      code("validation"),
    );
  }
  for (const cursor of [-1, 0.5, "0", Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(f.api.readEvents(f.eventReader, "w1", cursor, 1), code("validation"));
  }
  for (const reference of ["ONE-0", "ONE-01", "ONE--1", "ONE-1e2", "TWO-1"]) {
    await assert.rejects(
      f.api.getIssue(f.human, { projectId: "p1", reference }),
      code("not_found"),
    );
  }
  await assert.rejects(f.api.getIssue(f.human, { projectId: "p1", number: 0 }), code("validation"));
  await assert.rejects(f.api.readOperation(f.human, "bad id"), code("validation"));
  const boundary = {
    ...input("a".repeat(128)),
    operationId: "b".repeat(128),
    title: "x".repeat(512),
    description: "x".repeat(100000),
  };
  await f.api.createIssue(f.human, boundary);
  await f.api.addComment(f.human, { ...mutations()[3][1], body: "x".repeat(100000) });
  assert.equal((await f.api.listIssues(f.human, { projectId: "p1", limit: 100 })).issues.length, 2);
});

test("trigram upgrade rebuilds existing indexed rows and preserves unknown attribution", async () => {
  const db = await mf.getD1Database(`ISSUES${counter++}`);
  const oldSql = fs.readFileSync("modules/issues/storage/migrations/0001_issues.sql", "utf8");
  await db.batch(
    oldSql
      .split(";")
      .filter((s) => s.trim())
      .map((s) => db.prepare(s)),
  );
  await db
    .prepare(
      "CREATE TABLE platform_schema_versions(owner TEXT NOT NULL, version TEXT NOT NULL, checksum TEXT NOT NULL, PRIMARY KEY(owner, version))",
    )
    .run();
  await db
    .prepare("INSERT INTO platform_schema_versions VALUES(?,?,?)")
    .bind("issues", "0001_issues.sql", createHash("sha256").update(oldSql).digest("hex"))
    .run();
  await db
    .prepare(
      "INSERT INTO issues_issues(workspace_id,id,project_id,number,title,description,priority,state,version) VALUES('w1','old','p1',1,'認証の不具合','legacy English','medium','todo',1)",
    )
    .run();
  await db
    .prepare("INSERT INTO issues_history VALUES('w1','old',1,'create','human','human',1,'{}')")
    .run();
  await platform.migrate(db, ["issues"]);
  await platform.migrate(db, ["issues"]);
  assert.equal(
    (
      await db
        .prepare("SELECT issue_id FROM issues_search WHERE issues_search MATCH ?")
        .bind('"認証の"')
        .all()
    ).results[0].issue_id,
    "old",
  );
  assert.equal((await db.prepare("SELECT client_id FROM issues_history").first()).client_id, null);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM issues_search").first()).n, 1);
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) n FROM platform_schema_versions WHERE owner='issues'")
        .first()
    ).n,
    9,
  );
});

test("due date and estimate validate, isolate, page, retry and respect frozen scopes", async () => {
  const f = await fixture();
  await assert.rejects(
    f.api.createIssue(f.human, { ...input("bad-date"), dueDate: "2026-02-30" }),
    code("validation"),
  );
  for (const estimate of [-1, 1001])
    await assert.rejects(
      f.api.createIssue(f.human, { ...input("bad-points"), estimate }),
      code("validation"),
    );
  await f.api.createIssue(f.human, { ...input("a"), dueDate: "2026-10-10", estimate: 3 });
  await f.api.createIssue(f.human, { ...input("b"), dueDate: "2026-10-10", estimate: 5 });
  await f.api.createIssue(f.human, { ...input("c"), dueDate: "2026-10-20" });
  await f.api.createIssue(f.human, input("no-date"));
  await f.api.createIssue(f.other, { ...input("w2"), dueDate: "2026-10-01", estimate: 8 });
  const filters = { projectId: "p1", sort: "due_date", limit: 1 };
  const ids = [];
  let cursor;
  do {
    const page = await f.api.queryIssues(f.human, { ...filters, cursor });
    ids.push(...page.issues.map((issue) => issue.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.deepEqual(ids, ["b", "a", "c", "no-date"]);
  assert.equal(await f.api.countIssues(f.human, { dueBefore: "2026-10-10" }), 2);
  assert.equal(await f.api.countIssues(f.human, { dueAfter: "2026-10-20" }), 1);
  assert.equal(await f.api.countIssues(f.human, { overdue: true, today: "2026-10-15" }), 2);
  assert.equal(await f.api.countIssues(f.human, { hasDueDate: false }), 1);
  assert.equal(await f.api.countIssues(f.other, { hasDueDate: true }), 1);
  assert.equal((await f.api.getIssue(f.human, { issueId: "a" })).estimate, 3);
  const change = {
    operationId: "due-update",
    issueId: "a",
    expectedVersion: 1,
    dueDate: null,
    estimate: 0,
  };
  const result = await f.api.updateIssue(f.human, change);
  assert.deepEqual(await f.api.updateIssue(f.human, change), result);
  await assert.rejects(
    f.api.updateIssue(f.human, { ...change, operationId: "stale" }),
    code("conflict"),
  );
  assert.equal((await f.api.getIssue(f.human, { issueId: "a" })).dueDate, null);
  await f.api.updateIssue(f.human, {
    operationId: "set-again",
    issueId: "a",
    expectedVersion: 2,
    dueDate: "2026-10-26",
  });
  assert.equal((await f.api.getIssue(f.human, { issueId: "a" })).dueDate, "2026-10-26");
  await f.api.editIssue(f.human, {
    operationId: "edit-due",
    issueId: "a",
    expectedVersion: 3,
    title: "Edited",
    description: "",
    priority: "medium",
    estimate: 7,
    dueDate: "2026-11-01",
  });
  assert.equal((await f.api.getIssue(f.human, { issueId: "a" })).estimate, 7);
  for (const sql of [
    "UPDATE issues_issues SET estimate=-1 WHERE workspace_id='w1' AND id='a'",
    "UPDATE issues_issues SET due_date='bad' WHERE workspace_id='w1' AND id='a'",
    "UPDATE issues_issues SET due_date='2026-19-39' WHERE workspace_id='w1' AND id='a'",
  ])
    await assert.rejects(f.db.prepare(sql).run());
  await f.db
    .prepare(
      "INSERT INTO issues_frozen_scopes(workspace_id,project_id,state) VALUES('w1','p1','frozen')",
    )
    .run();
  await assert.rejects(
    f.api.updateIssue(f.human, {
      operationId: "frozen-due",
      issueId: "a",
      expectedVersion: 4,
      dueDate: "2026-10-16",
    }),
  );
  assert.equal((await f.api.getIssue(f.other, { issueId: "w2" })).estimate, 8);
});

test("unassignment, duplicate comment IDs, terminal archive and current write isolation", async () => {
  const f = await fixture();
  await f.api.createIssue(f.human, input("x"));
  await f.api.createIssue(f.other, { ...input("x"), title: "other tenant" });
  await f.api.assignIssue(f.human, { ...mutations()[2][1], assigneeId: "bot" });
  await f.api.assignIssue(f.human, {
    ...mutations()[2][1],
    operationId: "unassign",
    expectedVersion: 2,
    assigneeId: null,
  });
  assert.equal((await f.api.getIssue(f.human, { issueId: "x" })).assigneeId, null);
  assert.equal((await f.api.getIssue(f.other, { issueId: "x" })).version, 1);
  assert.equal((await f.api.getIssue(f.other, { issueId: "x" })).title, "other tenant");
  await f.api.addComment(f.human, { ...mutations()[3][1], expectedVersion: 3 });
  const before = await counts(f);
  await assert.rejects(
    f.api.addComment(f.human, {
      ...mutations()[3][1],
      operationId: "duplicate-comment",
      expectedVersion: 4,
    }),
    code("conflict"),
  );
  assert.deepEqual(await counts(f), before);
  await f.api.archiveIssue(f.human, { issueId: "x", operationId: "archive", expectedVersion: 4 });
  for (const selector of [
    { issueId: "x" },
    { projectId: "p1", number: 1 },
    { projectId: "p1", reference: "ONE-1" },
  ]) {
    await assert.rejects(f.api.getIssue(f.human, selector), code("not_found"));
  }
  await assert.rejects(f.api.getHistory(f.human, "x"), code("not_found"));
  for (const [method, data] of mutations("x", 5))
    await assert.rejects(
      f.api[method](f.human, { ...data, operationId: `after-${method}` }),
      code("not_found"),
    );
  assert.equal((await f.api.readOperation(f.human, "archive")).version, 5);
  assert.equal((await counts(f)).history, 5);
});

test("10a getIssueIncludingArchived preserves grants and cannot authorize archived writes", async () => {
  const { planningHistoricalContract } = await import("./planning-provider-contract.mjs");
  const f = await fixture();
  await f.api.createIssue(f.human, input("i1"));
  const denied = f.issueScope("w1", "outsider");
  f.state.denied.add("w1:outsider:p1");
  await planningHistoricalContract({
    get: f.api.getIssueIncludingArchived,
    id: "i1",
    authorized: f.human,
    denied,
    archive: () =>
      f.api.archiveIssue(f.human, { operationId: "archive", issueId: "i1", expectedVersion: 1 }),
  });
  await assert.rejects(f.api.getIssueIncludingArchived(f.other, "i1"), code("not_found"));
  const before = (await f.db.prepare("SELECT * FROM issues_issues").all()).results;
  for (const [method, args] of [
    ["editIssue", { title: "forbidden", description: "", priority: "medium" }],
    ["transitionIssue", { state: "in_progress" }],
    ["assignIssue", { assigneeId: null }],
    ["addComment", { commentId: "c", body: "forbidden" }],
    ["archiveIssue", {}],
  ])
    await assert.rejects(
      f.api[method](f.human, { operationId: method, issueId: "i1", expectedVersion: 2, ...args }),
      code("not_found"),
    );
  await assert.rejects(f.api.authorizeIssue(f.human, "i1", "write"), code("not_found"));
  assert.deepEqual((await f.db.prepare("SELECT * FROM issues_issues").all()).results, before);
  f.state.archived.add("w1:p1");
  assert.equal((await f.api.getIssueIncludingArchived(f.human, "i1")).archived, true);
  await assert.rejects(f.api.getIssueIncludingArchived(denied, "i1"), code("not_found"));
});

test("C2 built-ins seed lazily, custom status and type update issues with receipts and CAS", async () => {
  const f = await fixture();
  const admin = f.issueScope("w1", "human", "human", { role: "admin" });
  assert.equal((await f.api.listTaskStatuses(admin)).length, 6);
  assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM issues_task_statuses").first()).n, 0);
  const custom = await f.api.createTaskStatus(admin, {
    operationId: "custom-status",
    id: "status_custom",
    key: "custom",
    name: "Custom",
    category: "in_progress",
    isDefault: true,
  });
  assert.equal(custom.version, 1);
  assert.deepEqual(
    await f.api.createTaskStatus(admin, {
      operationId: "custom-status",
      id: "status_custom",
      key: "custom",
      name: "Custom",
      category: "in_progress",
      isDefault: true,
    }),
    custom,
  );
  assert.equal((await f.api.listTaskStatuses(admin)).length, 7);
  const issue = await f.api.createIssue(f.human, {
    ...input("c2"),
    priority: "none",
    typeId: "type_bug",
    labels: ["one"],
    statusId: "status_custom",
  });
  assert.equal(issue.version, 1);
  const read = await f.api.getIssue(f.human, { issueId: "c2" });
  assert.equal(read.status, "custom");
  assert.equal(read.state, "in_progress");
  assert.equal(read.priority, "none");
  assert.equal(read.createdAt, 1800000000);
  assert.deepEqual(read.labels, ["one"]);
  await assert.rejects(
    f.api.deleteTaskStatus(admin, {
      operationId: "delete-in-use",
      id: "status_custom",
      expectedVersion: 1,
    }),
    code("conflict"),
  );
  const changed = await f.api.updateTaskStatus(admin, {
    operationId: "change-category",
    id: "status_custom",
    expectedVersion: 1,
    category: "done",
  });
  assert.equal(changed.category, "done");
  assert.equal((await f.api.getIssue(f.human, { issueId: "c2" })).completedAt, 1800000000);
  await assert.rejects(
    f.api.updateTaskStatus(admin, {
      operationId: "stale-status",
      id: "status_custom",
      expectedVersion: 1,
      name: "Stale",
    }),
    code("conflict"),
  );
  const type = await f.api.createTaskType(admin, {
    operationId: "create-type",
    id: "type_custom",
    key: "custom",
    name: "Custom",
  });
  assert.equal(type.version, 1);
  assert.deepEqual(
    await f.api.createTaskType(admin, {
      operationId: "create-type",
      id: "type_custom",
      key: "custom",
      name: "Custom",
    }),
    type,
  );
  await assert.rejects(
    f.api.createTaskType(f.human, {
      operationId: "deny-type",
      id: "type_denied",
      key: "denied",
      name: "Denied",
    }),
    code("forbidden"),
  );
  assert.equal((await f.api.listTaskStatuses(f.other)).length, 6);
});

test("C2 update, comments, links, filters and tenant isolation", async () => {
  const f = await fixture();
  await f.api.createIssue(f.human, input("parent"));
  await f.api.createIssue(f.human, {
    ...input("child"),
    parentId: "parent",
    labels: ["red", "blue"],
  });
  await f.api.createIssue(f.other, input("other"));
  const updated = await f.api.updateIssue(f.human, {
    operationId: "update-child",
    issueId: "child",
    expectedVersion: 1,
    statusId: "status_done",
    priority: "high",
    labels: ["red"],
  });
  assert.equal(updated.version, 2);
  assert.equal((await f.api.getIssue(f.human, { issueId: "child" })).completedAt, 1800000000);
  await assert.rejects(
    f.api.updateIssue(f.human, {
      operationId: "cycle",
      issueId: "parent",
      expectedVersion: 1,
      parentId: "child",
    }),
    code("validation"),
  );
  assert.equal(
    (await f.api.queryIssues(f.human, { labels: ["red"], statusIds: ["status_done"] })).issues
      .length,
    1,
  );
  assert.equal((await f.api.queryIssues(f.other, {})).issues.length, 1);
  assert.equal((await f.api.getIssuesByIds(f.human, ["child", "other"])).length, 1);
  assert.equal((await f.api.childRollups(f.human, ["parent"])).parent.done, 1);
  await f.api.addComment(f.human, {
    operationId: "comment-c2",
    issueId: "child",
    expectedVersion: 2,
    commentId: "cm",
    body: "old",
  });
  assert.equal((await f.api.listComments(f.human, "child"))[0].updatedAt, 1800000000);
  await f.api.editComment(f.human, {
    operationId: "comment-edit",
    issueId: "child",
    expectedVersion: 3,
    commentId: "cm",
    body: "new",
  });
  assert.equal((await f.api.listComments(f.human, "child"))[0].body, "new");
  await f.api.deleteComment(f.human, {
    operationId: "comment-delete",
    issueId: "child",
    expectedVersion: 4,
    commentId: "cm",
  });
  assert.equal((await f.api.listComments(f.human, "child")).length, 0);
  await f.api.createIssueLink(f.human, {
    operationId: "link",
    linkId: "l1",
    sourceIssueId: "parent",
    targetIssueId: "child",
    type: "blocks",
    expectedVersion: 1,
  });
  assert.equal((await f.api.listIssueLinks(f.human, "child"))[0].type, "blocked_by");
  await assert.rejects(
    f.api.createIssueLink(f.human, {
      operationId: "link-self",
      linkId: "l2",
      sourceIssueId: "parent",
      targetIssueId: "parent",
      type: "blocks",
      expectedVersion: 2,
    }),
    code("validation"),
  );
  await f.api.deleteIssueLink(f.human, {
    operationId: "unlink",
    linkId: "l1",
    sourceIssueId: "parent",
    expectedVersion: 2,
  });
  assert.equal((await f.api.listIssueLinks(f.human, "parent")).length, 0);
});

test("C2 queryIssues applies each filter before equal-time cursor paging", async () => {
  const f = await fixture();
  await f.api.createIssue(f.human, { ...input("a"), labels: ["red", "blue"], typeId: "type_task" });
  await f.api.createIssue(f.human, { ...input("b"), labels: ["blue"], priority: "high" });
  await f.api.createIssue(f.human, { ...input("c", "c-create", "p2"), labels: ["green"] });
  await f.api.updateIssue(f.human, {
    operationId: "update-a",
    issueId: "a",
    expectedVersion: 1,
    statusId: "status_done",
    assigneeId: "bot",
  });
  await f.api.updateIssue(f.human, {
    operationId: "parent-b",
    issueId: "b",
    expectedVersion: 1,
    parentId: "a",
  });
  const count = async (filters) => (await f.api.queryIssues(f.human, filters)).issues.length;
  assert.equal(await count({ projectId: "p1" }), 2);
  assert.equal(await f.api.countIssues(f.human, { projectId: "p1" }), 2);
  assert.equal(await f.api.countIssues(f.human, { labels: ["red", "blue"] }), 1);
  assert.deepEqual(await f.api.countIssuesByProject(f.human, ["p1", "p2"]), [
    { projectId: "p1", open: 1, backlog: 1 },
    { projectId: "p2", open: 1, backlog: 1 },
  ]);
  assert.equal(await count({ category: "done" }), 1);
  assert.equal(await count({ statusIds: ["status_done"] }), 1);
  assert.equal(await count({ priorities: ["high"] }), 1);
  assert.equal(await count({ assigneeId: "bot" }), 1);
  assert.equal(await count({ assigneeId: null }), 2);
  assert.equal(await count({ parentId: "a" }), 1);
  assert.equal(await count({ noParent: true }), 2);
  assert.equal(await count({ typeId: "type_task" }), 1);
  assert.equal(await count({ excludeTypeIds: ["type_task"] }), 2);
  assert.equal(await count({ labels: ["red", "blue"], labelsMode: "all" }), 1);
  assert.equal(await count({ labels: ["green", "blue"], labelsMode: "any" }), 3);
  assert.equal(await count({ completedAfter: 1800000000, completedBefore: 1800000000 }), 1);
  assert.equal(await count({ updatedAfter: 1800000001 }), 0);
  assert.equal(await count({ updatedBefore: 1800000000 }), 3);
  assert.equal(await count({ issueIds: ["a", "c"] }), 2);
  await assert.rejects(
    f.api.queryIssues(f.human, { issueIds: Array.from({ length: 101 }, (_, i) => `x${i}`) }),
    code("validation"),
  );
  const first = await f.api.queryIssues(f.human, { limit: 1 });
  const second = await f.api.queryIssues(f.human, { limit: 1, cursor: first.nextCursor });
  const third = await f.api.queryIssues(f.human, { limit: 1, cursor: second.nextCursor });
  assert.deepEqual([first.issues[0].id, second.issues[0].id, third.issues[0].id], ["c", "b", "a"]);
  f.state.denied.add("w1:human:p2");
  assert.equal(await count({}), 2);
  assert.equal(await f.api.countIssues(f.human, {}), 2);
  await assert.rejects(f.api.countIssuesByProject(f.human, ["p2"]), code("not_found"));
  assert.equal(await f.api.countIssues(f.other, {}), 0);
  assert.deepEqual(await f.api.countIssuesByProject(f.other, ["p1"]), []);
});

test("bulk issue authorization and child rollups preserve tenant, hidden and archived behavior", async () => {
  const f = await fixture();
  await f.api.createIssue(f.human, input("bulk-a"));
  await f.api.createIssue(f.human, input("bulk-b", "bulk-b-create", "p2"));
  await f.api.createIssue(f.other, input("bulk-other"));
  await f.api.authorizeIssuesByIds(f.human, ["bulk-a", "bulk-b"]);
  await assert.rejects(
    f.api.authorizeIssuesByIds(f.human, ["bulk-a", "bulk-other"]),
    code("not_found"),
  );
  await assert.rejects(
    f.api.authorizeIssuesByIds(
      f.human,
      Array.from({ length: 101 }, (_, i) => `x${i}`),
    ),
    code("validation"),
  );
  f.state.denied.add("w1:human:p2");
  await assert.rejects(f.api.authorizeIssuesByIds(f.human, ["bulk-b"]), code("not_found"));
  await assert.rejects(f.api.childRollups(f.human, ["bulk-b"]), code("not_found"));
  f.state.denied.delete("w1:human:p2");
  await f.api.archiveIssue(f.human, {
    issueId: "bulk-a",
    operationId: "bulk-archive",
    expectedVersion: 1,
  });
  await assert.rejects(f.api.childRollups(f.human, ["bulk-a"]), code("not_found"));
  await f.api.authorizeIssuesByIds(f.human, ["bulk-a"], true);
  assert.deepEqual((await f.api.childRollups(f.human, ["bulk-b"]))["bulk-b"].total, 0);
});

test("seed read batching preserves an operation receipt on retry", async () => {
  const f = await fixture();
  const command = input("batch-retry", "batch-retry-op");
  const first = await f.api.createIssue(f.human, command);
  assert.deepEqual(await f.api.createIssue(f.human, command), first);
  assert.deepEqual(await f.api.readOperation(f.human, command.operationId), first);
  assert.equal((await f.api.getIssue(f.human, { issueId: command.issueId })).version, 1);
});

test("single visible search returns the authorized union in global date order", async () => {
  const f = await fixture();
  for (const [id, projectId] of [
    ["s1", "p1"],
    ["s2", "p2"],
    ["s3", "p1"],
  ])
    await f.api.createIssue(f.human, {
      ...input(id, `create-${id}`, projectId),
      title: "Findable title",
    });
  for (const query of ["Findable", "Fi"]) {
    const expected = (
      await Promise.all(
        ["p1", "p2"].map((projectId) =>
          f.api.searchIssues(f.human, { projectId, text: query, limit: 100 }),
        ),
      )
    )
      .flat()
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
      .map((item) => item.id);
    assert.deepEqual(
      (
        await f.api.searchVisibleIssues(f.human, {
          text: query,
          projectIds: ["p1", "p2"],
          limit: 100,
        })
      ).map((item) => item.id),
      expected,
    );
  }
  f.state.denied.add("w1:human:p2");
  await assert.rejects(
    f.api.searchVisibleIssues(f.human, { text: "Findable", projectIds: ["p1", "p2"], limit: 100 }),
    code("not_found"),
  );
  assert.equal(
    (
      await f.api.searchVisibleIssues(f.other, {
        text: "Findable",
        projectIds: ["p1"],
        limit: 100,
      })
    ).length,
    0,
  );
});

test("default list SQL matches general filtering over 300 shuffled issues and both cursor orders", async () => {
  const f = await fixture();
  let seed = 17;
  for (let i = 0; i < 300; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    await f.api.createIssue(f.human, {
      ...input(
        `bulk-${String(seed).padStart(10, "0")}-${i}`,
        `bulk-create-${i}`,
        i % 2 ? "p1" : "p2",
      ),
      dueDate: `2026-10-${String(1 + (i % 28)).padStart(2, "0")}`,
    });
  }
  for (const projectId of [undefined, "p1"]) {
    for (const sort of [undefined, "due_date"]) {
      const base = { projectId, sort, limit: 37 };
      const pagesFor = async (extra) => {
        let cursor;
        const pages = [];
        do {
          const page = await f.api.queryIssues(f.human, {
            ...base,
            ...extra,
            ...(cursor ? { cursor } : {}),
          });
          pages.push(page);
          cursor = page.nextCursor;
        } while (cursor);
        return pages;
      };
      assert.deepEqual(await pagesFor({}), await pagesFor({ statusIds: ["status_backlog"] }));
      assert.equal(
        await f.api.countIssues(f.human, base),
        await f.api.countIssues(f.human, { ...base, statusIds: ["status_backlog"] }),
      );
    }
  }
  assert.equal(await f.api.countIssues(f.other, {}), 0);
});

test("C2 0004 backfills frozen and live workspaces without weakening FKs or freeze checks", async () => {
  const db = await mf.getD1Database(`ISSUES${counter++}`);
  await platform.migrate(db, []);
  for (const migration of platform.catalogs.issues.migrations.slice(0, 3)) {
    await db.batch([
      ...migration.statements.map((sql) => db.prepare(sql)),
      db
        .prepare("INSERT INTO platform_schema_versions(owner,version,checksum) VALUES(?,?,?)")
        .bind("issues", migration.version, migration.checksum),
    ]);
  }
  for (const ws of ["w1", "w2"]) {
    await db
      .prepare(
        "INSERT INTO issues_issues(workspace_id,id,project_id,number,title,description,priority,state,version) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .bind(ws, "old", "p1", 1, "Old", "Body", "high", "done", 1)
      .run();
    await db
      .prepare(
        "INSERT INTO issues_history(workspace_id,issue_id,version,action,actor_id,actor_kind,occurred_at,detail) VALUES(?,?,?,?,?,?,?,?)",
      )
      .bind(ws, "old", 1, "create", "creator", "machine", 10, "{}")
      .run();
    await db
      .prepare(
        "INSERT INTO issues_comments(workspace_id,id,issue_id,body,actor_id,actor_kind,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .bind(ws, "comment", "old", "Hello", "author", "human", 11)
      .run();
  }
  await db
    .prepare(
      "INSERT INTO issues_frozen_scopes(workspace_id,project_id,state) VALUES('w1','p1','frozen')",
    )
    .run();
  await platform.migrate(db, ["issues"]);
  for (const ws of ["w1", "w2"]) {
    const row = await db
      .prepare(
        "SELECT priority_level,status,status_id,created_at,updated_at,completed_at,created_by_id,created_by_kind FROM issues_issues WHERE workspace_id=?",
      )
      .bind(ws)
      .first();
    assert.deepEqual(
      [
        row.priority_level,
        row.status,
        row.status_id,
        row.created_at,
        row.updated_at,
        row.completed_at,
        row.created_by_id,
        row.created_by_kind,
      ],
      ["high", "done", "status_done", 10, 10, 10, "creator", "machine"],
    );
    assert.equal(
      (
        await db
          .prepare("SELECT updated_at FROM issues_comments WHERE workspace_id=?")
          .bind(ws)
          .first()
      ).updated_at,
      11,
    );
  }
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM issues_purge_bypass").first()).n, 0);
  await assert.rejects(
    db
      .prepare("UPDATE issues_issues SET title='blocked' WHERE workspace_id='w1' AND id='old'")
      .run(),
  );
  await assert.rejects(
    db
      .prepare(
        "UPDATE issues_issues SET priority_level='broken' WHERE workspace_id='w2' AND id='old'",
      )
      .run(),
  );
  await assert.rejects(
    db
      .prepare(
        "UPDATE issues_issues SET created_by_kind='broken' WHERE workspace_id='w2' AND id='old'",
      )
      .run(),
  );
  await assert.rejects(
    db
      .prepare(
        "INSERT INTO issues_comments(workspace_id,id,issue_id,body,actor_id,actor_kind,created_at) VALUES('w2','orphan','missing','x','a','human',12)",
      )
      .run(),
  );
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM issues_history").first()).n, 2);
});

test("C2 definition commands enforce replay, CAS, workspace, viewer and freeze", async () => {
  const f = await fixture();
  const admin = f.issueScope("w1", "human", "human", { role: "admin" });
  const otherAdmin = f.issueScope("w2", "human", "human", { role: "admin" });
  const viewer = f.issueScope("w1", "human", "human", { role: "viewer" });
  const statusInput = {
    operationId: "s-create",
    id: "status_custom",
    key: "custom",
    name: "Custom",
    category: "todo",
  };
  const typeInput = { operationId: "t-create", id: "type_custom", key: "custom", name: "Custom" };
  const status = await f.api.createTaskStatus(admin, statusInput);
  const type = await f.api.createTaskType(admin, typeInput);
  assert.deepEqual(await f.api.createTaskStatus(admin, statusInput), status);
  assert.deepEqual(await f.api.createTaskType(admin, typeInput), type);
  await assert.rejects(
    f.api.createTaskStatus(viewer, {
      ...statusInput,
      operationId: "viewer-s",
      id: "status_viewer",
      key: "viewer",
    }),
    code("forbidden"),
  );
  await assert.rejects(
    f.api.createTaskType(viewer, {
      ...typeInput,
      operationId: "viewer-t",
      id: "type_viewer",
      key: "viewer",
    }),
    code("forbidden"),
  );
  assert.equal((await f.api.listTaskStatuses(otherAdmin)).length, 6);
  assert.equal((await f.api.listTaskTypes(otherAdmin)).length, 4);
  const sUpdate = { operationId: "s-update", id: status.id, expectedVersion: 1, name: "Updated" };
  const tUpdate = { operationId: "t-update", id: type.id, expectedVersion: 1, name: "Updated" };
  assert.equal((await f.api.updateTaskStatus(admin, sUpdate)).version, 2);
  assert.equal((await f.api.updateTaskType(admin, tUpdate)).version, 2);
  assert.equal((await f.api.updateTaskStatus(admin, sUpdate)).version, 2);
  assert.equal((await f.api.updateTaskType(admin, tUpdate)).version, 2);
  await assert.rejects(
    f.api.updateTaskStatus(admin, { ...sUpdate, operationId: "s-stale" }),
    code("conflict"),
  );
  await assert.rejects(
    f.api.updateTaskType(admin, { ...tUpdate, operationId: "t-stale" }),
    code("conflict"),
  );
  const sDelete = { operationId: "s-delete", id: status.id, expectedVersion: 2 };
  const tDelete = { operationId: "t-delete", id: type.id, expectedVersion: 2 };
  assert.equal((await f.api.deleteTaskStatus(admin, sDelete)).version, 3);
  assert.equal((await f.api.deleteTaskType(admin, tDelete)).version, 3);
  assert.equal((await f.api.deleteTaskStatus(admin, sDelete)).version, 3);
  assert.equal((await f.api.deleteTaskType(admin, tDelete)).version, 3);
  await f.rawStore.run("maintenanceFreeze", ["w1", ""]);
  await assert.rejects(
    f.api.createTaskStatus(admin, {
      ...statusInput,
      operationId: "s-frozen",
      id: "status_frozen",
      key: "frozen",
    }),
    code("conflict"),
  );
  await assert.rejects(
    f.api.createTaskType(admin, {
      ...typeInput,
      operationId: "t-frozen",
      id: "type_frozen",
      key: "frozen",
    }),
    code("conflict"),
  );
});

test("C2 new issue commands deny stale, viewer, cross-workspace and frozen changes", async () => {
  const f = await fixture();
  const viewer = f.issueScope("w1", "human", "human", { role: "viewer" });
  await f.api.createIssue(f.human, input("a"));
  await f.api.createIssue(f.human, input("b"));
  await f.api.createIssue(f.other, input("a"));
  const update = { operationId: "up", issueId: "a", expectedVersion: 1, title: "Changed" };
  assert.equal((await f.api.updateIssue(f.human, update)).version, 2);
  assert.equal((await f.api.updateIssue(f.human, update)).version, 2);
  await assert.rejects(
    f.api.updateIssue(f.human, { ...update, operationId: "up-stale" }),
    code("conflict"),
  );
  await assert.rejects(
    f.api.updateIssue(viewer, { ...update, operationId: "up-viewer", expectedVersion: 2 }),
    code("forbidden"),
  );
  assert.equal((await f.api.getIssue(f.other, { issueId: "a" })).title, "First title");
  await assert.rejects(
    f.api.editComment(f.human, {
      operationId: "missing-comment",
      issueId: "a",
      expectedVersion: 2,
      commentId: "no",
      body: "x",
    }),
    code("not_found"),
  );
  await f.api.addComment(f.human, {
    operationId: "add",
    issueId: "a",
    expectedVersion: 2,
    commentId: "cm",
    body: "x",
  });
  const edit = {
    operationId: "edit-cm",
    issueId: "a",
    expectedVersion: 3,
    commentId: "cm",
    body: "y",
  };
  assert.equal((await f.api.editComment(f.human, edit)).version, 4);
  assert.equal((await f.api.editComment(f.human, edit)).version, 4);
  await assert.rejects(
    f.api.editComment(f.human, { ...edit, operationId: "edit-stale" }),
    code("conflict"),
  );
  await assert.rejects(
    f.api.deleteComment(viewer, {
      operationId: "viewer-delete",
      issueId: "a",
      expectedVersion: 4,
      commentId: "cm",
    }),
    code("forbidden"),
  );
  const link = {
    operationId: "link-a",
    linkId: "l1",
    sourceIssueId: "a",
    targetIssueId: "b",
    type: "relates_to",
    expectedVersion: 4,
  };
  assert.equal((await f.api.createIssueLink(f.human, link)).version, 5);
  assert.equal((await f.api.createIssueLink(f.human, link)).version, 5);
  await assert.rejects(
    f.api.createIssueLink(f.human, {
      ...link,
      operationId: "link-duplicate",
      expectedVersion: 5,
      linkId: "l2",
    }),
    code("conflict"),
  );
  await assert.rejects(
    f.api.createIssueLink(viewer, {
      ...link,
      operationId: "viewer-link",
      expectedVersion: 5,
      linkId: "l3",
    }),
    code("forbidden"),
  );
  const unlink = { operationId: "unlink-a", linkId: "l1", sourceIssueId: "a", expectedVersion: 5 };
  assert.equal((await f.api.deleteIssueLink(f.human, unlink)).version, 6);
  assert.equal((await f.api.deleteIssueLink(f.human, unlink)).version, 6);
  await f.rawStore.run("maintenanceFreeze", ["w1", "p1"]);
  await assert.rejects(
    f.api.updateIssue(f.human, {
      operationId: "frozen-update",
      issueId: "a",
      expectedVersion: 6,
      title: "No",
    }),
    code("conflict"),
  );
  await assert.rejects(
    f.api.createIssueLink(f.human, {
      ...link,
      operationId: "frozen-link",
      expectedVersion: 6,
      linkId: "l4",
    }),
    code("conflict"),
  );
  assert.equal((await f.api.getIssue(f.other, { issueId: "a" })).version, 1);
});

test("C2 lifecycle purges links and workspace definitions after freeze", async () => {
  const f = await fixture();
  const admin = f.issueScope("w1", "human", "human", { role: "admin" });
  await f.api.createTaskStatus(admin, {
    operationId: "status-new",
    id: "status_custom",
    key: "custom",
    name: "Custom",
    category: "todo",
  });
  await f.api.createTaskType(admin, {
    operationId: "type-new",
    id: "type_custom",
    key: "custom",
    name: "Custom",
  });
  await f.api.createIssue(f.human, input("a"));
  await f.api.createIssue(f.human, input("b"));
  await f.api.createIssueLink(f.human, {
    operationId: "link-new",
    linkId: "l1",
    sourceIssueId: "a",
    targetIssueId: "b",
    type: "blocks",
    expectedVersion: 1,
  });
  const maintenance = platform.createIssues(f.deps).maintenance;
  await maintenance.freezeScope({ workspaceId: "w1" });
  let result;
  for (let i = 0; i < 20; i++) {
    result = await maintenance.purgeScope({ workspaceId: "w1" });
    if (result?.state === "purged") break;
  }
  assert.equal(result?.state, "purged");
  for (const table of [
    "issues_links",
    "issues_task_statuses",
    "issues_task_types",
    "issues_definition_history",
    "issues_definition_receipts",
    "issues_issues",
  ]) {
    assert.equal(
      (await f.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE workspace_id='w1'`).first()).n,
      0,
      table,
    );
  }
  assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM issues_purge_bypass").first()).n, 0);
});

test("C5 flow stamps are write-once, review bounce is counted, and flow reads isolate workspaces", async () => {
  const f = await fixture();
  await f.api.createIssue(f.human, input("flow"));
  await f.api.createIssue(f.other, { ...input("flow"), title: "Other workspace" });
  let issue = await f.api.getIssue(f.human, { issueId: "flow" });
  assert.equal(issue.readyAt, null);
  assert.equal(issue.claimedAt, null);
  const advance = async (statusId, operationId) => {
    await f.api.updateIssue(f.human, {
      issueId: "flow",
      expectedVersion: issue.version,
      operationId,
      statusId,
    });
    issue = await f.api.getIssue(f.human, { issueId: "flow" });
  };
  await advance("status_todo", "ready");
  assert.equal(issue.readyAt, 1800000000);
  await advance("status_in_progress", "claim");
  assert.equal(issue.claimedAt, 1800000000);
  await advance("status_in_review", "review");
  assert.equal(issue.inReviewAt, 1800000000);
  await advance("status_in_progress", "bounce");
  assert.equal(issue.reviewBounceCount, 1);
  await advance("status_done", "done");
  assert.equal(issue.completedAt, 1800000000);
  assert.equal(issue.doneAt, 1800000000);
  assert.equal(issue.readyAt, 1800000000);
  assert.equal(issue.claimedAt, 1800000000);
  assert.equal(issue.inReviewAt, 1800000000);
  const history = await f.api.getHistory(f.human, "flow");
  assert.equal(
    JSON.parse(history.find((h) => h.action === "update").detail).statusId,
    "status_todo",
  );
  const w1 = await f.api.flowIssueRows(f.human, "p1", 1800000000, null);
  const w2 = await f.api.flowIssueRows(f.other, "p1", 1800000000, null);
  assert.equal(w1.length, 1);
  assert.equal(w2.length, 1);
  assert.equal(w2[0].readyAt, null);
  assert.equal(await f.api.countDoneBefore(f.human, "p1", 1800000000, 1800000001), 1);
  assert.equal(await f.api.countDoneBefore(f.other, "p1", 1800000000, 1800000001), 0);
  await advance("status_todo", "reopen");
  assert.equal(issue.completedAt, null);
  assert.equal(issue.doneAt, 1800000000);
  assert.equal((await f.api.flowIssueRows(f.human, "p1", 1800000000, null))[0].doneAt, 1800000000);
});

test("C6 0007 backfills the earliest done history through frozen scopes", async () => {
  const db = await mf.getD1Database(`ISSUES${counter++}`);
  await platform.migrate(db, []);
  for (const migration of platform.catalogs.issues.migrations.slice(0, 6))
    await db.batch([
      ...migration.statements.map((sql) => db.prepare(sql)),
      db
        .prepare("INSERT INTO platform_schema_versions(owner,version,checksum) VALUES(?,?,?)")
        .bind("issues", migration.version, migration.checksum),
    ]);
  for (const ws of ["w1", "w2"]) {
    await db
      .prepare(
        "INSERT INTO issues_issues(workspace_id,id,project_id,number,title,description,priority,state,version,status,status_id,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(ws, "old", "p1", 1, "Old", "", "medium", "todo", 4, "todo", "status_todo", null)
      .run();
    await db
      .prepare(
        "INSERT INTO issues_issues(workspace_id,id,project_id,number,title,description,priority,state,version,status,status_id,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(ws, "fallback", "p1", 2, "Fallback", "", "medium", "done", 1, "done", "status_done", 30)
      .run();
    for (const [version, action, at, detail] of [
      [2, "transition", 12, '{"from":"todo","to":"done"}'],
      [3, "transition", 15, '{"from":"done","to":"todo"}'],
      [4, "update", 20, '{"changed":["statusId"],"statusId":"status_done"}'],
    ])
      await db
        .prepare(
          "INSERT INTO issues_history(workspace_id,issue_id,version,action,actor_id,actor_kind,occurred_at,detail) VALUES(?,?,?,?,?,?,?,?)",
        )
        .bind(ws, "old", version, action, "human", "human", at, detail)
        .run();
  }
  await db
    .prepare(
      "INSERT INTO issues_task_statuses(workspace_id,id,key,name,category,position,is_default,is_review_step,version) VALUES('w1','status_done','done','Done','done',1,0,0,1),('w2','status_done','done','Done','done',1,0,0,1)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO issues_frozen_scopes(workspace_id,project_id,state) VALUES('w1','p1','frozen')",
    )
    .run();
  await platform.migrate(db, ["issues"]);
  for (const ws of ["w1", "w2"])
    assert.deepEqual(
      (
        await db
          .prepare("SELECT id,done_at FROM issues_issues WHERE workspace_id=? ORDER BY id")
          .bind(ws)
          .all()
      ).results,
      [
        { id: "fallback", done_at: 30 },
        { id: "old", done_at: 12 },
      ],
    );
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM issues_purge_bypass").first()).n, 0);
});

test("C5 0006 backfills transition history through frozen scopes and clears bypass", async () => {
  const db = await mf.getD1Database(`ISSUES${counter++}`);
  await platform.migrate(db, []);
  for (const migration of platform.catalogs.issues.migrations.slice(0, 5))
    await db.batch([
      ...migration.statements.map((sql) => db.prepare(sql)),
      db
        .prepare("INSERT INTO platform_schema_versions(owner,version,checksum) VALUES(?,?,?)")
        .bind("issues", migration.version, migration.checksum),
    ]);
  for (const ws of ["w1", "w2"]) {
    await db
      .prepare(
        "INSERT INTO issues_issues(workspace_id,id,project_id,number,title,description,priority,state,version,status,status_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        ws,
        "old",
        "p1",
        1,
        "Old",
        "",
        "medium",
        "in_progress",
        2,
        "in_progress",
        "status_in_progress",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO issues_history(workspace_id,issue_id,version,action,actor_id,actor_kind,occurred_at,detail) VALUES(?,?,?,?,?,?,?,?)",
      )
      .bind(
        ws,
        "old",
        2,
        "transition",
        "human",
        "human",
        ws === "w1" ? 12 : 22,
        '{"from":"todo","to":"in_progress"}',
      )
      .run();
  }
  await db
    .prepare(
      "INSERT INTO issues_frozen_scopes(workspace_id,project_id,state) VALUES('w1','p1','frozen')",
    )
    .run();
  await platform.migrate(db, ["issues"]);
  for (const [ws, at] of [
    ["w1", 12],
    ["w2", 22],
  ]) {
    const row = await db
      .prepare(
        "SELECT ready_at,claimed_at,in_review_at,review_bounce_count FROM issues_issues WHERE workspace_id=?",
      )
      .bind(ws)
      .first();
    assert.deepEqual(row, {
      ready_at: at,
      claimed_at: at,
      in_review_at: null,
      review_bounce_count: 0,
    });
  }
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM issues_purge_bypass").first()).n, 0);
});
