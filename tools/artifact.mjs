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
assert(
  !/fixture_[ab]|D1Database|BOOTSTRAP_SECRET|WEB_TEST_READY|__test\/token/.test(
    fs.readFileSync("dist/worker.js", "utf8"),
  ),
);
assert(
  !/WEB_TEST_READY|__test\/token|cf-access-jwt-assertion/.test(
    fs.readFileSync("dist/assets/app.js", "utf8"),
  ),
);
assert(!/fixture_[ab]/.test(fs.readFileSync("dist/migrations.json", "utf8")));
assert(!/fixture_[ab]/.test(fs.readFileSync("dist/smoke-worker.js", "utf8")));
const mf = new Miniflare({
  modules: true,
  scriptPath: "dist/worker.js",
  compatibilityDate: "2026-07-30",
  assets: { directory: "dist/assets", routerConfig: { has_user_worker: true } },
  d1Databases: ["DB"],
  kvNamespaces: ["KV"],
  bindings: { ACCESS_TEAM_DOMAIN: "https://unit.cloudflareaccess.com", ACCESS_AUDIENCE: "test" },
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
