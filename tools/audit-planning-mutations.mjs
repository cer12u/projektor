import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { stripVTControlCharacters } from "node:util";

// Run alone: node tools/audit-planning-mutations.mjs [case-id ...] [--original].
// Only assertion failures count. SQL is regenerated; all files restore in finally.
const factory = "modules/planning/internal/factory.ts";
const sql = "modules/planning/storage/queries.ts";
const cases = [];
const patch = (path, before, after) => ({ path, before, after });
function method(name, before, after) {
  const source = fs.readFileSync(factory, "utf8");
  const start = source.indexOf(`    async ${name}(`);
  const end = source.indexOf("\n    async ", start + 1);
  const block = source.slice(start, end < 0 ? source.length : end);
  assert(start >= 0 && block.includes(before), `Method drift: ${name}`);
  return patch(factory, block, block.replace(before, after));
}
function add(id, patches, pattern, file = "planning", originalPattern = undefined) {
  cases.push({ id, patches, pattern, file, originalPattern });
}
add(
  "cross-project",
  [patch(factory, "issue.projectId !== current.projectId || issue.archived", "issue.archived")],
  "10a scheduling",
);
add(
  "cross-workspace",
  [
    patch(
      factory,
      "const ws = (s: RequestScope) => id(s.workspaceId),",
      'const ws = (s: RequestScope) => id("w1"),',
    ),
  ],
  "10a scheduling",
);
add(
  "invisible-issue",
  [
    patch(
      factory,
      'const issue = await issues.authorizeIssue(s, iid, "read");',
      "const issue = {projectId: current.projectId, archived: false};",
    ),
  ],
  "10a scheduling",
);
add(
  "two-open-sprints",
  [
    patch(
      "modules/planning/storage/migrations/0001_planning.sql",
      "CREATE UNIQUE INDEX planning_open_issue ON planning_items(workspace_id,issue_id) WHERE active=1;",
      "CREATE INDEX planning_open_issue ON planning_items(workspace_id,issue_id) WHERE active=1;",
    ),
  ],
  "10a two open sprints",
);
for (const name of ["scheduleIssue", "unscheduleIssue"]) {
  const patches = [
    method(name, "current.closed || current.version !== expected", "current.version !== expected"),
    patch(sql, 'AND version=? AND closed=0",', 'AND version=? AND closed>=0",'),
  ];
  // The identical suffix appears in bump and close: narrow the exact bump query.
  patches[1] = patch(
    sql,
    'bump: "UPDATE planning_sprints SET version=version+1 WHERE workspace_id=? AND id=? AND version=? AND closed=0"',
    'bump: "UPDATE planning_sprints SET version=version+1 WHERE workspace_id=? AND id=? AND version=? AND closed>=0"',
  );
  if (name === "unscheduleIssue")
    patches.push(patch(sql, "AND issue_id=? AND active=1", "AND issue_id=? AND present=1"));
  add(`${name}-closed`, patches, "10a closed sprint");
}
add(
  "close-issues-write",
  [
    patch(
      factory,
      '"authorizeIssue" | "getIssueIncludingArchived">',
      '"authorizeIssue" | "getIssueIncludingArchived" | "transitionIssue">',
    ),
    method(
      "closeSprint",
      'return commit(s, op, fp, sid, expected + 1, "close", null, [',
      'await issues.transitionIssue(s, {operationId: op, issueId: "i1", expectedVersion: 1, state: "done"});\n      return commit(s, op, fp, sid, expected + 1, "close", null, [',
    ),
  ],
  "10a closed sprint",
);
for (const name of ["createSprint", "scheduleIssue", "unscheduleIssue", "closeSprint"])
  add(
    `${name}-fingerprint`,
    [
      patch(
        factory,
        'if (str(r, "fingerprint") !== fp) fail("conflict", "Operation ID reused");',
        "",
      ),
    ],
    `10a ${name} fingerprint`,
  );
