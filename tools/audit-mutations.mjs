import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

// Run manually, without other writers: node tools/audit-mutations.mjs [case-id].
// Focused behavioral failures count; generation/build failures do not.
const factory = "modules/issues/internal/factory.ts";
const queries = "modules/issues/storage/queries.ts";
const cases = [
  [
    "issue-tenant",
    queries,
    "FROM issues_issues WHERE workspace_id=? AND id=?",
    "FROM issues_issues WHERE ? IS NOT NULL AND id=?",
    "distinct tenant data",
  ],
  [
    "write-admission",
    factory,
    'string(row, "project_id"), permission',
    'string(row, "project_id"), "read"',
    "every write rejects",
  ],
  [
    "stale-cas",
    queries,
    "WHERE workspace_id=? AND id=? AND version=? AND archived=0",
    "WHERE workspace_id=? AND id=? AND ? IS NOT NULL AND archived=0",
    "editIssue: stale CAS",
  ],
  [
    "fingerprint",
    factory,
    "if (row.fingerprint !== fingerprint)",
    "if (false)",
    "concurrent counter allocation",
  ],
  [
    "event-tenant",
    queries,
    "FROM issues_events WHERE workspace_id=? AND sequence>?",
    "FROM issues_events WHERE ? IS NOT NULL AND sequence>?",
    "distinct tenant data",
  ],
  [
    "history-tenant",
    queries,
    "FROM issues_history WHERE workspace_id=? AND issue_id=?",
    "FROM issues_history WHERE ? IS NOT NULL AND issue_id=?",
    "distinct tenant data",
  ],
  [
    "number-project",
    queries,
    "FROM issues_issues WHERE workspace_id=? AND project_id=? AND number=?",
    "FROM issues_issues WHERE workspace_id=? AND ? IS NOT NULL AND number=?",
    "distinct tenant data",
  ],
  [
    "create-admission",
    factory,
    'await projects.authorizeProject(scope, projectId, "write");',
    'await projects.authorizeProject(scope, projectId, "read");',
    "every write rejects",
  ],
  [
    "batch-guard",
    factory,
    "        ...calls,",
    '        ...calls.filter((call) => call.name !== "guard"),',
    "editIssue: stale CAS",
  ],
];
const selected = process.argv[2] ? cases.filter(([id]) => id === process.argv[2]) : cases;
assert(selected.length, "Unknown mutation case");
fs.mkdirSync("reports", { recursive: true });
fs.mkdirSync(".tmp", { recursive: true });
const lock = ".tmp/issues-mutation.lock";
const fd = fs.openSync(lock, "wx");
const generated = "platform/generated/catalogs.ts";
const run = (args) =>
  spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
const results = [];
try {
  for (const [id, path, before, after, pattern] of selected) {
    const args = ["--test", `--test-name-pattern=${pattern}`, "tools/issues.test.mjs"];
    const healthy = run(args);
    assert.equal(
      healthy.status,
      0,
      `Unmutated regression fails for ${id}: ${healthy.stdout}${healthy.stderr}`,
    );
    assert.match(healthy.stdout, /# pass [1-9]/, "No regression executed");
    const original = fs.readFileSync(path, "utf8");
    const catalog = fs.readFileSync(generated, "utf8");
    assert(original.includes(before), `Mutation target drift: ${id}`);
    try {
      fs.writeFileSync(path, original.replace(before, after));
      if (path === queries) {
        const generation = run(["tools/generate.mjs"]);
        assert.equal(generation.status, 0, `Generation failed: ${generation.stderr}`);
      }
      const result = run(args);
      const output = result.stdout + result.stderr;
      fs.writeFileSync(`reports/mutation-${id}.log`, output);
      const killed = result.status === 1 && /ERR_ASSERTION/.test(output) && /not ok/.test(output);
      const status = result.status === 0 ? "survived" : killed ? "killed" : "invalid";
      results.push({ id, status, regression: pattern });
      console.log(`${id}: ${status} (${pattern})`);
    } finally {
      fs.writeFileSync(path, original);
      fs.writeFileSync(generated, catalog);
    }
  }
} finally {
  fs.closeSync(fd);
  fs.unlinkSync(lock);
  fs.writeFileSync("reports/issues-mutations.json", `${JSON.stringify(results, null, 2)}\n`);
}
if (results.some(({ status }) => status !== "killed")) process.exitCode = 1;
