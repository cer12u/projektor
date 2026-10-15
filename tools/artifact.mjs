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
const assetFiles = fs
  .readdirSync("dist/assets", { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) =>
    `assets/${entry.parentPath.slice("dist/assets".length + 1)}/${entry.name}`.replace(
      "assets//",
      "assets/",
    ),
  )
  .sort();
assert.deepEqual(
  Object.keys(artifact.files).sort(),
  [
    "LICENSE",
    "migrate-worker.js",
    "migrations.json",
    "smoke-worker.js",
    "worker.js",
    ...assetFiles,
  ].sort(),
);
for (const [file, checksum] of Object.entries(artifact.files))
  assert.equal(hash(fs.readFileSync(`dist/${file}`)), checksum, file);
// Inspect every executable production artifact, including the verification Worker.
// A checksum proves integrity, not exclusion of test-only authentication code.
for (const file of [
  "worker.js",
  "smoke-worker.js",
  "migrate-worker.js",
  ...assetFiles.filter((file) => /\.(?:js|html)$/.test(file)),
]) {
  const source = fs.readFileSync(`dist/${file}`, "utf8");
  assert(
    !/WEB_TEST_READY|__test|web-test\.cloudflareaccess\.com|web-oauth-test\.example/.test(source),
    `Test authentication/route in ${file}`,
  );
}
assert(!/fixture_[ab]|D1Database|BOOTSTRAP_SECRET/.test(fs.readFileSync("dist/worker.js", "utf8")));
for (const file of assetFiles.filter((file) => /\.js$/.test(file)))
  assert(!/cf-access-jwt-assertion/.test(fs.readFileSync(`dist/${file}`, "utf8")));
assert(!/fixture_[ab]/.test(fs.readFileSync("dist/migrations.json", "utf8")));
assert(!/fixture_[ab]/.test(fs.readFileSync("dist/smoke-worker.js", "utf8")));
const mf = new Miniflare({
  modules: true,
  scriptPath: "dist/worker.js",
  compatibilityDate: "2026-07-30",
  assets: { directory: "dist/assets", binding: "ASSETS", routerConfig: { has_user_worker: true } },
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
  const issues = await mf.dispatchFetch("http://localhost/api/issues");
  assert.equal(issues.status, 403);
  const deferred = await mf.dispatchFetch("http://localhost/auth/refresh");
  assert.equal(deferred.status, 501);
  assert.deepEqual(await deferred.json(), { error: "Not implemented" });
  const page = await mf.dispatchFetch("http://localhost/");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Projektor/);
} finally {
  await mf.dispose();
}
console.log("Artifact checksums, commit, fixture exclusion and workerd/static-assets smoke passed");
