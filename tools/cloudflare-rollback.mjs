// Manual `rollback` job: restore the previous (or a given) version of the production
// Worker. Data is not touched; D1 migrations are additive and stay applied.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CF_PROD_WORKER, ROLLBACK_VERSION_ID } =
  process.env;
if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ACCOUNT_ID || !CF_PROD_WORKER) {
  console.error("Rollback requires CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and CF_PROD_WORKER");
  process.exit(78);
}
if (ROLLBACK_VERSION_ID && !/^[0-9a-f-]{36}$/.test(ROLLBACK_VERSION_ID)) {
  console.error("ROLLBACK_VERSION_ID must be a Worker version ID");
  process.exit(2);
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "projektor-rollback-"));
try {
  const args = ["rollback", ...(ROLLBACK_VERSION_ID ? [ROLLBACK_VERSION_ID] : [])];
  args.push(
    "--name",
    CF_PROD_WORKER,
    "--message",
    `GitLab rollback ${process.env.CI_PIPELINE_ID ?? ""}`,
    "-y",
  );
  execFileSync(path.resolve("node_modules/.bin/wrangler"), args, { cwd: temp, stdio: "inherit" });
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
