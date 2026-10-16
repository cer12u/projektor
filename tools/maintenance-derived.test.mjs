import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

let p, mf;
before(async () => {
  fs.mkdirSync(".tmp", { recursive: true });
  await build({
    entryPoints: ["tools/maintenance-derived-entry.ts"],
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
    d1Databases: ["DERIVED"],
  });
});
after(async () => mf?.dispose());

async function dbFor(owner) {
  const db = await mf.getD1Database("DERIVED");
  await p.migrate(db, [owner]);
  return { db, store: p.createModuleStore(db, owner) };
}
async function scalar(db, sql, ...values) {
  return (
    await db
      .prepare(sql)
      .bind(...values)
      .first()
  ).n;
}
async function purged(maintenance, scope) {
  let result;
  for (let i = 0; i < 20; i++) {
    result = await maintenance.purgeScope(scope);
    if (result.state === "purged") return result;
  }
  assert.fail(`purge did not finish: ${JSON.stringify(result)}`);
}

test("Planning freezes delayed writes and purges one project in bounded chunks", async () => {
  const { db, store } = await dbFor("planning");
  const planning = p.createPlanning({
    store,
    access: {},
    issues: {},
    projects: {},
    clock: { now: () => 1 },
    ids: { next: () => "x" },
  });
  const createValues = (workspaceId, sprintId, projectId, name) => [
    workspaceId,
    sprintId,
    projectId,
    name,
    null,
    null,
    null,
    1,
    1,
  ];
  for (let i = 0; i < 55; i++) await store.run("create", createValues("w1", `a${i}`, "p1", "A"));
  await store.run("create", createValues("w1", "b", "p2", "B"));
  await store.run("create", createValues("w2", "c", "p1", "C"));
  const scope = { workspaceId: "w1", projectId: "p1" };
  assert.equal((await planning.maintenance.freezeScope(scope)).state, "frozen");
  await assert.rejects(
    store.run("create", createValues("w1", "late", "p1", "late")),
    /scope frozen/,
  );
  await store.run("create", createValues("w1", "safe", "p2", "safe"));
  const first = await planning.maintenance.purgeScope(scope);
  assert.equal(first.state, "purging");
  assert(first.remaining > 0 && first.remaining < 55);
  await purged(planning.maintenance, scope);
  assert.equal(
    await scalar(
      db,
      "SELECT count(*) n FROM planning_sprints WHERE workspace_id='w1' AND project_id='p1'",
    ),
    0,
  );
  assert.equal(
    await scalar(
      db,
      "SELECT count(*) n FROM planning_sprints WHERE workspace_id='w1' AND project_id='p2'",
    ),
    2,
  );
  assert.equal(
    await scalar(db, "SELECT count(*) n FROM planning_sprints WHERE workspace_id='w2'"),
    1,
  );
  await assert.rejects(
    store.run("create", createValues("w1", "still_late", "p1", "late")),
    /scope frozen/,
  );
});

test("Insights protects projection writes and keeps other projects", async () => {
  const { db, store } = await dbFor("insights");
  const insights = p.createInsights({
    store,
    access: {},
    projects: {},
    issues: {},
    wiki: {},
    coordination: {},
    planning: {},
    assets: {},
    readers: {},
    clock: { now: () => 1 },
    ids: { next: () => "x" },
  });
  await store.run("saveMetrics", ["w1", "p1", 1, 0, 0, 0, 0, 0]);
  await store.run("saveMetrics", ["w1", "p2", 1, 0, 0, 0, 0, 0]);
  await store.run("saveMetrics", ["w2", "p1", 1, 0, 0, 0, 0, 0]);
  const scope = { workspaceId: "w1", projectId: "p1" };
  await insights.maintenance.freezeScope(scope);
  await assert.rejects(store.run("saveMetrics", ["w1", "p1", 2, 1, 0, 0, 0, 0]), /scope frozen/);
  await store.run("saveMetrics", ["w1", "p2", 2, 1, 0, 0, 0, 0]);
  await purged(insights.maintenance, scope);
  assert.equal(
    await scalar(
      db,
      "SELECT count(*) n FROM insights_metrics WHERE workspace_id='w1' AND project_id='p1'",
    ),
    0,
  );
  assert.equal(
    await scalar(
      db,
      "SELECT count(*) n FROM insights_metrics WHERE workspace_id='w1' AND project_id='p2'",
    ),
    1,
  );
  assert.equal(
    await scalar(
      db,
      "SELECT count(*) n FROM insights_metrics WHERE workspace_id='w2' AND project_id='p1'",
    ),
    1,
  );
});

