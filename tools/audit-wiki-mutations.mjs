import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

// Focused behavioral probes. Run without concurrent source edits.
const factory = "modules/wiki/internal/factory.ts";
const queries = "modules/wiki/storage/queries.ts";
const cases = [
  [
    "page-tenant",
    queries,
    "FROM wiki_pages WHERE workspace_id=? AND id=?",
    "FROM wiki_pages WHERE ? IS NOT NULL AND id=?",
    "two workspaces, project predicates",
  ],
  [
    "slug-project",
    queries,
    "FROM wiki_pages WHERE workspace_id=? AND project_id=? AND slug=?",
    "FROM wiki_pages WHERE workspace_id=? AND ? IS NOT NULL AND slug=?",
    "two workspaces, project predicates",
  ],
  [
    "live-write",
    factory,
    'field(row, "project_id"), permission',
    'field(row, "project_id"), "read"',
    "two workspaces, project predicates",
  ],
  [
    "edit-cas",
    queries,
    "AND id=? AND version=? AND archived=0",
    "AND id=? AND ? IS NOT NULL AND archived=0",
    "stale CAS cannot mint",
  ],
  [
    "changed-guard",
    factory,
    "        ...calls,",
    '        ...calls.filter((call) => call.name !== "guard"),',
    "stale CAS cannot mint",
  ],
];
const chosen = process.argv[2] ? cases.filter(([id]) => id === process.argv[2]) : cases;
assert(chosen.length, "Unknown mutation case");
fs.mkdirSync("reports", { recursive: true });
fs.mkdirSync(".tmp", { recursive: true });
const lock = ".tmp/wiki-mutation.lock";
const fd = fs.openSync(lock, "wx");
const catalog = "platform/generated/catalogs.ts";
const run = (args) =>
  spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
const results = [];
try {
  for (const [id, path, before, after, pattern] of chosen) {
    const args = ["--test", `--test-name-pattern=${pattern}`, "tools/wiki.test.mjs"];
    const healthy = run(args);
    assert.equal(
      healthy.status,
      0,
      `Healthy regression failed: ${id}: ${healthy.stdout}${healthy.stderr}`,
    );
    assert.match(healthy.stdout, /# pass [1-9]/, "No regression executed");
    const original = fs.readFileSync(path, "utf8");
    const generated = fs.readFileSync(catalog, "utf8");
    assert(original.includes(before), `Mutation target drift: ${id}`);
    try {
      fs.writeFileSync(path, original.replace(before, after));
      if (path === queries) {
        const generation = run(["tools/generate.mjs"]);
        assert.equal(generation.status, 0, `Generation failed: ${generation.stderr}`);
      }
      const result = run(args);
      const output = result.stdout + result.stderr;
      fs.writeFileSync(`reports/wiki-mutation-${id}.log`, output);
      const status =
        result.status === 1 && /ERR_ASSERTION/.test(output) && /not ok/.test(output)
          ? "killed"
          : result.status === 0
            ? "survived"
            : "invalid";
      results.push({ id, status, regression: pattern });
      console.log(`${id}: ${status}`);
    } finally {
      fs.writeFileSync(path, original);
      fs.writeFileSync(catalog, generated);
    }
  }
} finally {
  fs.closeSync(fd);
  fs.unlinkSync(lock);
  fs.writeFileSync("reports/wiki-mutations.json", `${JSON.stringify(results, null, 2)}\n`);
}
if (results.some(({ status }) => status !== "killed")) process.exitCode = 1;