add(
  "retry-duplicate-item",
  [
    method(
      "scheduleIssue",
      "if (saved) return saved;",
      'if (saved) { await store.batch([{name: "addItem", values: [ws(s), sid, iid + "0"]}]); return saved; }',
    ),
  ],
  "10a scheduleIssue fingerprint",
);
for (const name of ["scheduleIssue", "unscheduleIssue", "closeSprint"]) {
  const before =
    name === "closeSprint"
      ? "SET version=version+1,closed=1 WHERE workspace_id=? AND id=? AND version=?"
      : "SET version=version+1 WHERE workspace_id=? AND id=? AND version=?";
  add(
    `${name}-cas`,
    [patch(sql, before, before.replace("version=?", "?>0"))],
    `10a ${name} storage CAS`,
  );
}
add(
  "projects-historical-grant",
  [
    patch(
      "modules/projects/internal/factory.ts",
      "if (!grant || grant.active !== 1) missing();\n      projectRole = role(grant.role);",
      'if (!allowArchived && (!grant || grant.active !== 1)) missing();\n      projectRole = grant ? role(grant.role) : "viewer";',
    ),
  ],
  "10a getProjectIncludingArchived",
  "projects",
);
add(
  "issues-historical-grant",
  [
    patch(
      "modules/issues/internal/factory.ts",
      'await projects.getProjectIncludingArchived(scope, string(row, "project_id"))',
      '{ key: "ONE" }',
    ),
  ],
  "10a getIssueIncludingArchived",
  "issues",
);
const issueFactory = "modules/issues/internal/factory.ts",
  issueSQL = "modules/issues/storage/queries.ts";
const issueSource = fs.readFileSync(issueFactory, "utf8");
const editBlock = issueSource.slice(
  issueSource.indexOf("    async editIssue("),
  issueSource.indexOf("    async transitionIssue("),
);
add(
  "archived-issue-write",
  [
    patch(
      issueFactory,
      editBlock,
      editBlock.replace('if (current.archived) fail("not_found", "Issue not found");', ""),
    ),
    patch(
      issueSQL,
      'edit: "UPDATE issues_issues SET title=?,description=?,priority=?,version=version+1 WHERE workspace_id=? AND id=? AND version=? AND archived=0"',
      'edit: "UPDATE issues_issues SET title=?,description=?,priority=?,version=version+1 WHERE workspace_id=? AND id=? AND version=?"',
    ),
  ],
  "10a getIssueIncludingArchived",
  "issues",
);
add(
  "stale-item-state",
  [
    patch(
      factory,
      "return { issueId, issue, archived: issue.archived || current.archived };",
      'return { issueId, issue: {...issue, state: "todo" as const}, archived: issue.archived || current.archived };',
    ),
  ],
  "10a item reads",
);
add(
  "double-item-read",
  [
    patch(
      factory,
      "const issue = await issues.getIssueIncludingArchived(s, issueId);",
      "await issues.getIssueIncludingArchived(s, issueId); const issue = await issues.getIssueIncludingArchived(s, issueId);",
    ),
  ],
  "10a item reads",
);
add(
  "unbounded-items",
  [
    patch(
      sql,
      "AND issue_id>? ORDER BY issue_id LIMIT ?",
      "AND issue_id>? ORDER BY issue_id LIMIT MAX(?,10000)",
    ),
    patch(factory, "rows.slice(0, limit).map", "rows.map"),
  ],
  "10a item reads",
);
add(
  "page-size-validation",
  [method("getSprintItems", "limit > 100", "limit > 10000")],
  "10a item reads",
);
const schedulePermission = method(
  "scheduleIssue",
  'await access.authorize(s, "write");',
  'await access.authorize(s, "read");',
);
schedulePermission.after = schedulePermission.after.replace(
  'await readSprint(s, sid, "write")',
  'await readSprint(s, sid, "read")',
);
const permissions = [
  schedulePermission,
  patch(
    "gateway/public.ts",
    "return services.access.requireMembership(actor, workspace(request, w), requestId, mode);",
    'return services.access.requireMembership(actor, workspace(request, w), requestId, "read");',
  ),
];
add("transport-viewer", permissions, "10a Planning REST and MCP", "gateway");
add("oauth-write-scope", permissions, "10a OAuth viewer", "gateway-oauth");
add(
  "gateway-events",
  [
    patch(
      "gateway/catalog.ts",
      "export const catalog: Readonly<Record<string, Operation>> = Object.freeze({",
      'export const catalog: Readonly<Record<string, Operation>> = Object.freeze({\n  "planning.readEvents": op({workspaceId: "string", cursor: "number", limit: "number"}, false, (s, c, a) => s.planning.readEvents({} as never, str(a, "workspaceId"), num(a, "cursor"), num(a, "limit"))),',
    ),
  ],
  "10a Planning REST and MCP",
  "gateway",
);
add(
  "gateway-page-args",
  [
    patch(
      "gateway/catalog.ts",
      '{\n        cursor: optStr(a, "cursor"),\n        limit: optNum(a, "limit"),\n      }',
      "{}",
    ),
  ],
  "10a Planning page",
  "gateway",
);

add(
  "web-next-page",
  [patch("apps/web/src/app.tsx", 'setCursor(detail.data?.nextCursor ?? "")', 'setCursor("")')],
  "10a sprint paging",
  "browser",
);
add(
  "web-closed-controls",
  [
    patch(
      "apps/web/src/app.tsx",
      "current && !current.closed && !current.archived && (",
      "current && !current.archived && (",
    ),
  ],
  "sprint view schedules",
  "browser",
);

