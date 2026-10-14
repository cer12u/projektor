import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const owners = [
  "access",
  "projects",
  "issues",
  "wiki",
  "coordination",
  "assets",
  "planning",
  "insights",
  "integrations",
  "lifecycle",
];
let p, mf, db, bucket, env;
before(async () => {
  fs.mkdirSync(".tmp", { recursive: true });
  await build({
    entryPoints: ["tools/lifecycle-scheduled-entry.ts"],
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
    d1Databases: ["DB"],
    kvNamespaces: ["KV"],
    r2Buckets: ["R2"],
  });
  db = await mf.getD1Database("DB");
  bucket = await mf.getR2Bucket("R2");
  await p.migrate(db, owners);
  env = {
    DB: db,
    KV: await mf.getKVNamespace("KV"),
    R2: bucket,
    ASSETS: { fetch: async () => new Response("missing", { status: 404 }) },
    ACCESS_TEAM_DOMAIN: "https://test.cloudflareaccess.com",
    ACCESS_AUDIENCE: "test",
    FEEDBACK_LIMIT: { limit: async () => ({ success: true }) },
    // Deliberately omit INTEGRATIONS_KEY: maintenance must still run.
  };
});
after(async () => mf?.dispose());

async function execute(sql, ...values) {
  return db
    .prepare(sql)
    .bind(...values)
    .run();
}
async function count(table, workspaceId, projectId, projectColumn = "project_id") {
  if (table === "projects_projects") projectColumn = "id";
  const sql =
    projectId === undefined
      ? `SELECT COUNT(*) n FROM ${table} WHERE workspace_id=?`
      : `SELECT COUNT(*) n FROM ${table} WHERE workspace_id=? AND ${projectColumn}=?`;
  return (
    await db
      .prepare(sql)
      .bind(...(projectId === undefined ? [workspaceId] : [workspaceId, projectId]))
      .first()
  ).n;
}
async function seed(workspaceId, projectId) {
  const suffix = `${workspaceId}_${projectId}`;
  await execute(
    "INSERT INTO projects_projects(workspace_id,id,project_key,name,version) VALUES(?,?,?,?,1)",
    workspaceId,
    projectId,
    suffix,
    suffix,
  );
  await execute(
    "INSERT INTO projects_grants(workspace_id,project_id,principal_id,role,active) VALUES(?,?,?,'manager',1)",
    workspaceId,
    projectId,
    "owner",
  );
  await execute(
    "INSERT INTO issues_issues(workspace_id,id,project_id,number,title,description,priority,state,version) VALUES(?,?,?,?,?,'','medium','todo',1)",
    workspaceId,
    `issue_${suffix}`,
    projectId,
    projectId === "p1" ? 1 : 2,
    suffix,
  );
  await execute(
    "INSERT INTO wiki_pages(workspace_id,id,project_id,slug,title,body,version) VALUES(?,?,?,?,?,'body',1)",
    workspaceId,
    `page_${suffix}`,
    projectId,
    suffix,
    suffix,
  );
  await execute(
    "INSERT INTO coord_limits(workspace_id,project_id,cap,version) VALUES(?,?,2,1)",
    workspaceId,
    projectId,
  );
  await execute(
    "INSERT INTO planning_sprints(workspace_id,id,project_id,name,version,closed) VALUES(?,?,?,?,1,0)",
    workspaceId,
    `sprint_${suffix}`,
    projectId,
    suffix,
  );
  await execute(
    "INSERT INTO insights_metrics(workspace_id,project_id,calculated_at,todo,in_progress,done,active_leases,active_sessions) VALUES(?,?,1,1,0,0,0,0)",
    workspaceId,
    projectId,
  );
  await execute(
    "INSERT INTO integrations_sources(workspace_id,id,project_id,name,secret_hash,webhook_events) VALUES(?,?,?,?,?,'[]')",
    workspaceId,
    `source_${suffix}`,
    projectId,
    suffix,
    "hash",
  );
  await execute(
    "INSERT INTO assets_blobs(workspace_id,id,project_id,size,content_type,filename,sha256,version,state,created_at) VALUES(?,?,?,1,'text/plain','a.txt','hash',1,'ready',1)",
    workspaceId,
    `asset_${suffix}`,
    projectId,
  );
  await bucket.put(`assets/${workspaceId}/asset_${suffix}`, "x");
}
async function requestPurge(workspaceId, projectId, operationId) {
  const lifecycle = p.createLifecycle({
    store: p.createModuleStore(db, "lifecycle"),
    access: {
      requireMembership: async (_principal, ws) => ({
        workspaceId: ws,
        principalId: "owner",
        kind: "human",
        role: "owner",
        clientId: null,
      }),
      me: async () => ({
        principal: { id: "owner", kind: "human" },
        workspaces: [],
        nextCursor: null,
      }),
    },
    projects: { getProjectIncludingArchived: async (_scope, id) => ({ id, archived: false }) },
    owners: {},
    clock: { now: () => Math.floor(Date.now() / 1000) },
    ids: { next: () => crypto.randomUUID().replaceAll("-", "") },
  });
  return lifecycle.api.requestPurge(
    { principal: {}, workspaceId, requestId: operationId },
    {
      operationId,
      expectedVersion: 0,
      ...(projectId ? { projectId } : {}),
      confirmation: projectId ?? workspaceId,
    },
  );
}
async function runToCompletion(workspaceId, scopeId) {
  for (let i = 0; i < 100; i++) {
    await p.Worker.scheduled({}, env);
    const row = await db
      .prepare("SELECT state FROM lifecycle_jobs WHERE workspace_id=? AND scope_id=?")
      .bind(workspaceId, scopeId)
      .first();
    assert(row, "job disappeared");
    if (
      !(await db
        .prepare("SELECT id FROM projects_projects WHERE workspace_id=? AND id=?")
        .bind("w1", "p1")
        .first())
    )
      assert.equal(
        await bucket.get("assets/w1/asset_w1_p1"),
        null,
        "project deleted before R2 object",
      );
    if (
      !(await db
        .prepare("SELECT workspace_id FROM access_workspaces WHERE workspace_id='w1'")
        .first())
    )
      assert.equal(
        await bucket.get("assets/w1/asset_w1_p2"),
        null,
        "workspace deleted before R2 object",
      );
    if (row.state === "complete") return;
  }
  const steps = await db
    .prepare(
      "SELECT owner,state,remaining,pending,error FROM lifecycle_steps WHERE workspace_id=? ORDER BY ordinal",
    )
    .bind(workspaceId)
    .all();
  assert.fail(`scheduled purge did not complete: ${JSON.stringify(steps.results)}`);
}

