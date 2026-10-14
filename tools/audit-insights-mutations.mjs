import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { stripVTControlCharacters } from "node:util";

// Run alone. Each probe restores source/catalogs, requires a green baseline,
// and counts only behavioral assertion failures as killed.
const factory = "modules/insights/internal/factory.ts";
const sql = "modules/insights/storage/queries.ts";
const cases = [];
const patch = (path, before, after) => ({ path, before, after });
const add = (id, patches, pattern, file = "insights") => cases.push({ id, patches, pattern, file });
const f = (before, after) => patch(factory, before, after);
add(
  "duplicate-projection",
  [
    f(
      "const g = ids.next();\n      calls.push(",
      `for (const call of [...calls]) if (call.name === "activity") calls.push({name: "activity", values: [call.values[0], call.values[1], Number(call.values[2]) + 1000000, String(call.values[3]) + "_duplicate", ...call.values.slice(4)]});
      const g = ids.next();
      calls.push(`,
    ),
  ],
  "duplicate delivery",
);
add(
  "cursor-without-projection",
  [f("await store.batch(calls);", 'await store.batch(calls.filter(c => c.name !== "activity"));')],
  "11a atomic projection",
);
add(
  "projection-without-cursor",
  [
    f(
      "await store.batch(calls);",
      'await store.batch(calls.filter(c => c.name !== "advanceCursor"));',
    ),
  ],
  "11a atomic projection",
);
add(
  "split-batch-crash",
  [f("await store.batch(calls);", "for (const call of calls) await store.batch([call]);")],
  "11a atomic projection",
);
// Keep sequence checks; silently discard unknown schemas while acknowledging their cursor.
add(
  "skip-unknown-schema",
  [f('fail("unknown", "Producer event sequence gap");', "{ last = event.cursor; continue; }")],
  "11a lag advances",
);
add(
  "stale-lag-time",
  [f("values: [last, clock.now(), ws, source, before]", "values: [last, 0, ws, source, before]")],
  "11a lag advances",
);
add(
  "feed-no-authorization",
  [
    f(
      "const found = await locate(s, source, entityId);",
      'const found = {projectId: "p1", title: "unverified"};',
    ),
  ],
  "11a authorization precedes",
);
add(
  "filter-before-authorization",
  [
    f(
      "const found = await locate(s, source, entityId);",
      'const found = projectId ? {projectId, title: "unverified"} : await locate(s, source, entityId);',
    ),
  ],
  "11a authorization precedes",
);
add(
  "notification-body",
  [
    f(
      'kind: str(row, "kind") as Notification["kind"],',
      'kind: str(row, "kind") as Notification["kind"],\n            body: (await issues.getHistory(s, str(row, "issue_id"))).map(h => h.detail).join(""),',
    ),
  ],
  "11a notifications contain",
);
add(
  "notification-invisible-target",
  [
    f(
      'await issues.authorizeIssue(s, str(row, "issue_id"));\n          } catch',
      "/* authorization removed */\n          } catch",
    ),
  ],
  "11a notifications contain",
);
add(
  "notification-invisible-recipient",
  [
    f("if (!(await locate(s, source, issueId))) continue;", "if (false) continue;"),
    f(
      "const history = (await issues.getHistory(s, issueId)).find(",
      'const history = [{version: 1, action: "comment", detail: "{}"}].find(',
    ),
  ],
  "11a notifications contain",
);
for (const [name, pattern] of [
  ["subscribe", "11a subscribe fingerprint"],
  ["markRead", "11a markRead fingerprint"],
]) {
  add(
    `${name}-changed-retry`,
    [f('if (str(r, "fingerprint") !== fp) fail("conflict", "Operation ID reused");', "")],
    pattern,
  );
}
add(
  "subscribe-storage-cas",
  [patch(sql, "issue_id=? AND version=? AND active=?", "issue_id=? AND ?>=0 AND active=?")],
  "11a subscribe fingerprint",
);
add(
  "markRead-storage-cas",
  [patch(sql, "id=? AND version=? AND read=0", "id=? AND ?>=0 AND read=0")],
  "11a markRead fingerprint",
);
add(
  "markRead-retry-revoked",
  [
    f(
      'await issues.authorizeIssue(s, str(row, "issue_id"));\n      if (saved)',
      'if (!saved) await issues.authorizeIssue(s, str(row, "issue_id"));\n      if (saved)',
    ),
  ],
  "11a markRead fingerprint",
);
add(
  "metrics-ignore-client",
  [f('const key = `${h.actorId}:${h.clientId ?? ""}`;', "const key = h.actorId;")],
  "11a metrics group",
);
add(
  "metrics-ignore-window",
  [f("h.occurredAt >= clock.now() - days * 86400", "true")],
  "11a metrics group",
);
add("metrics-future", [f(" && h.occurredAt <= clock.now()", "")], "11a metrics group");
add(
  "gateway-consumer-capability",
  [f("const api: InsightsApi = {", "const api: InsightsApi = {\n    consumeEvents: consume,")],
  "11a Gateway API",
);
const catalog = "gateway/catalog.ts";
add(
  "gateway-rest-mcp-consumer",
  [
    patch(
      catalog,
      "export const catalog: Readonly<Record<string, Operation>> = Object.freeze({",
      'export const catalog: Readonly<Record<string, Operation>> = Object.freeze({\n  "insights.consumeEvents": op({workspaceId: "string", limit: "number"}, false, async () => 0),',
    ),
  ],
  "11a background consumption",
  "gateway",
);
add(
  "scheduled-first-page-only",
  [patch("apps/worker/index.ts", "} while (cursor);", "} while (false);")],
  "11a Worker scheduled",
  "insights-scheduled",
);
add(
  "scheduled-missing",
  [
    patch(
      "apps/worker/index.ts",
      "await consumeActiveWorkspaces(services.background.access, services.background.insights);",
      "",
    ),
  ],
  "11a Worker scheduled",
  "insights-scheduled",
);
add(
  "discovery-includes-archived",
  [
    patch(
      "modules/access/storage/queries.ts",
      "WHERE archived=0 AND workspace_id>?",
      "WHERE archived>=0 AND workspace_id>?",
    ),
  ],
  "11a background discovery",
  "access",
);