if (process.argv.includes("--check")) {
  for (const c of cases) {
    const texts = new Map();
    for (const p of c.patches) {
      const text = texts.get(p.path) ?? fs.readFileSync(p.path, "utf8");
      assert.equal(text.split(p.before).length, 2, `Target drift: ${c.id}`);
      texts.set(p.path, text.replace(p.before, p.after));
    }
  }
  console.log(`${cases.length} mutation targets validated`);
  process.exit(0);
}
const original = process.argv.includes("--original");
const ids = process.argv.slice(2).filter((x) => x !== "--original");
const selected = cases.filter((c) => !ids.length || ids.includes(c.id));
assert(selected.length && ids.every((id) => cases.some((c) => c.id === id)), "Unknown case");
fs.mkdirSync(".tmp", { recursive: true });
fs.mkdirSync("reports", { recursive: true });
const lock = ".tmp/planning-mutation.lock",
  fd = fs.openSync(lock, "wx");
const reportPath = `reports/planning-${original ? "original-" : ""}mutations.json`;
const previous = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : [];
const results = [],
  healthyCommands = new Set();
const run = (bin, args) =>
  spawnSync(bin, args, { encoding: "utf8", timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
try {
  for (const c of selected) {
    const testFile =
      c.file === "browser" ? "tools/web-e2e/planning.spec.mjs" : `tools/${c.file}.test.mjs`;
    assert(!original || c.file !== "browser", "Original browser probe is unsupported");
    const files = [
      ...new Set([testFile, "platform/generated/catalogs.ts", ...c.patches.map((p) => p.path)]),
    ];
    const saved = new Map(files.map((p) => [p, fs.readFileSync(p, "utf8")]));
    try {
      if (original) {
        const old = run("git", ["show", `a41efc2:${testFile}`]);
        assert.equal(old.status, 0);
        fs.writeFileSync(testFile, old.stdout);
      }
      const args = [
        "--test",
        "--test-reporter=tap",
        ...(original && c.file === "planning"
          ? []
          : [`--test-name-pattern=${original ? (c.originalPattern ?? "Planning") : c.pattern}`]),
        testFile,
      ];
      const command =
        c.file === "browser"
          ? [
              "pnpm",
              [
                "exec",
                "playwright",
                "test",
                "-c",
                "tools/playwright.config.mjs",
                "--grep",
                c.pattern,
              ],
            ]
          : [process.execPath, args];
      const commandKey = JSON.stringify(command);
      if (!healthyCommands.has(commandKey)) {
        const healthy = run(...command);
        fs.writeFileSync(`reports/10a-${c.id}-healthy.log`, healthy.stdout + healthy.stderr);
        assert.equal(healthy.status, 0, `Healthy regression failed: ${c.id}; see reports`);
        assert.match(healthy.stdout, /# pass [1-9]|[1-9]\d* passed/);
        healthyCommands.add(commandKey);
      }
      for (const p of c.patches) {
        const text = fs.readFileSync(p.path, "utf8");
        assert.equal(text.split(p.before).length, 2, `Target drift: ${c.id}`);
        fs.writeFileSync(p.path, text.replace(p.before, p.after));
      }
      if (c.patches.some((p) => p.path.endsWith("queries.ts") || p.path.endsWith(".sql"))) {
        const generation = run(process.execPath, ["tools/generate.mjs"]);
        assert.equal(generation.status, 0, `Generation failed: ${c.id}`);
      }
      const result = run(...command),
        output = stripVTControlCharacters(result.stdout + result.stderr);
      fs.writeFileSync(`reports/10a-${original ? "original-" : ""}${c.id}.log`, output);
      const status =
        result.status === 0
          ? "survived"
          : result.status === 1 &&
              /ERR_ASSERTION|Error: expect\(/.test(output) &&
              /not ok|failed/.test(output)
            ? "killed"
            : "invalid";
      results.push({ id: c.id, status, regression: original ? c.originalPattern : c.pattern });
      console.log(`${c.id}: ${status}`);
    } finally {
      for (const [p, text] of saved) fs.writeFileSync(p, text);
    }
  }
} finally {
  fs.closeSync(fd);
  fs.unlinkSync(lock);
  fs.writeFileSync(
    reportPath,
    `${JSON.stringify([...previous.filter((r) => !selected.some((c) => c.id === r.id)), ...results], null, 2)}\n`,
  );
}
if (results.some((r) => r.status !== "killed")) process.exitCode = 1;
