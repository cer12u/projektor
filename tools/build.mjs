import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { build } from "esbuild";
import { collect, hash, manifest, sqlCheck } from "./catalogs.mjs";
import { check } from "./check-boundaries.mjs";

const errors = check();
if (errors.length) throw new Error(JSON.stringify(errors));
fs.rmSync("dist", { recursive: true, force: true });
fs.mkdirSync("dist/assets", { recursive: true });
await build({
  entryPoints: ["apps/worker/index.ts"],
  outfile: "dist/worker.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
});
fs.copyFileSync("apps/web/index.html", "dist/assets/index.html");
fs.copyFileSync("LICENSE", "dist/LICENSE");
const schema = sqlCheck(process.cwd(), collect(process.cwd()));
const productionOwners = manifest(process.cwd()).owners.filter((o) => o.storage && !o.testOnly);
const migrations = Object.fromEntries(productionOwners.map((o) => [o.id, schema[o.id].migrations]));
fs.writeFileSync("dist/migrations.json", `${JSON.stringify(migrations, null, 2)}\n`);
const files = ["worker.js", "assets/index.html", "LICENSE", "migrations.json"];
const artifact = {
  commit:
    process.env.CI_COMMIT_SHA ??
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  deployable: false,
  catalogHash: hash(JSON.stringify(collect(process.cwd()))),
  files: Object.fromEntries(files.map((file) => [file, hash(fs.readFileSync(`dist/${file}`))])),
};
fs.writeFileSync("dist/artifact.json", `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`Built scaffold ${artifact.commit}; deployment disabled`);
