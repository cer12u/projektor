import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { insightsProviderContract } from "./insights-provider-contract.mjs";

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
    d1Databases: Array.from({ length: 40 }, (_, i) => `INS${i}`),
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
    breakBatch = false,
    inject = null;
  const raw = p.createModuleStore(db, "insights");
  const store = {
    ...raw,
    async batch(calls) {
      if (breakBatch) {
        breakBatch = false;
        throw Error("crash before commit");
      }
      if (inject) {
        const hook = inject;
        inject = null;
        calls = await hook(calls);
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
  const authorizations = [];
  const issueApi = {
    async authorizeIssue(s, id) {
      authorizations.push(id);
      if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id))
        throw new p.PlatformError("validation", "Invalid issue ID");
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
  const created = p.createInsights({
    store,
    access: fake.access,
    projects,
    issues: issueApi,
    wiki: {
      async authorizePage(s, id) {
        await projects.authorizeProject(s, "p1");
        if (id !== "page1") throw new p.PlatformError("not_found", "page");
        return { id, projectId: "p1", title: "Page" };
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
      async listSprints(s, projectId) {
        await projects.authorizeProject(s, projectId);
        return [{ id: "s1", projectId, name: "Sprint", archived: false }];
      },
    },
    assets: {
      async getMetadata(s, id) {
        await projects.authorizeProject(s, "p1");
        if (id !== "b1") throw new p.PlatformError("not_found", "asset");
        return { id, projectId: "p1", filename: "Asset" };
      },
    },
    readers,
    clock: { now: () => time },
    ids: { next: () => `g${++n}` },
  });
  const api = created.api;
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
    providers: { access: fake.access, projects, issues: issueApi },
    background: created.background,
    db,
    scope,
    fake,
    events,
    denied,
    history,
    authorizations,
    issues,
    add,
    loseResponse: () => (loseResponse = true),
    breakBatch: () => (breakBatch = true),
    raw,
    inject: (hook) => {
      inject = hook;
    },
    time: (value) => {
      time = value;
    },
  };
}
test("projection replay, cursor batch and tenant separation", async () => {
  const f = await fixture();
  const alice = f.scope();
  f.add("issues", "w1", "IssueCreated", "i1");
  f.add("issues", "w2", "IssueCreated", "i1");
  f.breakBatch();
  await assert.rejects(() => f.background.consumeEvents("w1"), /crash/);
  assert.equal(
    (await f.raw.run("cursors", ["w1"])).rows.find((r) => r.source === "issues").sequence,
    0,
  );
  assert.equal(
    (await f.raw.run("feed", ["w1", 9999999, 9999999, "", "", 9999999, 10])).rows.length,
    0,
  );
  assert.equal(await f.background.consumeEvents("w1"), 1);
  assert.equal(await f.background.consumeEvents("w1"), 0);
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
  assert.equal(await f.background.consumeEvents("w1"), 0);
  assert.equal(
    (await f.raw.run("feed", ["w1", 9999999, 9999999, "", "", 9999999, 10])).rows.length,
    1,
  );
  assert.equal(
    (await f.raw.run("cursors", ["w1"])).rows.find((x) => x.source === "issues").sequence,
    1,
  );
  assert.equal(await f.background.consumeEvents("w1"), 0);
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
    () => f.background.consumeEvents("w1"),
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

const code = (value) => (e) => e.code === value;
const feedRows = (f) => f.raw.run("feed", ["w1", 999999999, 999999999, "", "", 999999999, 100]);
const issueCursor = async (f) =>
  (await f.raw.run("cursors", ["w1"])).rows.find((r) => r.source === "issues");

test("11a atomic projection and cursor survive failure at either write boundary", async () => {
  for (const failing of ["activity", "advanceCursor"]) {
    const f = await fixture();
    f.add("issues", "w1", "IssueCreated", "i1");
    // Fail inside real D1, after earlier statements have executed, not before batch submission.
    f.inject((calls) =>
      calls.flatMap((call) => [
        call,
        ...(call.name === failing
          ? [{ name: "receipt", values: ["w1", "alice", "crash", null, "i1", 1, null] }]
          : []),
      ]),
    );
    await assert.rejects(f.background.consumeEvents("w1"));
    assert.equal((await feedRows(f)).rows.length, 0);
    assert.equal((await issueCursor(f)).sequence, 0);
    assert.equal(await f.background.consumeEvents("w1"), 1);
    assert.equal((await feedRows(f)).rows.length, 1);
    assert.equal((await issueCursor(f)).sequence, 1);
  }
});

test("11a lag advances time and sequence; gaps and unknown schemas stop without partial projection", async () => {
  const f = await fixture(),
    s = f.scope();
  assert.deepEqual(
    (await f.api.getActivity(s)).lag.find((x) => x.source === "issues"),
    { source: "issues", sequence: 0, consumedAt: null },
  );
  f.time(3000000);
  f.add("issues", "w1", "IssueCreated", "i1");
  await f.background.consumeEvents("w1");
  assert.deepEqual(await issueCursor(f), { source: "issues", sequence: 1, consumed_at: 3000001 });
  f.time(3000100);
  f.add("issues", "w1", "IssueChanged", "i1");
  const lag = (await f.api.getActivity(s)).lag.find((x) => x.source === "issues");
  assert.deepEqual(lag, { source: "issues", sequence: 2, consumedAt: 3000101 });
  f.add("issues", "w1", "IssueChanged", "i1");
  f.add("issues", "w1", "IssueChanged", "i1");
  f.events.issues[3].schemaVersion = 99;
  await assert.rejects(f.background.consumeEvents("w1"), code("unknown"));
  assert.equal((await issueCursor(f)).sequence, 2);
  assert.equal((await feedRows(f)).rows.length, 2);
  f.events.issues[3].schemaVersion = 1;
  f.events.issues[2].cursor = 5;
  await assert.rejects(f.background.consumeEvents("w1"), code("unknown"));
});

test("11a attribution for every owner, legacy null and forced claim issue targeting", async () => {
  const f = await fixture(),
    s = f.scope();
  for (const source of ["projects", "coordination", "planning", "assets"]) {
    f.add(
      source,
      "w1",
      source === "coordination" ? "FileClaimForced" : "Changed",
      source === "projects"
        ? "p1"
        : source === "planning"
          ? "s1"
          : source === "assets"
            ? "b1"
            : "i1",
    );
    const event = f.events[source][0];
    event.schemaVersion = 2;
    if (source === "coordination") {
      event.subjectId = "repo/path";
      delete event.aggregateId;
      event.issueId = "i1";
      event.projectId = "p1";
    }
  }
  f.add("issues", "w1", "IssueCreated", "i1");
  f.add("wiki", "w1", "PageCreated", "page1");
  await f.background.consumeEvents("w1");
  assert.deepEqual(
    (await feedRows(f)).rows.map((r) => r.client_id),
    Array(6).fill("ClaudeCode"),
  );
  const feed = await f.api.getActivity(s, { projectId: "p1" });
  assert.equal(feed.items.length, 6);
  assert(feed.items.every((x) => x.clientId === "ClaudeCode"));
  assert(
    feed.items.some(
      (x) => x.source === "coordination" && x.entityId === "i1" && x.clientId === "ClaudeCode",
    ),
  );
  f.add("projects", "w1", "ProjectChanged", "p1");
  delete f.events.projects[1].payload.clientId;
  f.add("coordination", "w1", "FileClaimForced", "repo/legacy-path");
  delete f.events.coordination[1].aggregateId;
  delete f.events.coordination[1].payload.clientId;
  // Upgrade also retains activity rows projected by the old consumer using path IDs.
  await f.raw.run("activity", [
    "w1",
    "coordination",
    3,
    "old-projection",
    "repo/already-projected",
    0,
    "FileClaimForced",
    "bob",
    null,
    100,
  ]);
  await assert.doesNotReject(() => f.api.getActivity(s), "legacy forced claims remain readable");
  assert(
    !(await f.api.getActivity(s)).items.some(
      (x) => x.source === "coordination" && x.sequence === 2,
    ),
  );
  assert(
    (await f.api.getActivity(s)).items.some(
      (x) => x.source === "projects" && x.sequence === 2 && x.clientId === null,
    ),
  );
});

test("11a authorization precedes project filtering, archive and revoke hide feed and totals", async () => {
  const f = await fixture(),
    s = f.scope();
  f.add("issues", "w1", "IssueCreated", "i1");
  assert.equal((await f.api.getActivity(s, { projectId: "p1" })).items.length, 1);
  // A second target in another project must be authorized before applying the p1 filter.
  f.issues.set("i2", { id: "i2", projectId: "p2", title: "Other", state: "todo" });
  f.add("issues", "w1", "IssueCreated", "i2");
  assert.deepEqual(
    (await f.api.getActivity(s, { projectId: "p1" })).items.map((x) => x.entityId),
    ["i1"],
  );
  assert(f.authorizations.includes("i2"));
  // An archived target is absent from its owner's normal query.
  f.issues.delete("i1");
  f.issues.delete("i2");
  assert.deepEqual((await f.api.getActivity(s)).items, []);
  f.denied.add("alice");
  await assert.rejects(f.api.getActivity(s, { projectId: "p1" }), code("not_found"));
  await assert.rejects(f.api.getMetrics(s, "p1"), code("not_found"));
});

async function commentNotification(f, s) {
  await f.api.subscribe(s, { operationId: "sub", issueId: "i1", expectedVersion: 0 });
  f.history.set("i1", [
    {
      version: 1,
      action: "comment",
      actorId: "bob",
      clientId: "Codex",
      occurredAt: 2000000,
      detail: JSON.stringify({ body: "PRIVATE_COMMENT_SENTINEL" }),
    },
  ]);
  f.add("issues", "w1", "IssueChanged", "i1");
  return (await f.api.listNotifications(s)).items[0];
}

test("11a notifications contain metadata only and exclude invisible recipients and unread totals", async () => {
  const f = await fixture(),
    s = f.scope();
  const item = await commentNotification(f, s);
  assert.deepEqual(Object.keys(item).sort(), [
    "id",
    "issueId",
    "kind",
    "occurredAt",
    "read",
    "version",
  ]);
  assert(!JSON.stringify(await f.api.listNotifications(s)).includes("PRIVATE_COMMENT_SENTINEL"));
  assert(
    !JSON.stringify(
      (await f.db.prepare("SELECT * FROM insights_notifications").all()).results,
    ).includes("PRIVATE_COMMENT_SENTINEL"),
  );
  assert.equal((await f.api.listNotifications(s)).unread, 1);
  assert.equal((await f.api.listNotifications(f.scope("w2"))).unread, 0);
  const other = f.scope("w1", "carol");
  await f.api.subscribe(other, { operationId: "sub", issueId: "i1", expectedVersion: 0 });
  f.denied.add("carol");
  assert.equal((await f.api.listNotifications(other)).unread, 0);
  assert.equal((await f.raw.run("notification", ["w1", "carol", item.id])).rows.length, 0);
  f.denied.add("alice");
  const revoked = await f.api.listNotifications(s);
  assert.deepEqual(revoked.items, []);
  assert.equal(revoked.unread, 0);
  assert.equal(revoked.nextCursor, null);
  f.denied.delete("alice");
  f.issues.delete("i1");
  const archived = await f.api.listNotifications(s);
  assert.deepEqual(archived.items, []);
  assert.equal(archived.unread, 0);
});

test("11a subscribe fingerprint and CAS reject changed retries and racing storage updates", async () => {
  const f = await fixture(),
    s = f.scope();
  const input = { operationId: "sub", issueId: "i1", expectedVersion: 0 };
  const saved = await f.api.subscribe(s, input);
  assert.deepEqual(await f.api.subscribe(s, input), saved);
  f.issues.set("i2", { ...f.issues.get("i1"), id: "i2" });
  for (const change of [{ issueId: "i2" }, { expectedVersion: 1 }])
    await assert.rejects(f.api.subscribe(s, { ...input, ...change }), code("conflict"));
  await assert.rejects(f.api.unsubscribe(s, input), code("conflict"));
  await f.api.unsubscribe(s, { operationId: "off", issueId: "i1", expectedVersion: 1 });
  await assert.rejects(f.api.subscribe(s, { ...input, operationId: "stale" }), code("conflict"));
  f.inject(async (calls) => {
    await f.db
      .prepare(
        "UPDATE insights_subscriptions SET version=3 WHERE workspace_id='w1' AND issue_id='i1'",
      )
      .run();
    return calls;
  });
  await assert.rejects(
    f.api.subscribe(s, { ...input, operationId: "race", expectedVersion: 2 }),
    code("conflict"),
  );
  assert.equal((await f.raw.run("readReceipt", ["w1", "alice", "race"])).rows.length, 0);
  assert.deepEqual(await f.api.getSubscription(s, "i1"), { id: "i1", version: 3, active: false });
});

test("11a markRead fingerprint CAS and retry after revoke", async () => {
  const f = await fixture(),
    s = f.scope();
  const item = await commentNotification(f, s);
  const input = { operationId: "read", notificationId: item.id, expectedVersion: 1 };
  await assert.rejects(f.api.markRead(s, { ...input, expectedVersion: 0 }), code("conflict"));
  f.inject(async (calls) => {
    await f.db.prepare("UPDATE insights_notifications SET version=2 WHERE workspace_id='w1'").run();
    return calls;
  });
  await assert.rejects(f.api.markRead(s, input), code("conflict"));
  assert.equal((await f.raw.run("readReceipt", ["w1", "alice", "read"])).rows.length, 0);
  input.expectedVersion = 2;
  const result = await f.api.markRead(s, input);
  assert.deepEqual(await f.api.markRead(s, input), result);
  for (const change of [{ notificationId: "another" }, { expectedVersion: 3 }])
    await assert.rejects(f.api.markRead(s, { ...input, ...change }), code("conflict"));
  f.denied.add("alice");
  await assert.rejects(f.api.markRead(s, input), code("not_found"));
});

test("11a metrics group actor and client and enforce both window boundaries", async () => {
  const f = await fixture(),
    s = f.scope(),
    now = 10000000;
  f.time(now);
  const entry = (offset, clientId, actorId = "bob", to = "done") => ({
    version: 1,
    action: "transition",
    actorId,
    clientId,
    occurredAt: now + offset,
    detail: JSON.stringify({ to }),
  });
  f.history.set("i1", [
    entry(0, "Codex"),
    entry(-7 * 86400, "Claude"),
    entry(-7 * 86400 - 1, "Codex"),
    entry(-30 * 86400, null),
    entry(-30 * 86400 - 1, "old"),
    entry(1, "future"),
    entry(-1, "Codex", "alice"),
    entry(-1, "Codex", "bob", "todo"),
  ]);
  const result = await f.api.getMetrics(s, "p1");
  assert.deepEqual(result.completed7Days, [
    { principalId: "bob", clientId: "Codex", count: 1 },
    { principalId: "bob", clientId: "Claude", count: 1 },
    { principalId: "alice", clientId: "Codex", count: 1 },
  ]);
  assert.deepEqual(result.completed30Days, [
    { principalId: "bob", clientId: "Codex", count: 2 },
    { principalId: "bob", clientId: "Claude", count: 1 },
    { principalId: "bob", clientId: null, count: 1 },
    { principalId: "alice", clientId: "Codex", count: 1 },
  ]);
});

test("11a Gateway API has no consumer capability", async () => {
  const f = await fixture();
  assert.equal("consumeEvents" in f.api, false);
  assert.equal("drainKnownWorkspaces" in f.api, false);
  assert.equal(typeof f.background.consumeEvents, "function");
});

test("11a Insights provider read contract matches the isolated fake", async () => {
  const f = await fixture();
  await insightsProviderContract({
    ...f.providers,
    scope: f.scope(),
    projectId: "p1",
    issueId: "i1",
    archiveIssue: async () => {
      f.issues.delete("i1");
    },
  });
});

test("11a command receipt failures roll back subscription and read marker", async () => {
  const f = await fixture(),
    s = f.scope();
  const failReceipt = (calls) =>
    calls.map((call) =>
      call.name === "receipt"
        ? {
            ...call,
            values: [call.values[0], call.values[1], call.values[2], null, ...call.values.slice(4)],
          }
        : call,
    );
  f.inject(failReceipt);
  await assert.rejects(
    f.api.subscribe(s, { operationId: "sub", issueId: "i1", expectedVersion: 0 }),
    code("unknown"),
  );
  assert.equal(await f.api.getSubscription(s, "i1"), null);
  assert.equal((await f.raw.run("readReceipt", ["w1", "alice", "sub"])).rows.length, 0);
  const item = await commentNotification(f, s);
  const input = { operationId: "read", notificationId: item.id, expectedVersion: 1 };
  f.inject(failReceipt);
  await assert.rejects(f.api.markRead(s, input), code("unknown"));
  const page = await f.api.listNotifications(s);
  assert.equal(page.unread, 1);
  assert.equal(page.items[0].version, 1);
  assert.equal((await f.raw.run("readReceipt", ["w1", "alice", "read"])).rows.length, 0);
  assert.deepEqual(await f.api.markRead(s, input), { id: item.id, version: 2 });
});
