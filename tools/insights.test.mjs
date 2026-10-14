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
  const built = await build({
    entryPoints: ["tools/insights-test-entry.ts"],
    outfile: ".tmp/test-entry.mjs",
    bundle: true,
    format: "esm",
    platform: "node",
    metafile: true,
  });
  assert(
    Object.keys(built.metafile.inputs).every(
      (x) => !/modules\/(issues|projects|wiki|coordination|planning|assets)\/internal\//.test(x),
    ),
  );
  p = await import("../.tmp/test-entry.mjs");
  mf = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('ok')}}",
    compatibilityDate: "2026-07-30",
    d1Databases: Array.from({ length: 20 }, (_, i) => `INS${i}`),
  });
});
after(async () => mf?.dispose());
async function fixture() {
  const db = await mf.getD1Database(`INS${serial++}`);
  await p.migrate(db, ["insights"]);
  const fake = p.fakeAccess();
  const scope = (workspaceId = "w1", principalId = "alice") =>
    fake.issue({
      id: principalId,
      workspaceId,
      kind: "machine",
      role: "member",
      scope: "write",
      active: true,
    });
  const events = Object.fromEntries(
    ["projects", "issues", "wiki", "coordination", "planning", "assets"].map((source) => [
      source,
      [],
    ]),
  );
  const denied = new Set();
  const history = new Map();
  const issues = new Map([
    ["i1", { id: "i1", projectId: "p1", title: "Task", state: "done", assigneeId: "alice" }],
  ]);
  let time = 2000000,
    n = 0,
    loseResponse = false,
    breakBatch = false;
  const raw = p.createModuleStore(db, "insights");
  const store = {
    ...raw,
    async batch(calls) {
      if (breakBatch) {
        breakBatch = false;
        throw Error("crash before commit");
      }
      const result = await raw.batch(calls);
      if (loseResponse) {
        loseResponse = false;
        throw Error("response lost");
      }
      return result;
    },
  };
  const project = { id: "p1", name: "Project", archived: false };
  const projects = {
    async authorizeProject(s, id) {
      await fake.access.authorize(s);
      if (id !== "p1" || denied.has(s.principalId))
        throw new p.PlatformError("not_found", "project");
      return project;
    },
    async getProject(s, id) {
      return this.authorizeProject(s, id);
    },
    async listVisibleProjects(s) {
      await this.authorizeProject(s, "p1");
      return { projects: [project], nextCursor: null };
    },
  };
  const issueApi = {
    async authorizeIssue(s, id) {
      await projects.authorizeProject(s, "p1");
      const issue = issues.get(id);
      if (!issue) throw new p.PlatformError("not_found", "issue");
      return issue;
    },
    async getHistory(s, id) {
      await this.authorizeIssue(s, id);
      return history.get(id) ?? [];
    },
    async listIssues(s, input) {
      await projects.authorizeProject(s, input.projectId);
      return { issues: [...issues.values()], nextCursor: null };
    },
  };
  const readers = Object.fromEntries(
    Object.entries(events).map(([source, list]) => [
      source,
      {
        cap: Object.freeze({}),
        api: {
          async readEvents(cap, workspaceId, cursor, limit) {
            assert.equal(cap, readers[source].cap);
            return list
              .filter((e) => e.workspaceId === workspaceId && e.cursor > cursor)
              .slice(0, limit);
          },
        },
      },
    ]),
  );
  const api = p.createInsights({
    store,
    access: fake.access,
    projects,
    issues: issueApi,
    wiki: {
      async authorizePage() {
        throw new p.PlatformError("not_found", "page");
      },
    },
    coordination: {
      async listLeases() {
        return [];
      },
      async projectSessions() {
        return { items: [], nextCursor: null };
      },
    },
    planning: {
      async listSprints() {
        return [];
      },
    },
    assets: {
      async getMetadata() {
        throw new p.PlatformError("not_found", "asset");
      },
    },
    readers,
    clock: { now: () => time },
    ids: { next: () => `g${++n}` },
  }).api;
  const add = (source, ws, type, entityId, actorId = "bob", clientId = "ClaudeCode") => {
    const cursor = events[source].filter((x) => x.workspaceId === ws).length + 1;
    events[source].push({
      source,
      schemaVersion: 1,
      eventId: `${source}_${ws}_${cursor}`,
      workspaceId: ws,
      cursor,
      occurredAt: time++,
      type,
      aggregateId: entityId,
      subjectId: entityId,
      aggregateVersion: cursor,
      actorId,
      payload: { actorId, clientId },
    });
  };
  return {
    api,
    db,
    scope,
    fake,
    events,
    denied,
    history,
    issues,
    add,
    loseResponse: () => (loseResponse = true),
    breakBatch: () => (breakBatch = true),
    raw,
  };
}
test("projection replay, cursor batch and tenant separation", async () => {
  const f = await fixture();
  const alice = f.scope();
  f.add("issues", "w1", "IssueCreated", "i1");
  f.add("issues", "w2", "IssueCreated", "i1");
  f.breakBatch();
  await assert.rejects(() => f.api.consumeEvents("w1"), /crash/);
  assert.equal(
    (await f.raw.run("cursors", ["w1"])).rows.find((r) => r.source === "issues").sequence,
    0,
  );
  assert.equal(
    (await f.raw.run("feed", ["w1", 9999999, 9999999, "", "", 9999999, 10])).rows.length,
    0,
  );
  assert.equal(await f.api.consumeEvents("w1"), 1);
  assert.equal(await f.api.consumeEvents("w1"), 0);
  assert.equal((await f.api.getActivity(alice)).items.length, 1);
  assert.equal((await f.api.getActivity(f.scope("w2"))).items.length, 1);
  assert.equal(
    (await f.raw.run("feed", ["w1", 9999999, 9999999, "", "", 9999999, 10])).rows.length,
    1,
  );
});
test("duplicate delivery and lost batch response leave one projection row", async () => {
  const f = await fixture();
  f.add("issues", "w1", "IssueCreated", "i1");
  f.events.issues.push({ ...f.events.issues[0] });
  f.loseResponse();
  assert.equal(await f.api.consumeEvents("w1"), 0);
  assert.equal(
    (await f.raw.run("feed", ["w1", 9999999, 9999999, "", "", 9999999, 10])).rows.length,
    1,
  );
  assert.equal(
    (await f.raw.run("cursors", ["w1"])).rows.find((x) => x.source === "issues").sequence,
    1,
  );
  assert.equal(await f.api.consumeEvents("w1"), 0);
});
test("activity keyset keeps the second row and unknown schema stalls the cursor", async () => {
  const f = await fixture();
  const alice = f.scope();
  f.add("issues", "w1", "IssueCreated", "i1");
  f.add("issues", "w1", "IssueChanged", "i1");
  const first = await f.api.getActivity(alice, { limit: 1 });
  assert.equal(first.items.length, 1);
  assert(first.nextCursor);
  const second = await f.api.getActivity(alice, { limit: 1, cursor: first.nextCursor });
  assert.equal(second.items.length, 1);
  assert.notEqual(second.items[0].sequence, first.items[0].sequence);
  f.add("issues", "w1", "IssueChanged", "i1");
  f.events.issues[2].schemaVersion = 2;
  await assert.rejects(
    () => f.api.consumeEvents("w1"),
    (e) => e.code === "unknown",
  );
  assert.equal(
    (await f.raw.run("cursors", ["w1"])).rows.find((x) => x.source === "issues").sequence,
    2,
  );
});
test("feed applies current project visibility and reports lag", async () => {
  const f = await fixture();
  const alice = f.scope();
  f.add("issues", "w1", "IssueCreated", "i1");
  const first = await f.api.getActivity(alice);
  assert.equal(first.items[0].title, "Task");
  assert.equal(first.lag.find((x) => x.source === "issues").sequence, 1);
  f.denied.add("alice");
  assert.deepEqual((await f.api.getActivity(alice)).items, []);
  await assert.rejects(
    () => f.api.getMetrics(alice, "p1"),
    (e) => e.code === "not_found",
  );
  f.denied.delete("alice");
  f.fake.revoke(alice);
  await assert.rejects(
    () => f.api.getActivity(alice),
    (e) => e.code === "forbidden",
  );
  await assert.rejects(
    () => f.api.getMetrics(alice, "p1"),
    (e) => e.code === "forbidden",
  );
});
test("subscription CAS, retry and notification read marker", async () => {
  const f = await fixture();
  const alice = f.scope();
  assert.deepEqual(
    await f.api.subscribe(alice, { operationId: "op1", issueId: "i1", expectedVersion: 0 }),
    { id: "i1", version: 1, active: true },
  );
  assert.equal(
    (await f.api.subscribe(alice, { operationId: "op1", issueId: "i1", expectedVersion: 0 }))
      .version,
    1,
  );
  await assert.rejects(
    () => f.api.unsubscribe(alice, { operationId: "op2", issueId: "i1", expectedVersion: 0 }),
    (e) => e.code === "conflict",
  );
  f.history.set("i1", [
    { version: 1, action: "comment", actorId: "bob", occurredAt: 2000000, detail: "{}" },
  ]);
  f.add("issues", "w1", "IssueChanged", "i1");
  const page = await f.api.listNotifications(alice);
  assert.equal(page.items.length, 1);
  assert.equal(page.unread, 1);
  const item = page.items[0];
  assert.deepEqual(
    await f.api.markRead(alice, {
      operationId: "op3",
      notificationId: item.id,
      expectedVersion: 1,
    }),
    { id: item.id, version: 2 },
  );
  assert.equal((await f.api.listNotifications(alice)).items[0].read, true);
  f.denied.add("alice");
  assert.deepEqual((await f.api.listNotifications(alice)).items, []);
});
test("metrics use visible issue state and completion history with client attribution", async () => {
  const f = await fixture();
  const alice = f.scope();
  f.history.set("i1", [
    {
      version: 2,
      action: "transition",
      actorId: "bob",
      clientId: "ClaudeCode",
      occurredAt: 2000000 - 2 * 86400,
      detail: JSON.stringify({ to: "done" }),
    },
  ]);
  const metrics = await f.api.getMetrics(alice, "p1");
  assert.equal(metrics.done, 1);
  assert.deepEqual(metrics.completed7Days, [
    { principalId: "bob", clientId: "ClaudeCode", count: 1 },
  ]);
  assert.equal(metrics.lag.find((x) => x.source === "issues").consumedAt, null);
});
