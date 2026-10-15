// Code-only deployment. Provisioning, migrations, secrets and Access changes are operator-owned.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const env = process.env;
for (const key of [
  "CF_DEPLOY_CONFIG",
  "CF_PRODUCTION_READY",
  "CF_PRESERVED_D1_IDS",
  "CF_APPROVED_SCHEMA_SHA256",
])
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
    "oauthEnabled",
    "integrationsEnabled",
  ].sort(),
);
assert.equal(typeof installation.oauthEnabled, "boolean");
assert.equal(typeof installation.integrationsEnabled, "boolean");
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
assert.equal(installation.worker, base.name, "Configured Worker name must match");
assert(
  !Object.hasOwn(base, "routes") && !Object.hasOwn(base, "route"),
  "Automatic deploy must not manage routes/custom domains",
);
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
    ...(installation.oauthEnabled
      ? { OAUTH_ISSUER: origin.origin, OAUTH_RESOURCE: `${origin.origin}/mcp` }
      : {}),
  },
  secrets: {
    required: [
      ...(installation.integrationsEnabled ? ["INTEGRATIONS_KEY"] : []),
      ...(installation.oauthEnabled ? ["OAUTH_FORM_SECRET"] : []),
    ],
  },
};
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "projektor-code-deploy-"));
const file = path.join(temp, "wrangler.json");
fs.writeFileSync(file, JSON.stringify(config));
const cli = path.resolve("node_modules/.bin/wrangler");
const run = (args) =>
  execFileSync(cli, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
try {
  // Initial ledger verification is operator-owned: ongoing CI needs no storage-read grant.
  assert.equal(
    createHash("sha256").update(fs.readFileSync("dist/migrations.json")).digest("hex"),
    env.CF_APPROVED_SCHEMA_SHA256,
    "Schema changed: initialize/upgrade the approved D1 separately and approve its schema hash",
  );
  const secrets = JSON.parse(run(["secret", "list", "--config", file]));
  for (const key of config.secrets.required)
    assert(
      secrets.some((x) => x.name === key),
      `Missing Worker secret ${key}`,
    );
  for (const [enabled, key] of [
    [installation.oauthEnabled, "OAUTH_FORM_SECRET"],
    [installation.integrationsEnabled, "INTEGRATIONS_KEY"],
  ])
    if (!enabled)
      assert(
        !secrets.some((x) => x.name === key),
        `${key} already enables the feature; review configuration instead of silently disabling it`,
      );
  const boundary = await fetch(`${origin.origin}/api/me`, {
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  assert(
    [401, 403, 302, 303].includes(boundary.status),
    "Unauthenticated API boundary must remain protected",
  );
  run(["deploy", "--config", file, "--no-bundle", "--dry-run"]);
  if (process.argv.includes("--check")) console.log("Read-only production preflight passed");
  else {
    const output = run(["deploy", "--config", file, "--no-bundle"]);
    const version = output.match(/Current Version ID:\s*([0-9a-f-]{36})/)?.[1];
    assert(version, "Wrangler did not report the deployed version");
    const deployments = JSON.parse(run(["deployments", "list", "--config", file, "--json"]));
    const active = deployments.sort((a, b) => a.created_on.localeCompare(b.created_on)).at(-1);
    assert(
      active?.versions?.some((x) => x.version_id === version && x.percentage === 100),
      "New version is not the active 100% deployment",
    );
    console.log(
      "Code-only deployment and active version verification passed; Access remains protected",
    );
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
