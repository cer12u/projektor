// Bundle the trusted test composition before running the Miniflare probe.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { build } from "esbuild";

fs.mkdirSync(".tmp", { recursive: true });
await build({
  entryPoints: ["tools/perf-run.mjs"],
  outfile: ".tmp/perf-run.mjs",
  bundle: true,
  packages: "external",
  format: "esm",
  platform: "node",
});
execFileSync(process.execPath, [".tmp/perf-run.mjs"], { stdio: "inherit" });
