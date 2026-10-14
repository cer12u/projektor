import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { build } from "esbuild";
import { collect, hash, manifest, sqlCheck } from "./catalogs.mjs";
import { check } from "./check-boundaries.mjs";

const errors = check();
if (errors.length) throw new Error(JSON.stringify(errors));
const source = collect(process.cwd());
const schema = sqlCheck(process.cwd(), source);
const productionOwners = manifest(process.cwd()).owners.filter((o) => o.storage && !o.testOnly);
const productionCatalogs = Object.fromEntries(productionOwners.map((o) => [o.id, schema[o.id]]));
fs.rmSync("dist", { recursive: true, force: true });
fs.mkdirSync("dist/assets", { recursive: true });
const options = {
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  plugins: [
    {
      name: "production-catalogs",
      setup(plugin) {
        plugin.onResolve({ filter: /generated\/catalogs$/ }, () => ({
          path: "production-catalogs",
          namespace: "catalog",
        }));
        plugin.onLoad({ filter: /.*/, namespace: "catalog" }, () => ({
          contents: `export const catalogs = ${JSON.stringify(productionCatalogs)};`,
          loader: "js",
        }));
      },
    },
  ],
};
await build({ ...options, entryPoints: ["apps/worker/index.ts"], outfile: "dist/worker.js" });
await build({
  ...options,
  entryPoints: ["tools/smoke-worker.ts"],
  outfile: "dist/smoke-worker.js",
});
fs.copyFileSync("apps/web/index.html", "dist/assets/index.html");
fs.copyFileSync("LICENSE", "dist/LICENSE");
const migrations = Object.fromEntries(productionOwners.map((o) => [o.id, schema[o.id].migrations]));
fs.writeFileSync("dist/migrations.json", `${JSON.stringify(migrations, null, 2)}\n`);
const files = ["worker.js", "smoke-worker.js", "assets/index.html", "LICENSE", "migrations.json"];
const artifact = {
  commit:
    process.env.CI_COMMIT_SHA ??
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  deployable: false,
  catalogHash: hash(JSON.stringify(source)),
  files: Object.fromEntries(files.map((file) => [file, hash(fs.readFileSync(`dist/${file}`))])),
};
fs.writeFileSync("dist/artifact.json", `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`Built gateway ${artifact.commit}; deployment disabled`);
