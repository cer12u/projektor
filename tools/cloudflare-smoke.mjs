import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !account) {
  console.error(
    "Cloudflare smoke requires protected CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (exit 78)",
  );
  process.exit(78);
}
const artifact = JSON.parse(fs.readFileSync("dist/artifact.json", "utf8"));
assert.equal(artifact.commit, process.env.CI_COMMIT_SHA, "build artifact commit mismatch");
for (const [file, expected] of Object.entries(artifact.files)) {
  const actual = createHash("sha256")
    .update(fs.readFileSync(path.join("dist", file)))
    .digest("hex");
  assert.equal(actual, expected, `build artifact checksum mismatch: ${file}`);
}
assert(Object.hasOwn(artifact.files, "smoke-worker.js"));

const wrangler = path.resolve("node_modules/.bin/wrangler");
const run = (...args) =>
  execFileSync(wrangler, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const d1Name = "projektor-verify";
const kvName = "projektor-verify";
const bucketName = "projektor-verify";
function resources() {
  const databases = JSON.parse(run("d1", "list", "--json"));
  const namespaces = JSON.parse(run("kv", "namespace", "list"));
  const buckets = run("r2", "bucket", "list");
  return {
    d1: databases.find((item) => item.name === d1Name)?.uuid,
    kv: namespaces.find((item) => item.title === kvName)?.id,
    r2: new RegExp(`(?<![a-z0-9-])${bucketName}(?![a-z0-9-])`, "i").test(buckets),
  };
}
let found = resources();
if (!found.d1) run("d1", "create", d1Name);
if (!found.kv) run("kv", "namespace", "create", kvName);
if (!found.r2) run("r2", "bucket", "create", bucketName);
found = resources();
if (!found.d1 || !found.kv || !found.r2)
  throw new Error("Verification resources were not found after provisioning");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "projektor-verify-"));
const secret = randomBytes(32).toString("hex");
const configFile = path.join(temp, "wrangler.json");
const secretsFile = path.join(temp, "secrets.json");
fs.writeFileSync(
  configFile,
  JSON.stringify({
    name: "projektor-verify",
    main: path.resolve("dist/smoke-worker.js"),
    compatibility_date: "2026-07-30",
    workers_dev: true,
    vars: {
      SMOKE_ENABLED: "1",
      ACCESS_TEAM_DOMAIN: "https://verify.cloudflareaccess.com",
      ACCESS_AUDIENCE: "projektor-verify",
    },
    d1_databases: [{ binding: "DB", database_name: d1Name, database_id: found.d1 }],
    kv_namespaces: [{ binding: "KV", id: found.kv }],
    r2_buckets: [{ binding: "R2", bucket_name: bucketName }],
  }),
);
fs.writeFileSync(secretsFile, JSON.stringify({ SMOKE_SECRET: secret }), { mode: 0o600 });
try {
  const output = run(
    "deploy",
    "--config",
    configFile,
    "--no-bundle",
    "--secrets-file",
    secretsFile,
  );
  const match = output.match(/https:\/\/projektor-verify\.[a-z0-9-]+\.workers\.dev/);
  if (!match) throw new Error("Wrangler did not return the verification workers.dev URL");
  console.log(`Verification Worker deployed: ${match[0]}`);
  const result = execFileSync(process.execPath, ["tools/smoke-check.mjs", "remote"], {
    encoding: "utf8",
    env: { ...process.env, SMOKE_ORIGIN: match[0], SMOKE_SECRET: secret },
  });
  process.stdout.write(result);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