test("scheduled Worker completes project then workspace purge across real owners", async () => {
  await execute(
    "INSERT INTO access_principals(id,kind,issuer,subject) VALUES('owner','human','test','owner')",
  );
  for (const workspaceId of ["w1", "w2"]) {
    await execute(
      "INSERT INTO access_workspaces(workspace_id,name,version) VALUES(?,?,1)",
      workspaceId,
      workspaceId,
    );
    await execute(
      "INSERT INTO access_memberships(workspace_id,principal_id,role,active,version) VALUES(?,'owner','owner',1,1)",
      workspaceId,
    );
  }
  for (const [workspaceId, projectId] of [
    ["w1", "p1"],
    ["w1", "p2"],
    ["w2", "p1"],
  ])
    await seed(workspaceId, projectId);

  await requestPurge("w1", "p1", "project_purge");
  await runToCompletion("w1", "project:p1");
  for (const table of [
    "projects_projects",
    "issues_issues",
    "wiki_pages",
    "coord_limits",
    "planning_sprints",
    "insights_metrics",
    "integrations_sources",
    "assets_blobs",
  ])
    assert.equal(await count(table, "w1", "p1"), 0, `${table} retained target project`);
  assert.equal(await count("projects_grants", "w1", "p1"), 0);
  assert.equal(await count("access_memberships", "w1"), 1);
  assert.equal(await bucket.get("assets/w1/asset_w1_p1"), null);
  assert(await bucket.get("assets/w1/asset_w1_p2"));
  for (const table of [
    "projects_projects",
    "issues_issues",
    "wiki_pages",
    "coord_limits",
    "planning_sprints",
    "insights_metrics",
    "integrations_sources",
    "assets_blobs",
  ])
    assert.equal(await count(table, "w1", "p2"), 1, `${table} damaged other project`);
  assert.equal(await count("projects_grants", "w1", "p2"), 1);

  await requestPurge("w1", undefined, "workspace_purge");
  await runToCompletion("w1", "workspace");
  assert.equal(await count("access_workspaces", "w1", undefined, "workspace_id"), 0);
  assert.equal(await count("access_memberships", "w1"), 0);
  assert.equal(await bucket.get("assets/w1/asset_w1_p2"), null);
  for (const table of [
    "projects_projects",
    "projects_grants",
    "issues_issues",
    "wiki_pages",
    "coord_limits",
    "planning_sprints",
    "insights_metrics",
    "integrations_sources",
    "assets_blobs",
  ])
    assert.equal(await count(table, "w1"), 0, `${table} retained target workspace`);
  for (const table of [
    "projects_projects",
    "issues_issues",
    "wiki_pages",
    "coord_limits",
    "planning_sprints",
    "insights_metrics",
    "integrations_sources",
    "assets_blobs",
  ])
    assert.equal(await count(table, "w2", "p1"), 1, `${table} damaged other workspace`);
  assert.equal(await count("access_memberships", "w2"), 1);
  assert(await bucket.get("assets/w2/asset_w2_p1"));
});
