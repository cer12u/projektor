import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

let platform;
let mf;
let counter = 0;
const code = (name) => (error) => error.code === name;
const scope = (workspaceId, principalId, kind = "human") =>
  Object.freeze({ workspaceId, principalId, kind, role: "member", requestId: "test" });
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
    d1Databases: ["ISSUES0", "ISSUES1", "ISSUES2", "ISSUES3", "ISSUES4"],
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
    grants: new Map(),
    members: new Map(),
  };
  const store = {
    owner: "issues",
    run: (...args) => rawStore.run(...args),
    batch: (calls) => (state.hook ? state.hook(calls) : rawStore.batch(calls)),
  };
  const projectKey = (projectId) => (projectId === "p2" ? "TWO" : "ONE");
  const projects = {
    async authorizeProject(s, projectId, permission = "read") {
      if (!["p1", "p2"].includes(projectId) || state.archived.has(`${s.workspaceId}:${projectId}`))
        throw new platform.PlatformError("not_found", "Project absent");
      if (state.denied.has(`${s.workspaceId}:${s.principalId}:${projectId}`))
        throw new platform.PlatformError("forbidden", "Grant revoked");
      if (permission === "write" && s.role === "viewer")
        throw new platform.PlatformError("forbidden", "Read only");
      return {
        id: projectId,
        key: projectKey(projectId),
        name: projectId,
        version: 1,
        archived: false,
        role: "editor",
      };
    },
    async getProject(s, projectId) {
      return this.authorizeProject(s, projectId);
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
  const access = {
    async authorize(s, permission = "read") {
      if (!state.members.has(`${s.workspaceId}:${s.principalId}`))
        throw new platform.PlatformError("forbidden", "Principal absent");
      if (permission === "write" && s.role === "viewer")
        throw new platform.PlatformError("forbidden", "Read only");
      return s;
    },
    async getPrincipalSummary(s, principalId) {
      if (!state.members.has(`${s.workspaceId}:${principalId}`))
        throw new platform.PlatformError("not_found", "Principal absent");
      return {
        id: principalId,
        kind: state.members.get(`${s.workspaceId}:${principalId}`),
        issuer: "fake",
        subject: principalId,
      };
    },
  };
  state.members.set("w1:human", "human");
  state.members.set("w1:bot", "machine");
  state.members.set("w2:human", "human");
  const { api, eventReader } = platform.createIssues({
    store,
    projects,
    access,
    clock: { now: () => 1800000000 },
    ids: { next: () => crypto.randomUUID() },
    eventConsumer: "test",
  });
  return {
    db,
    rawStore,
    state,
    api,
    eventReader,
    human: scope("w1", "human"),
    bot: scope("w1", "bot", "machine"),
    other: scope("w2", "human"),
  };
}

test("fixed state graph and literal FTS tokenization without storage", () => {
  const rules = platform.issuesRules;
  assert.equal(rules.canTransition("todo", "in_progress"), true);
  assert.equal(rules.canTransition("todo", "done"), false);
  assert.equal(rules.canTransition("done", "in_progress"), true);
  assert.equal(rules.canTransition("cancelled", "todo"), true);
  assert.equal(rules.searchExpression('hello" OR * world'), '"hello" AND "OR" AND "world"');
  assert.equal(rules.searchExpression("***"), null);
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
    code("forbidden"),
  );
  await assert.rejects(f.api.readOperation(f.human, "w1-create"), code("forbidden"));
  await assert.rejects(
    f.api.searchIssues(f.human, { projectId: "p1", text: "initial" }),
    code("forbidden"),
  );
  assert.equal((await f.api.listIssues(f.human, { projectId: "p2" })).issues.length, 1);
  assert.equal((await f.api.getIssue(f.other, { issueId: "same" })).version, 1);
});
