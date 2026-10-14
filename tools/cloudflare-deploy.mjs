// Production deploy from protected main (manual `deploy` job). Every installation value
// comes from CI/CD variables; see docs/operations.md. Steps:
//   1. verify the build artifact against dist/artifact.json;
//   2. find or create the production D1, KV and R2 by name;
//   3. apply D1 migrations through a short-lived, secret-gated migrate Worker;
//   4. deploy the Worker with generated configuration and secrets;
//   5. check the public origin, and roll back to the previous version if health fails.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const env = process.env;
const required = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CF_PROD_WORKER",
  "CF_PROD_RESOURCE_NAME",
  "CF_PROD_ORIGIN",
  "CF_PROD_RATELIMIT_IDS",
  "ACCESS_TEAM_DOMAIN",
  "ACCESS_AUDIENCE",
  "PROD_INTEGRATIONS_KEY",
  "PROD_OAUTH_FORM_SECRET",
];
const missing = required.filter((name) => !env[name]);
if (missing.length) {
  console.error(`Deploy requires CI/CD variables: ${missing.join(", ")} (exit 78)`);
  process.exit(78);
}
const name = /^[a-z0-9-]{1,63}$/;
assert.match(env.CF_PROD_WORKER, name, "CF_PROD_WORKER must be a Worker name");
assert.match(env.CF_PROD_RESOURCE_NAME, /^[a-z0-9-]{3,63}$/, "CF_PROD_RESOURCE_NAME");
const origin = new URL(env.CF_PROD_ORIGIN);
assert(
  origin.protocol === "https:" && origin.pathname === "/" && !origin.search,
  "CF_PROD_ORIGIN must be an https origin",
);
const publicOrigin = origin.origin;
assert.match(env.ACCESS_TEAM_DOMAIN, /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/);
assert.match(env.PROD_INTEGRATIONS_KEY, /^[0-9a-f]{64}$/, "PROD_INTEGRATIONS_KEY: 64 hex");
assert(env.PROD_OAUTH_FORM_SECRET.length >= 32, "PROD_OAUTH_FORM_SECRET: 32+ characters");
const rateIds = env.CF_PROD_RATELIMIT_IDS.split(",").map((x) => x.trim());
assert(rateIds.length === 3 && rateIds.every((x) => /^\d+$/.test(x)), "CF_PROD_RATELIMIT_IDS");

const artifact = JSON.parse(fs.readFileSync("dist/artifact.json", "utf8"));
assert.equal(artifact.commit, env.CI_COMMIT_SHA, "build artifact commit mismatch");
for (const [file, expected] of Object.entries(artifact.files)) {
  const actual = createHash("sha256")
    .update(fs.readFileSync(path.join("dist", file)))
    .digest("hex");
  assert.equal(actual, expected, `build artifact checksum mismatch: ${file}`);
}
for (const file of ["worker.js", "migrate-worker.js", "assets/index.html"])
  assert(Object.hasOwn(artifact.files, file), `artifact lacks ${file}`);

// The committed wrangler.jsonc is the single source for everything that is not
// installation-specific: compatibility date, assets routing, crons and limits.
const base = JSON.parse(fs.readFileSync("wrangler.jsonc", "utf8").replace(/^\s*\/\/.*$/gm, ""));
const limits = Object.fromEntries(
  ["OAUTH_REGISTER_LIMIT", "OAUTH_TOKEN_LIMIT", "FEEDBACK_LIMIT"].map((binding, i) => {
    const entry = base.ratelimits.find((x) => x.name === binding);
    assert(entry, `wrangler.jsonc lacks ${binding}`);
    return [binding, { ...entry, namespace_id: rateIds[i] }];
  }),
);

