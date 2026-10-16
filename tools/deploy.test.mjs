import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

test("migrate Worker is secret-gated and applies every production owner idempotently", async () => {
  const secret = randomBytes(32).toString("hex");
  const mf = new Miniflare({
    modules: true,
    scriptPath: "dist/migrate-worker.js",
    compatibilityDate: "2026-07-30",
    d1Databases: ["DB"],
    bindings: { MIGRATE_SECRET: secret },
  });
  try {
    const call = (method, headers = {}, url = "http://localhost/__migrate") =>
      mf.dispatchFetch(url, { method, headers });
    assert.equal((await call("POST")).status, 403);
    assert.equal((await call("POST", { "x-migrate-secret": "wrong" })).status, 403);
    assert.equal((await call("GET", { "x-migrate-secret": secret })).status, 405);
    assert.equal((await call("GET", {}, "http://localhost/api/me")).status, 404);
    const first = await (await call("POST", { "x-migrate-secret": secret })).json();
    const second = await (await call("POST", { "x-migrate-secret": secret })).json();
    assert(first.migrations > 0);
    assert.equal(second.migrations, first.migrations);
    assert.deepEqual(first.owners, [
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
    ]);
  } finally {
    await mf.dispose();
  }
});

// Run the real deploy script with only process execution and fetch replaced, so no
// account or network is touched. `health` decides whether the new version answers.
async function orchestrate(health, placement) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-test-"));
  const built = await build({
    entryPoints: ["tools/cloudflare-deploy.mjs"],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    plugins: [
      {
        name: "fake-process",
        setup(plugin) {
          plugin.onResolve({ filter: /^node:child_process$/ }, () => ({
            path: "process",
            namespace: "fake",
          }));
          plugin.onLoad({ filter: /.*/, namespace: "fake" }, () => ({
            contents: `
              import fs from "node:fs";
              export function execFileSync(file, args, options) {
                fs.appendFileSync(${JSON.stringify(path.join(dir, "calls.log"))}, args.join(" ") + "\\n");
                if (args[0] === "deploy") {
                  const config = JSON.parse(fs.readFileSync(args[2], "utf8"));
                  fs.writeFileSync(${JSON.stringify(path.join(dir, "config-"))} + config.name + ".json", JSON.stringify(config));
                  return config.workers_dev
                    ? "https://" + config.name + ".unit.workers.dev"
                    : "Current Version ID: 11111111-2222-3333-4444-555555555555";
                }
                if (args[0] === "d1") return JSON.stringify([{ name: "prod-data", uuid: "d1" }]);
                if (args[0] === "kv") return JSON.stringify([{ title: "prod-data", id: "kv" }]);
                if (args[0] === "r2") return "prod-data";
                return "";
              }`,
          }));
        },
      },
    ],
  });
  fs.writeFileSync(path.join(dir, "script.mjs"), built.outputFiles[0].text);
  fs.writeFileSync(
    path.join(dir, "fetch-stub.mjs"),
    `globalThis.fetch = async (url, init = {}) => {
      const u = new URL(String(url));
      if (u.pathname === "/__migrate")
        return new Response(JSON.stringify({ migrations: 30 }), { status: init.method === "POST" ? 200 : 405 });
      if (u.pathname === "/health")
        return ${health} ? new Response(JSON.stringify({ phase: "gateway" })) : new Response("login", { status: 302 });
      return new Response("{}", { status: 200 });
    };`,
  );
  fs.mkdirSync(path.join(dir, "dist/assets"), { recursive: true });
  const files = {};
  for (const file of ["worker.js", "migrate-worker.js", "assets/index.html"]) {
    fs.writeFileSync(path.join(dir, "dist", file), file);
    files[file] = createHash("sha256").update(file).digest("hex");
  }
  fs.writeFileSync(path.join(dir, "dist/artifact.json"), JSON.stringify({ commit: "c1", files }));
  fs.copyFileSync("wrangler.jsonc", path.join(dir, "wrangler.jsonc"));
  const secret = randomBytes(32).toString("hex");
  const formSecret = `form-${randomBytes(24).toString("hex")}`;
  const result = spawnSync(process.execPath, ["--import", "./fetch-stub.mjs", "script.mjs"], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      CI_COMMIT_SHA: "c1",
      CLOUDFLARE_API_TOKEN: "token-sentinel-value",
      CLOUDFLARE_ACCOUNT_ID: "acct",
      CF_PROD_WORKER: "prod-app",
      CF_PROD_RESOURCE_NAME: "prod-data",
      CF_PROD_ORIGIN: "https://app.example.com",
      CF_PROD_RATELIMIT_IDS: "7001,7002,7003",
      ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      ACCESS_AUDIENCE: "aud",
      PROD_INTEGRATIONS_KEY: secret,
      PROD_OAUTH_FORM_SECRET: formSecret,
      DEPLOY_HEALTH_TIMEOUT_MS: "1",
      ...(placement === undefined ? {} : { CF_DEPLOY_CONFIG: JSON.stringify({ placement }) }),
    },
  });
  const callsFile = path.join(dir, "calls.log");
  const calls = fs.existsSync(callsFile)
    ? fs.readFileSync(callsFile, "utf8").trim().split("\n")
    : [];
  const configs = Object.fromEntries(
    fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("config-"))
      .map((f) => [f.slice(7, -5), JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))]),
  );
  const read = (name) => configs[name];
  const output = result.stdout + result.stderr;
  fs.rmSync(dir, { recursive: true, force: true });
  for (const value of ["token-sentinel-value", secret, formSecret])
    assert.equal(output.includes(value), false, "a secret was printed");
  return { status: result.status, calls, read, output };
}

test("deploy migrates through a temporary Worker, deploys generated config and checks health", async () => {
  const { status, calls, read } = await orchestrate(true);
  assert.equal(status, 0);
  const deploys = calls.filter((c) => c.startsWith("deploy "));
  assert.equal(deploys.length, 2, "migrate Worker first, then the app");
  assert(calls.indexOf("delete --name prod-app-migrate --force") > calls.indexOf(deploys[0]));
  assert(calls.indexOf("delete --name prod-app-migrate --force") < calls.indexOf(deploys[1]));
  assert(!calls.some((c) => c.startsWith("rollback")));
  const app = read("prod-app");
  assert.equal(app.workers_dev, false);
  assert.deepEqual(app.d1_databases, [
    { binding: "DB", database_name: "prod-data", database_id: "d1" },
  ]);
  assert.deepEqual(app.vars, {
    ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
    ACCESS_AUDIENCE: "aud",
    OAUTH_ISSUER: "https://app.example.com",
    OAUTH_RESOURCE: "https://app.example.com/mcp",
  });
  assert.deepEqual(
    app.ratelimits.map((r) => r.namespace_id),
    ["7001", "7002", "7003"],
  );
  assert(app.assets.run_worker_first.includes("/mcp/*"));
  assert.equal(read("prod-app-migrate").d1_databases[0].database_id, "d1");
});

test("legacy deploy emits opt-in Smart Placement and rejects other values", async () => {
  const enabled = await orchestrate(true, "smart");
  assert.equal(enabled.status, 0);
  assert.deepEqual(enabled.read("prod-app").placement, { mode: "smart" });
  const invalid = await orchestrate(true, "nearest");
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.output, /Invalid placement/);
});

test(
  "deploy rolls back when the new version does not answer health",
  async () => {
    const { status, calls } = await orchestrate(false);
    assert.equal(status, 1);
    assert(calls.some((c) => c.startsWith("rollback --name prod-app")));
  },
  { timeout: 300_000 },
);
