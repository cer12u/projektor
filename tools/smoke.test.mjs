import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { checkSmoke } from "./smoke-check.mjs";

const sentinel = "audit-only-token-DO-NOT-PRINT";
test("07c smoke missing either credential fails closed without revealing values", () => {
  for (const [token, account] of [
    ["", ""],
    [sentinel, ""],
    ["", "audit-account"],
  ]) {
    const result = spawnSync(process.execPath, ["tools/cloudflare-smoke.mjs"], {
      encoding: "utf8",
      env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account },
    });
    assert.equal(result.status, 78);
    assert.match(result.stderr, /requires protected/);
    assert.equal((result.stdout + result.stderr).includes(sentinel), false);
  }
});

test("07c smoke successful orchestration never logs API token", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-audit-"));
  try {
    // Replace only process execution, so no account resources/network are touched.
    // Run the real script through checksum verification, discovery, deploy, check and cleanup.
    const built = await build({
      entryPoints: ["tools/cloudflare-smoke.mjs"],
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
              namespace: "audit",
            }));
            plugin.onLoad({ filter: /.*/, namespace: "audit" }, () => ({
              contents: `
          import assert from 'node:assert/strict';
          import fs from 'node:fs';
          export function execFileSync(file, args) {
            if (args[0] === 'd1') return JSON.stringify([{name:'projektor-verify', uuid:'d1'}]);
            if (args[0] === 'kv') return JSON.stringify([{title:'projektor-verify', id:'kv'}]);
            if (args[0] === 'r2') return 'projektor-verify';
            if (args[0] === 'deploy') {
              const config = JSON.parse(fs.readFileSync(args[args.indexOf('--config') + 1], 'utf8'));
              const secretPath = args[args.indexOf('--secrets-file') + 1];
              const secrets = JSON.parse(fs.readFileSync(secretPath, 'utf8'));
              assert.equal(/^[0-9a-f]{64}$/.test(secrets.INTEGRATIONS_KEY), true, 'missing vault key');
              assert.equal(secrets.INTEGRATIONS_KEY !== secrets.SMOKE_SECRET, true, 'keys must be independent');
              assert.equal(fs.statSync(secretPath).mode & 0o777, 0o600);
              assert.deepEqual(config.ratelimits, [
                { name: 'OAUTH_REGISTER_LIMIT', namespace_id: '1001', simple: { limit: 10, period: 60 } },
                { name: 'OAUTH_TOKEN_LIMIT', namespace_id: '1002', simple: { limit: 60, period: 60 } },
                { name: 'FEEDBACK_LIMIT', namespace_id: '1003', simple: { limit: 60, period: 60 } },
              ]);
              return 'https://projektor-verify.audit.workers.dev';
            }
            if (args[0] === 'tools/smoke-check.mjs') return 'AUDIT_SMOKE_COMPLETE\\n';
            throw new Error('Unexpected subprocess');
          }`,
            }));
          },
        },
      ],
    });
    fs.writeFileSync(path.join(dir, "script.mjs"), built.outputFiles[0].text);
    fs.mkdirSync(path.join(dir, "dist"));
    fs.writeFileSync(path.join(dir, "dist/smoke-worker.js"), "audit");
    fs.writeFileSync(
      path.join(dir, "dist/artifact.json"),
      JSON.stringify({
        commit: "audit",
        files: { "smoke-worker.js": createHash("sha256").update("audit").digest("hex") },
      }),
    );
    // The readiness probe is the only network call; answer it as the fresh deploy would.
    fs.writeFileSync(
      path.join(dir, "fetch-stub.mjs"),
      `globalThis.fetch = async (url, init) => {
        if (String(url) === "https://projektor-verify.audit.workers.dev/__smoke/migrate" &&
            /^[0-9a-f]{64}$/.test(init?.headers?.["x-smoke-secret"] ?? ""))
          return new Response("{}", { status: 405 });
        throw new Error("Unexpected fetch");
      };`,
    );
    const result = spawnSync(process.execPath, ["--import", "./fetch-stub.mjs", "script.mjs"], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        CI_COMMIT_SHA: "audit",
        CLOUDFLARE_API_TOKEN: sentinel,
        CLOUDFLARE_ACCOUNT_ID: "audit-account",
      },
    });
    assert.equal(result.status, 0, "mock orchestration should complete");
    assert.match(result.stdout, /AUDIT_SMOKE_COMPLETE/);
    assert.equal((result.stdout + result.stderr).includes(sentinel), false, "API token leaked");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("smoke failures omit potentially secret-bearing remote response bodies", async () => {
  await assert.rejects(
    checkSmoke(
      async () => new Response(JSON.stringify({ secret: sentinel }), { status: 500 }),
      "https://projektor-verify.audit.workers.dev",
      sentinel,
    ),
    (error) => error.message === "/__smoke/migrate: HTTP 500",
  );
});

test("remote smoke retries a 403 on the second migration call", async () => {
  const statuses = [200, 403, 200];
  let migrationCalls = 0;
  await assert.rejects(
    checkSmoke(
      async (url) => {
        if (String(url).endsWith("/__smoke/migrate")) {
          migrationCalls++;
          return new Response(JSON.stringify({ migrations: 1 }), { status: statuses.shift() });
        }
        return new Response("{}", { status: 500 });
      },
      "https://example.test",
      "secret",
      true,
    ),
    /\/__smoke\/bootstrap: HTTP 500/,
  );
  assert.equal(migrationCalls, 3);
});

test("smoke Worker gates probes and checks D1, migrations, R2 and signed feedback deduplication", async () => {
  const mf = new Miniflare({
    modules: true,
    scriptPath: "dist/smoke-worker.js",
    compatibilityDate: "2026-07-30",
    d1Databases: ["DB"],
    kvNamespaces: ["KV"],
    r2Buckets: ["R2"],
    ratelimits: { FEEDBACK_LIMIT: { namespace_id: "1003", simple: { limit: 60, period: 60 } } },
    bindings: {
      SMOKE_ENABLED: "1",
      SMOKE_SECRET: sentinel,
      ACCESS_TEAM_DOMAIN: "https://unit.cloudflareaccess.com",
      ACCESS_AUDIENCE: "audit",
      INTEGRATIONS_KEY: "ab".repeat(32),
    },
  });
  try {
    for (const secret of [undefined, "wrong"]) {
      const response = await mf.dispatchFetch("http://localhost/__smoke/migrate", {
        method: "POST",
        headers: secret ? { "x-smoke-secret": secret } : {},
      });
      assert.equal(response.status, 403);
      assert.equal((await response.text()).includes(sentinel), false);
    }
    const result = await checkSmoke(
      (url, init) => mf.dispatchFetch(url, init),
      "http://localhost",
      sentinel,
    );
    assert(result.migrations > 0);
    assert.match(result.workspaceId, /^smoke_/);
  } finally {
    await mf.dispose();
  }
});