const wrangler = path.resolve("node_modules/.bin/wrangler");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "projektor-deploy-"));
const run = (...args) =>
  execFileSync(wrangler, args, {
    cwd: temp,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
const write = (file, value, mode) => {
  const target = path.join(temp, file);
  fs.writeFileSync(target, JSON.stringify(value), mode ? { mode } : undefined);
  return target;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const resourceName = env.CF_PROD_RESOURCE_NAME;
function resources() {
  const databases = JSON.parse(run("d1", "list", "--json"));
  const namespaces = JSON.parse(run("kv", "namespace", "list"));
  const buckets = run("r2", "bucket", "list");
  return {
    d1: databases.find((item) => item.name === resourceName)?.uuid,
    kv: namespaces.find((item) => item.title === resourceName)?.id,
    r2: new RegExp(`(?<![a-z0-9-])${resourceName}(?![a-z0-9-])`, "i").test(buckets),
  };
}

try {
  let found = resources();
  if (!found.d1) run("d1", "create", resourceName);
  if (!found.kv) run("kv", "namespace", "create", resourceName);
  if (!found.r2) run("r2", "bucket", "create", resourceName);
  found = resources();
  if (!found.d1 || !found.kv || !found.r2)
    throw new Error("Production resources were not found after provisioning");
  console.log(`Production resources: ${resourceName}`);
  const database = { binding: "DB", database_name: resourceName, database_id: found.d1 };

  // Migrations run through the real platform ledger on a real D1 binding.
  const migrateName = `${env.CF_PROD_WORKER}-migrate`;
  const migrateSecret = randomBytes(32).toString("hex");
  const migrateConfig = write("migrate.json", {
    name: migrateName,
    main: path.resolve("dist/migrate-worker.js"),
    compatibility_date: base.compatibility_date,
    workers_dev: true,
    d1_databases: [database],
  });
  const migrateSecrets = write("migrate-secrets.json", { MIGRATE_SECRET: migrateSecret }, 0o600);
  try {
    const output = run(
      "deploy",
      "--config",
      migrateConfig,
      "--no-bundle",
      "--secrets-file",
      migrateSecrets,
    );
    const url = output.match(
      new RegExp(`https://${migrateName}\\.[a-z0-9-]+\\.workers\\.dev`),
    )?.[0];
    if (!url) throw new Error("Wrangler did not return the migrate Worker URL");
    const call = (method) =>
      fetch(`${url}/__migrate`, { method, headers: { "x-migrate-secret": migrateSecret } });
    const deadline = Date.now() + 120_000;
    while ((await call("GET").catch(() => null))?.status !== 405) {
      if (Date.now() > deadline) throw new Error("Migrate Worker did not become ready");
      await sleep(3000);
    }
    const response = await call("POST");
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Migration failed: ${result.error ?? response.status}`);
    console.log(`Migrations applied: ${result.migrations} ledger rows`);
  } finally {
    try {
      run("delete", "--name", migrateName, "--force");
    } catch {
      console.error(`WARNING: delete the temporary Worker ${migrateName} manually`);
      process.exitCode = 1;
    }
  }

  const config = write("worker.json", {
    name: env.CF_PROD_WORKER,
    main: path.resolve("dist/worker.js"),
    compatibility_date: base.compatibility_date,
    workers_dev: false,
    preview_urls: false,
    assets: { ...base.assets, directory: path.resolve("dist/assets") },
    triggers: base.triggers,
    ratelimits: Object.values(limits),
    d1_databases: [database],
    kv_namespaces: [{ binding: "KV", id: found.kv }],
    r2_buckets: [{ binding: "R2", bucket_name: resourceName }],
    vars: {
      ACCESS_TEAM_DOMAIN: env.ACCESS_TEAM_DOMAIN,
      ACCESS_AUDIENCE: env.ACCESS_AUDIENCE,
      OAUTH_ISSUER: publicOrigin,
      OAUTH_RESOURCE: `${publicOrigin}/mcp`,
    },
  });
  const secrets = write(
    "secrets.json",
    {
      INTEGRATIONS_KEY: env.PROD_INTEGRATIONS_KEY,
      OAUTH_FORM_SECRET: env.PROD_OAUTH_FORM_SECRET,
    },
    0o600,
  );
  const deployed = run("deploy", "--config", config, "--no-bundle", "--secrets-file", secrets);
  const version = deployed.match(/Current Version ID:\s*([0-9a-f-]{36})/)?.[1];
  console.log(`Deployed ${env.CF_PROD_WORKER}${version ? ` version ${version}` : ""}`);

  // The new version must answer on the public origin; otherwise restore the previous one.
  const deadline = Date.now() + Number(env.DEPLOY_HEALTH_TIMEOUT_MS ?? 180_000);
  let healthy = false;
  while (Date.now() < deadline && !healthy) {
    const response = await fetch(`${publicOrigin}/health`, { redirect: "manual" }).catch(
      () => null,
    );
    const body = response?.ok ? await response.json().catch(() => null) : null;
    healthy = body?.phase === "gateway";
    if (!healthy) await sleep(5000);
  }
  if (!healthy) {
    console.error(
      `${publicOrigin}/health did not answer as the new Worker. Check that Access bypasses /health. Rolling back.`,
    );
    run(
      "rollback",
      "--name",
      env.CF_PROD_WORKER,
      "--message",
      `auto rollback ${env.CI_PIPELINE_ID ?? ""}`,
      "-y",
    );
    process.exit(1);
  }
  console.log(`${publicOrigin}/health OK`);
  // Agent paths must reach the Worker without an Access login (see docs/operations.md).
  const probes = [
    ["GET", "/.well-known/oauth-protected-resource/mcp", 200],
    ["POST", "/mcp/probe", 401],
    ["GET", "/api/me", 403],
  ];
  for (const [method, probe, expected] of probes) {
    const response = await fetch(`${publicOrigin}${probe}`, { method, redirect: "manual" }).catch(
      () => null,
    );
    const status = response?.status ?? "network error";
    console.log(
      `${status === expected ? "OK  " : "WARN"} ${method} ${probe} -> ${status} (expected ${expected})`,
    );
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