add(
  "web-client-attribution",
  [patch("apps/web/src/app.tsx", '{item.clientId ? ` · ${item.clientId} 経由` : ""}', '{""}')],
  "11a feed shows",
  "browser",
);

add(
  "legacy-forced-claim",
  [
    f(
      'if (source === "coordination" && !/^[A-Za-z0-9_-]{1,128}$/.test(entityId)) return null;',
      "",
    ),
  ],
  "11a attribution",
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
const ids = process.argv.slice(2);
const selected = cases.filter((c) => !ids.length || ids.includes(c.id));
assert(selected.length && ids.every((id) => cases.some((c) => c.id === id)), "Unknown case");
fs.mkdirSync("reports", { recursive: true });
fs.mkdirSync(".tmp", { recursive: true });
const lock = ".tmp/insights-mutations.lock",
  fd = fs.openSync(lock, "wx");
const run = (args) =>
  spawnSync(process.execPath, args, {
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 8 * 1024 * 1024,
  });
const results = [],
  healthy = new Set();
const report = "reports/insights-mutations.json";
const previous = fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, "utf8")) : [];
try {
  for (const c of selected) {
    const args = [
      "--test",
      "--test-reporter=tap",
      `--test-name-pattern=${c.pattern}`,
      `tools/${c.file}.test.mjs`,
    ];
    const testRun =
      c.file === "browser"
        ? () =>
            spawnSync(
              "pnpm",
              [
                "exec",
                "playwright",
                "test",
                "-c",
                "tools/playwright.config.mjs",
                "tools/web-e2e/insights.spec.mjs",
                "--grep",
                c.pattern,
              ],
              { encoding: "utf8", timeout: 180000, maxBuffer: 8 * 1024 * 1024 },
            )
        : () => run(args);
    const saved = new Map(
      [...new Set(["platform/generated/catalogs.ts", ...c.patches.map((p) => p.path)])].map((p) => [
        p,
        fs.readFileSync(p, "utf8"),
      ]),
    );
    try {
      if (!healthy.has(JSON.stringify(args))) {
        const base = testRun();
        fs.writeFileSync(`reports/11a-${c.id}-healthy.log`, base.stdout + base.stderr);
        assert.equal(base.status, 0, `Baseline failed: ${c.id}`);
        assert.match(base.stdout, /# pass [1-9]|[1-9]\d* passed/);
        healthy.add(JSON.stringify(args));
      }
      for (const p of c.patches) {
        const text = fs.readFileSync(p.path, "utf8");
        assert.equal(text.split(p.before).length, 2, `Target drift: ${c.id}`);
        fs.writeFileSync(p.path, text.replace(p.before, p.after));
      }
      if (c.patches.some((p) => p.path.endsWith("queries.ts"))) {
        const gen = run(["tools/generate.mjs"]);
        assert.equal(gen.status, 0, `Generation failed: ${c.id}`);
      }
      const result = testRun(),
        output = stripVTControlCharacters(result.stdout + result.stderr);
      fs.writeFileSync(`reports/11a-${c.id}.log`, output);
      const status =
        result.status === 0
          ? "survived"
          : result.status === 1 &&
              /ERR_ASSERTION|Error: expect\(/.test(output) &&
              /not ok|failed/.test(output)
            ? "killed"
            : "invalid";
      results.push({ id: c.id, status, regression: c.pattern });
      console.log(`${c.id}: ${status}`);
    } finally {
      for (const [p, text] of saved) fs.writeFileSync(p, text);
    }
  }
} finally {
  fs.closeSync(fd);
  fs.unlinkSync(lock);
  fs.writeFileSync(
    report,
    JSON.stringify(
      [...previous.filter((p) => !results.some((r) => r.id === p.id)), ...results],
      null,
      2,
    ) + "\n",
  );
}
if (results.some((r) => r.status !== "killed")) process.exitCode = 1;
