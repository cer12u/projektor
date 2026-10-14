import { spawnSync } from "node:child_process";
import fs from "node:fs";

fs.mkdirSync("reports", { recursive: true });
const args = [
  "--test",
  "--test-reporter=spec",
  "--test-reporter-destination=stdout",
  "--test-reporter=junit",
  "--test-reporter-destination=reports/platform.xml",
];
if (process.argv.includes("--coverage"))
  args.push(
    "--experimental-test-coverage",
    "--test-reporter=lcov",
    "--test-reporter-destination=reports/platform.lcov",
  );
args.push(
  "--test-concurrency=1",
  "tools/runtime.test.mjs",
  "tools/access.test.mjs",
  "tools/projects.test.mjs",
  "tools/issues.test.mjs",
  "tools/wiki.test.mjs",
  "tools/coordination.test.mjs",
  "tools/assets.test.mjs",
  "tools/planning.test.mjs",
  "tools/insights.test.mjs",
  "tools/insights-scheduled.test.mjs",
  "tools/integrations.test.mjs",
  "tools/maintenance-core.test.mjs",
  "tools/maintenance-derived.test.mjs",
  "tools/lifecycle.test.mjs",
  "tools/lifecycle-scheduled.test.mjs",
  "tools/maintenance-assets.test.mjs",
);
const result = spawnSync(process.execPath, args, { stdio: "inherit" });
process.exitCode = result.status ?? 1;
