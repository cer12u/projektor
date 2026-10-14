// Code-only deployment. Provisioning, migrations, secrets and Access changes are operator-owned.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const env = process.env;
for (const key of ["CF_DEPLOY_CONFIG", "CF_PRODUCTION_READY", "CF_PRESERVED_D1_IDS"])
  assert(env[key], `Missing ${key}`);
assert.equal(env.CF_PRODUCTION_READY, "true", "Initial setup must be approved and complete");
const installation = JSON.parse(env.CF_DEPLOY_CONFIG);
assert.deepEqual(
  Object.keys(installation).sort(),
  [
    "accessAudience",
    "accessTeamDomain",
    "d1Id",
    "d1Name",
    "kvId",
    "origin",
    "rateIds",
    "r2Name",
    "worker",
  ].sort(),
);
assert.match(installation.worker, /^[a-z0-9-]{1,63}$/);
assert.match(installation.d1Id, /^[0-9a-f-]{36}$/);
assert(
  !env.CF_PRESERVED_D1_IDS.split(",")
    .map((x) => x.trim())
    .includes(installation.d1Id),
  "Preserved D1 cannot be deployed against",
);
assert.match(installation.d1Name, /^[a-z0-9-]{3,63}$/);
assert.match(installation.kvId, /^[0-9a-f]{32}$/);
assert.match(installation.r2Name, /^[a-z0-9-]{3,63}$/);
assert.match(installation.accessTeamDomain, /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/);
assert.match(installation.accessAudience, /^[0-9a-f]{64}$/);
const origin = new URL(installation.origin);
assert.equal(origin.protocol, "https:");
assert.equal(origin.href, `${origin.origin}/`);
assert(
  Array.isArray(installation.rateIds) &&
    installation.rateIds.length === 3 &&
    installation.rateIds.every((x) => /^\d+$/.test(x)) &&
    new Set(installation.rateIds).size === 3,
);
const artifact = JSON.parse(fs.readFileSync("dist/artifact.json", "utf8"));
const sha =
  env.WORKERS_CI_COMMIT_SHA ??
  env.GITHUB_SHA ??
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.equal(artifact.commit, sha);
for (const [file, checksum] of Object.entries(artifact.files))
  assert.equal(
    createHash("sha256")
      .update(fs.readFileSync(path.join("dist", file)))
      .digest("hex"),
    checksum,
    `Artifact checksum: ${file}`,
  );
const base = JSON.parse(fs.readFileSync("wrangler.jsonc", "utf8"));
assert.equal(installation.worker, base.name, "Workers Builds Worker name must match");
const config = {
  ...base,
  main: path.resolve("dist/worker.js"),
  workers_dev: false,
  preview_urls: false,
  assets: { ...base.assets, directory: path.resolve("dist/assets") },
  d1_databases: [
    { binding: "DB", database_name: installation.d1Name, database_id: installation.d1Id },
  ],
  kv_namespaces: [{ binding: "KV", id: installation.kvId }],
  r2_buckets: [{ binding: "R2", bucket_name: installation.r2Name }],
  ratelimits: base.ratelimits.map((x, i) => ({ ...x, namespace_id: installation.rateIds[i] })),
  vars: {
    ACCESS_TEAM_DOMAIN: installation.accessTeamDomain,
    ACCESS_AUDIENCE: installation.accessAudience,
    OAUTH_ISSUER: origin.origin,
    OAUTH_RESOURCE: `${origin.origin}/mcp`,
  },
  secrets: { required: ["INTEGRATIONS_KEY", "OAUTH_FORM_SECRET"] },
};
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "projektor-code-deploy-"));
const file = path.join(temp, "wrangler.json");
fs.writeFileSync(file, JSON.stringify(config));
const cli = path.resolve("node_modules/.bin/wrangler");
const run = (args) =>
  execFileSync(cli, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
try {
  // Only SELECT: fail closed if the independently initialized schema differs from this build.
  const result = JSON.parse(
    run([
      "d1",
      "execute",
      installation.d1Name,
      "--config",
      file,
      "--remote",
      "--json",
      "--command",
      "SELECT owner, version, checksum FROM platform_schema_versions ORDER BY owner, version",
    ]),
  );
  const rows = result.flatMap((x) => x.results ?? []);
  const migrations = JSON.parse(fs.readFileSync("dist/migrations.json", "utf8"));
  const expected = Object.entries(migrations).flatMap(([owner, items]) =>
    items.map((x) => ({ owner, version: x.version, checksum: x.checksum })),
  );
  const sort = (xs) =>
    xs.sort((a, b) => a.owner.localeCompare(b.owner) || a.version.localeCompare(b.version));
  assert.deepEqual(
    sort(rows),
    sort(expected),
    "Schema differs: operator must initialize/upgrade approved D1 separately",
  );
  const secrets = JSON.parse(run(["secret", "list", "--config", file]));
  for (const key of config.secrets.required)
    assert(
      secrets.some((x) => x.name === key),
      `Missing Worker secret ${key}`,
    );
  run(["kv", "namespace", "list"]).includes(installation.kvId) ||
    assert.fail("Approved KV missing");
  run(["r2", "bucket", "info", installation.r2Name]);
  for (const [url, status] of [
    ["/health", 200],
    ["/api/me", 403],
    ["/.well-known/oauth-protected-resource/mcp", 200],
  ]) {
    const response = await fetch(`${origin.origin}${url}`, { redirect: "manual" });
    assert.equal(response.status, status, `Access/runtime readiness failed for ${url}`);
    if (url === "/health") assert.equal((await response.json()).phase, "gateway");
  }
  run(["deploy", "--config", file, "--no-bundle", "--dry-run"]);
  if (process.argv.includes("--check")) console.log("Read-only production preflight passed");
  else {
    run(["deploy", "--config", file, "--no-bundle"]);
    const response = await fetch(`${origin.origin}/health`, { redirect: "manual" });
    assert.equal(
      response.status,
      200,
      "Post-deploy health failed; inspect deployment and roll back explicitly",
    );
    assert.equal((await response.json()).phase, "gateway");
    console.log("Code-only deployment and health check passed");
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
