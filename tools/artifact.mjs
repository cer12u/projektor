import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { Miniflare } from "miniflare";
import { collect, hash } from "./catalogs.mjs";

const artifact = JSON.parse(fs.readFileSync("dist/artifact.json", "utf8"));
const commit =
  process.env.CI_COMMIT_SHA ??
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.equal(artifact.commit, commit);
assert.equal(artifact.deployable, false);
assert.equal(artifact.catalogHash, hash(JSON.stringify(collect(process.cwd()))));
assert.deepEqual(Object.keys(artifact.files).sort(), [
  "LICENSE",
  "assets/app.js",
  "assets/index.html",
  "assets/style.css",
  "migrations.json",
  "smoke-worker.js",
  "worker.js",
]);
for (const [file, checksum] of Object.entries(artifact.files))
  assert.equal(hash(fs.readFileSync(`dist/${file}`)), checksum, file);
// Inspect every executable production artifact, including the verification Worker.
// A checksum proves integrity, not exclusion of test-only authentication code.
for (const file of ["worker.js", "smoke-worker.js", "assets/app.js"]) {
  const source = fs.readFileSync(`dist/${file}`, "utf8");
  assert(
    !/WEB_TEST_READY|__test|web-test\.cloudflareaccess\.com|web-oauth-test\.example/.test(source),
    `Test authentication/route in ${file}`,
  );
}
assert(!/fixture_[ab]|D1Database|BOOTSTRAP_SECRET/.test(fs.readFileSync("dist/worker.js", "utf8")));
assert(!/cf-access-jwt-assertion/.test(fs.readFileSync("dist/assets/app.js", "utf8")));
assert(!/fixture_[ab]/.test(fs.readFileSync("dist/migrations.json", "utf8")));
assert(!/fixture_[ab]/.test(fs.readFileSync("dist/smoke-worker.js", "utf8")));
const mf = new Miniflare({
  modules: true,
  scriptPath: "dist/worker.js",
  compatibilityDate: "2026-07-30",
  assets: { directory: "dist/assets", routerConfig: { has_user_worker: true } },
  d1Databases: ["DB"],
  kvNamespaces: ["KV"],
  ratelimits: { FEEDBACK_LIMIT: { namespace_id: "1003", simple: { limit: 60, period: 60 } } },
  bindings: {
    ACCESS_TEAM_DOMAIN: "https://unit.cloudflareaccess.com",
    ACCESS_AUDIENCE: "test",
    INTEGRATIONS_KEY: "ab".repeat(32),
  },
});
try {
  const response = await mf.dispatchFetch("http://localhost/health");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { phase: "gateway", deployable: false });
  assert.equal((await mf.dispatchFetch("http://localhost/api/issues")).status, 404);
  const page = await mf.dispatchFetch("http://localhost/");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Projektor/);
} finally {
  await mf.dispose();
}
console.log("Artifact checksums, commit, fixture exclusion and workerd/static-assets smoke passed");
