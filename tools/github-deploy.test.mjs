import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

function rejected(settings, message) {
  const env = { ...process.env };
  for (const key of ["CF_DEPLOY_CONFIG", "CF_PRODUCTION_READY", "CF_PRESERVED_D1_IDS"])
    delete env[key];
  const result = spawnSync(process.execPath, ["tools/github-deploy.mjs", "--check"], {
    env: { ...env, ...settings },
    encoding: "utf8",
  });
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