test("Integrations maintenance works without the secret vault", async () => {
  const { db, store } = await dbFor("integrations");
  const maintenance = p.createIntegrationsMaintenance(store);
  await store.run("addSource", ["w1", "s1", "p1", "one", "hash"]);
  await store.run("addSource", ["w1", "s2", "p2", "two", "hash"]);
  await store.run("addSource", ["w2", "s3", "p1", "three", "hash"]);
  const scope = { workspaceId: "w1", projectId: "p1" };
  await maintenance.freezeScope(scope);
  await assert.rejects(
    store.run("addSource", ["w1", "late", "p1", "late", "hash"]),
    /scope frozen/,
  );
  await store.run("addSource", ["w1", "s4", "p2", "four", "hash"]);
  await purged(maintenance, scope);
  assert.equal(
    await scalar(
      db,
      "SELECT count(*) n FROM integrations_sources WHERE workspace_id='w1' AND project_id='p1'",
    ),
    0,
  );
  assert.equal(
    await scalar(
      db,
      "SELECT count(*) n FROM integrations_sources WHERE workspace_id='w1' AND project_id='p2'",
    ),
    2,
  );
  assert.equal(
    await scalar(
      db,
      "SELECT count(*) n FROM integrations_sources WHERE workspace_id='w2' AND project_id='p1'",
    ),
    1,
  );
});

test("legacy rows without project attribution block project completion", async () => {
  const { db, store } = await dbFor("insights");
  const insights = p.createInsights({
    store,
    access: {},
    projects: {},
    issues: {},
    wiki: {},
    coordination: {},
    planning: {},
    assets: {},
    readers: {},
    clock: { now: () => 1 },
    ids: { next: () => "x" },
  });
  await db
    .prepare(
      "INSERT INTO insights_subscriptions(workspace_id,principal_id,issue_id,version,active) VALUES('legacy','a','i',1,1)",
    )
    .run();
  const scope = { workspaceId: "legacy", projectId: "p1" };
  assert.equal((await insights.maintenance.freezeScope(scope)).pending, 1);
  const status = await insights.maintenance.purgeScope(scope);
  assert.equal(status.state, "purging");
  assert.equal(status.pending, 1);
  assert.equal(
    await scalar(db, "SELECT count(*) n FROM insights_subscriptions WHERE workspace_id='legacy'"),
    1,
  );
});

test("commands admitted before freeze cannot commit afterward", async () => {
  async function delayed(owner, make, command, receiptSql) {
    const { db, store } = await dbFor(owner);
    let release;
    let entered;
    const stopped = new Promise((resolve) => {
      entered = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const wrapped = {
      ...store,
      async batch(calls) {
        entered();
        await gate;
        return store.batch(calls);
      },
    };
    const { api, maintenance } = make(wrapped, store);
    const pending = command(api);
    await stopped;
    await maintenance.freezeScope({ workspaceId: `delay_${owner}`, projectId: "p1" });
    release();
    await assert.rejects(pending);
    assert.equal(await scalar(db, receiptSql, `delay_${owner}`), 0);
  }
  await delayed(
    "planning",
    (store) =>
      p.createPlanning({
        store,
        access: { authorize: async () => {} },
        projects: { authorizeProject: async () => ({ id: "p1", archived: false }) },
        issues: {},
        clock: { now: () => 1 },
        ids: { next: () => crypto.randomUUID().replaceAll("-", "") },
      }),
    (api) =>
      api.createSprint(
        { workspaceId: "delay_planning", principalId: "a" },
        { operationId: "op", sprintId: "s", projectId: "p1", name: "Sprint" },
      ),
    "SELECT count(*) n FROM planning_receipts WHERE workspace_id=?",
  );
  await delayed(
    "insights",
    (store) =>
      p.createInsights({
        store,
        access: { authorize: async () => {} },
        projects: {},
        issues: { authorizeIssue: async () => ({ id: "i", projectId: "p1" }) },
        wiki: {},
        coordination: {},
        planning: {},
        assets: {},
        readers: {},
        clock: { now: () => 1 },
        ids: { next: () => "g" },
      }),
    (api) =>
      api.subscribe(
        { workspaceId: "delay_insights", principalId: "a" },
        { operationId: "op", issueId: "i", expectedVersion: 0 },
      ),
    "SELECT count(*) n FROM insights_receipts WHERE workspace_id=?",
  );
  await delayed(
    "integrations",
    (store) =>
      p.createIntegrations({
        store,
        access: { authorize: async () => {} },
        projects: {},
        issues: { authorizeIssue: async () => ({ id: "i", projectId: "p1" }) },
        wiki: {},
        clock: { now: () => 1 },
        ids: { next: () => "g" },
        vault: {},
        limiter: {},
        send: async () => new Response(),
      }),
    (api) =>
      api.linkExternalRef(
        { workspaceId: "delay_integrations", principalId: "a" },
        {
          operationId: "op",
          refId: "r",
          target: { kind: "issue", id: "i" },
          kind: "github_issue",
          url: "https://example.com/1",
        },
      ),
    "SELECT count(*) n FROM integrations_receipts WHERE workspace_id=?",
  );
});
