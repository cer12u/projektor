import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

test("11a Worker scheduled discovers every active workspace beyond one keyset page before any feed read", async () => {
  fs.mkdirSync(".tmp", { recursive: true });
  await build({
    entryPoints: ["tools/insights-scheduled-entry.ts"],
    outfile: ".tmp/test-entry.mjs",
    bundle: true,
    format: "esm",
    platform: "node",
  });
  const { worker, migrate } = await import("../.tmp/test-entry.mjs");
  const mf = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('ok')}}",
    compatibilityDate: "2026-07-30",
    d1Databases: ["DB"],
    kvNamespaces: ["KV"],
    r2Buckets: ["R2"],
  });
  try {
    const db = await mf.getD1Database("DB");
    await migrate(db, [
      "access",
      "projects",
      "issues",
      "wiki",
      "coordination",
      "planning",
      "assets",
      "insights",
      "integrations",
    ]);
    const workspaces = Array.from({ length: 102 }, (_, i) => `w${String(i).padStart(3, "0")}`);
    for (const w of workspaces) {
      await db.batch([
        db
          .prepare(
            "INSERT INTO access_workspaces(workspace_id,name,version,archived) VALUES(?,?,1,?)",
          )
          .bind(w, w, w === "w050" ? 1 : 0),
        db
          .prepare(
            "INSERT INTO projects_events(workspace_id,sequence,event_id,aggregate_id,aggregate_version,type,occurred_at,actor_id,client_id,schema_version) VALUES(?,1,'e','p',1,'ProjectChanged',1,'agent','Codex',2)",
          )
          .bind(w),
      ]);
    }
    const env = {
      DB: db,
      KV: await mf.getKVNamespace("KV"),
      R2: await mf.getR2Bucket("R2"),
      ACCESS_TEAM_DOMAIN: "https://unit.cloudflareaccess.com",
      ACCESS_AUDIENCE: "unit",
      INTEGRATIONS_KEY: "ab".repeat(32),
      FEEDBACK_LIMIT: { limit: async () => ({ success: true }) },
    };
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM insights_cursors").first()).n, 0);
    await worker.scheduled({}, env);
    const rows = (
      await db
        .prepare("SELECT workspace_id,client_id FROM insights_activity ORDER BY workspace_id")
        .all()
    ).results;
    assert.deepEqual(
      rows.map((x) => x.workspace_id),
      workspaces.filter((w) => w !== "w050"),
    );
    assert(rows.every((x) => x.client_id === "Codex"));
    const cursor = await db
      .prepare(
        "SELECT sequence FROM insights_cursors WHERE workspace_id='w101' AND source='projects'",
      )
      .first();
    assert.equal(cursor.sequence, 1);
    await db
      .prepare(
        "INSERT INTO projects_events(workspace_id,sequence,event_id,aggregate_id,aggregate_version,type,occurred_at,actor_id) VALUES('w101',2,'e2','p',2,'ProjectChanged',2,'agent')",
      )
      .run();
    await worker.scheduled({}, env);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM insights_activity").first()).n, 102);
  } finally {
    await mf.dispose();
  }
});
