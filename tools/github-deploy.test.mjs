import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

function rejected(settings, message, cwd) {
  const env = { ...process.env };
  for (const key of ["CF_DEPLOY_CONFIG", "CF_PRODUCTION_READY", "CF_PRESERVED_D1_IDS"])
    delete env[key];
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./github-deploy.mjs", import.meta.url)), "--check"],
    {
      env: { ...env, CF_APPROVED_SCHEMA_SHA256: "0".repeat(64), ...settings },
      encoding: "utf8",
      cwd,
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, message);
}

test("unapproved initial setup stops before accessing Cloudflare", () => {
  rejected(
    { CF_DEPLOY_CONFIG: "{}", CF_PRODUCTION_READY: "false", CF_PRESERVED_D1_IDS: "saved" },
    /Initial setup must be approved/,
  );
});

test("a preserved database cannot be used for automatic deployment", () => {
  const d1Id = "00000000-0000-0000-0000-000000000001";
  rejected(
    {
      CF_PRODUCTION_READY: "true",
      CF_PRESERVED_D1_IDS: d1Id,
      CF_DEPLOY_CONFIG: JSON.stringify({
        worker: "projektor",
        oauthEnabled: false,
        integrationsEnabled: false,
        d1Id,
        d1Name: "new-db",
        kvId: "placeholder",
        r2Name: "new-bucket",
        origin: "https://example.org/",
        accessTeamDomain: "placeholder",
        accessAudience: "placeholder",
        rateIds: ["1", "2", "3"],
      }),
    },
    /Preserved D1 cannot be deployed against/,
  );
});

function configurationFixture(routes) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-refusal-"));
  fs.mkdirSync(path.join(cwd, "dist"));
  fs.writeFileSync(
    path.join(cwd, "dist/artifact.json"),
    JSON.stringify({ commit: "test-commit", files: {} }),
  );
  fs.writeFileSync(path.join(cwd, "dist/migrations.json"), "{}\n");
  fs.writeFileSync(
    path.join(cwd, "wrangler.jsonc"),
    JSON.stringify({
      name: "projektor",
      assets: {},
      ratelimits: [],
      ...(routes ? { routes: ["example.org/*"] } : {}),
    }),
  );
  return {
    cwd,
    settings: {
      CF_PRODUCTION_READY: "true",
      CF_PRESERVED_D1_IDS: "saved",
      WORKERS_CI_COMMIT_SHA: "test-commit",
      CF_DEPLOY_CONFIG: JSON.stringify({
        worker: "projektor",
        d1Id: "00000000-0000-0000-0000-000000000001",
        d1Name: "new-db",
        kvId: "0".repeat(32),
        r2Name: "new-bucket",
        origin: "https://example.org/",
        accessTeamDomain: "https://unit.cloudflareaccess.com",
        accessAudience: "0".repeat(64),
        rateIds: ["1", "2", "3"],
        oauthEnabled: false,
        integrationsEnabled: false,
      }),
    },
  };
}

test("a schema-changing build stops before any Cloudflare operation", () => {
  const f = configurationFixture(false);
  try {
    rejected(f.settings, /Schema changed/, f.cwd);
  } finally {
    fs.rmSync(f.cwd, { recursive: true, force: true });
  }
});

test("optional default workspace settings reject an invalid slug", () => {
  const f = configurationFixture(false);
  try {
    const config = JSON.parse(f.settings.CF_DEPLOY_CONFIG);
    config.adminEmails = ["owner@example.test"];
    config.defaultWorkspaceSlug = "bad/slug";
    config.defaultWorkspaceName = "Example";
    rejected(
      { ...f.settings, CF_DEPLOY_CONFIG: JSON.stringify(config) },
      /defaultWorkspaceSlug/,
      f.cwd,
    );
  } finally {
    fs.rmSync(f.cwd, { recursive: true, force: true });
  }
});

test("placement accepts only smart", () => {
  const f = configurationFixture(false);
  try {
    const config = JSON.parse(f.settings.CF_DEPLOY_CONFIG);
    config.placement = "nearest";
    rejected(
      { ...f.settings, CF_DEPLOY_CONFIG: JSON.stringify(config) },
      /Invalid placement/,
      f.cwd,
    );
  } finally {
    fs.rmSync(f.cwd, { recursive: true, force: true });
  }
});

test("production preflight emits Smart Placement only when requested", () => {
  const f = configurationFixture(false);
  try {
    fs.mkdirSync(path.join(f.cwd, "node_modules/.bin"), { recursive: true });
    fs.writeFileSync(
      path.join(f.cwd, "node_modules/.bin/wrangler"),
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'secret') { process.stdout.write('[]'); process.exit(0); }
fs.writeFileSync(process.env.CAPTURE_FILE, fs.readFileSync(args[args.indexOf('--config') + 1]));
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(f.cwd, "fetch-stub.mjs"),
      "globalThis.fetch = async () => new Response('{}', {status: 403});\n",
    );
    const config = JSON.parse(f.settings.CF_DEPLOY_CONFIG);
    for (const placement of [undefined, "smart"]) {
      const capture = path.join(f.cwd, "captured.json");
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "./fetch-stub.mjs",
          fileURLToPath(new URL("./github-deploy.mjs", import.meta.url)),
          "--check",
        ],
        {
          cwd: f.cwd,
          encoding: "utf8",
          env: {
            ...process.env,
            ...f.settings,
            CF_APPROVED_SCHEMA_SHA256: createHash("sha256").update("{}\n").digest("hex"),
            CF_DEPLOY_CONFIG: JSON.stringify({ ...config, ...(placement ? { placement } : {}) }),
            CAPTURE_FILE: capture,
          },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      const emitted = JSON.parse(fs.readFileSync(capture, "utf8"));
      assert.deepEqual(emitted.placement, placement ? { mode: "smart" } : undefined);
    }
  } finally {
    fs.rmSync(f.cwd, { recursive: true, force: true });
  }
});

test("route management cannot enter the Worker-only deployment", () => {
  const f = configurationFixture(true);
  try {
    rejected(f.settings, /must not manage routes/, f.cwd);
  } finally {
    fs.rmSync(f.cwd, { recursive: true, force: true });
  }
});
