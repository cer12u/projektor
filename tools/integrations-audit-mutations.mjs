import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

// Manual, serial campaign. Run only with no other tests/source writers.
// Every probe needs a passing baseline and an actual behavioral assertion failure.
const factory = "modules/integrations/internal/factory.ts";
const queries = "modules/integrations/storage/queries.ts";
const adapter = "platform/adapters.ts";
const catalog = "gateway/catalog.ts";
const probe = (id, pattern, path, before, after, suite = "tools/integrations.test.mjs") => ({
  id,
  pattern,
  edits: [[path, before, after]],
  suite,
});
const cases = [
  probe("hmac", "feedback verifies", factory, "!equal(expected, input.signature)", "false"),
  probe(
    "raw-body",
    "12a signatures",
    factory,
    "${input.timestamp}.${deliveryId}.${input.rawBody}",
    "${input.timestamp}.${deliveryId}.${JSON.stringify(JSON.parse(input.rawBody))}",
  ),
  probe(
    "timestamp",
    "12a signatures",
    factory,
    "Math.abs(clock.now() - input.timestamp) > 300",
    "false",
  ),
  probe(
    "delivery-id-signature",
    "feedback verifies",
    factory,
    "${input.timestamp}.${deliveryId}.${input.rawBody}",
    "${input.timestamp}.d1.${input.rawBody}",
  ),
  probe(
    "source-local-dedup",
    "12a signatures",
    queries,
    "WHERE workspace_id=? AND source_id=? AND delivery_id=?",
    "WHERE workspace_id=? AND ? IS NOT NULL AND delivery_id=?",
  ),
  probe(
    "workspace-local-dedup",
    "12a signatures",
    queries,
    "WHERE workspace_id=? AND source_id=? AND delivery_id=?",
    "WHERE ? IS NOT NULL AND source_id=? AND delivery_id=?",
  ),
  probe(
    "conversion-operation",
    "convert retries",
    factory,
    "operationId: `int_convert_${f.id}`",
    "operationId: ids.next()",
  ),
  probe(
    "conversion-viewer",
    "12a conversion",
    factory,
    "async convertFeedback(s, input) {",
    'async convertFeedback(s, input) { if (s.role === "viewer") return {id: input.feedbackId, issueId: "bypass", version: 2};',
  ),
  probe(
    "conversion-tenant",
    "12a conversion",
    queries,
    "FROM integrations_feedback WHERE workspace_id=? AND id=?",
    "FROM integrations_feedback WHERE ? IS NOT NULL AND id=?",
  ),
  probe(
    "source-secret-retry",
    "12a source and webhook",
    factory,
    "if (r.old) return { id: r.old, secret: null };\n      const secret = await vault.inboundSecret",
    "if (r.old) return { id: r.old, secret: await vault.inboundSecret(`${s.workspaceId}:${input.sourceId}`) };\n      const secret = await vault.inboundSecret",
  ),
  probe(
    "secret-event",
    "12a source and webhook",
    factory,
    '...audit(s, "SourceRegistered", input.sourceId)',
    '...audit(s, "SourceRegistered", secret)',
  ),
  probe(
    "secret-history",
    "12a source and webhook",
    factory,
    '...audit(s, "WebhookRegistered", input.sourceId)',
    "...audit(s, secret, input.sourceId)",
  ),
  probe(
    "secret-log",
    "12a source and webhook",
    factory,
    '...audit(s, "SourceRegistered", input.sourceId),',
    '...audit(s, "SourceRegistered", input.sourceId),\n        ...(console.log(secret), []),',
  ),
  probe(
    "secret-error",
    "12a source and webhook",
    factory,
    'fail("forbidden", "Invalid signature")',
    'fail("forbidden", secret)',
  ),
  probe(
    "vault-domain",
    "12a vault",
    adapter,
    'derive("outbound-aes-gcm",',
    'derive("inbound-hmac",',
  ),
  probe("ssrf-ipv4", "12a SSRF", factory, "/^\\d+[.]\\d+[.]\\d+[.]\\d+$/.test(host)", "false"),
  probe("ssrf-ipv6", "12a SSRF", factory, 'host.includes(":")', "false"),
  probe("ssrf-localhost", "12a SSRF", factory, 'host === "localhost"', "false"),
  probe("ssrf-internal", "12a SSRF", factory, 'host.endsWith(".internal")', "false"),
  probe("redirect-follow", "12a outbound", factory, 'redirect: "manual"', 'redirect: "follow"'),
  probe(
    "redirect-success",
    "12a outbound",
    factory,
    "ok = response.ok;",
    "ok = response.status < 400;",
  ),
  probe("retry-bound", "outbound retries use", factory, "next >= 5", "next >= 6"),
  probe(
    "delivered-retry",
    "12a outbound",
    queries,
    "WHERE d.status='pending' AND",
    "WHERE d.status!='failed' AND",
  ),
  probe(
    "unsubscribed-event",
    "12a outbound",
    factory,
    "!events.includes(input.eventType)",
    "false",
  ),
  probe("external-ref-https", "12a SSRF", factory, 'u.protocol !== "https:"', "false"),
  probe(
    "feedback-limit",
    "12a feedback rate",
    factory,
    "if (!(await d.limiter.allow(`feedback:${(await sha(`${ws}:${sourceId}`)).slice(0, 64)}`)))",
    "if (false)",
  ),
];
cases.push(
  probe(
    "webhook-secret-retry",
    "12a source and webhook",
    factory,
    "if (r.old) return { id: r.old, secret: null };\n      const secret = Array.from",
    'if (r.old) return { id: r.old, secret: await vault.open(str(source, "webhook_cipher")) };\n      const secret = Array.from',
  ),
);
for (const name of [
  "integrations.sources",
  "integrations.source.register",
  "integrations.webhook.register",
  "integrations.deliveries",
])
  cases.push(
    probe(
      `mcp-${name}`,
      "Integrations administration",
      catalog,
      `  "${name}",`,
      "",
      "tools/gateway.test.mjs",
    ),
  );
cases.push({
  id: "replay-accepted",
  pattern: "feedback verifies",
  suite: "tools/integrations.test.mjs",
  edits: [
    [
      factory,
      'if (old) return { id: str(old, "id") };',
      'if (old && false) return { id: str(old, "id") };',
    ],
    [
      queries,
      "VALUES(?,?,?,?,?,?,?,1,?)",
      "VALUES(?,?,?,?,?,?,?,1,?) ON CONFLICT(workspace_id,source_id,delivery_id) DO UPDATE SET id=excluded.id",
    ],
  ],
});
const selected = process.argv[2] ? cases.filter((c) => c.id === process.argv[2]) : cases;
assert(selected.length, "Unknown mutation case");
fs.mkdirSync("reports", { recursive: true });
fs.mkdirSync(".tmp", { recursive: true });
const lock = ".tmp/integrations-mutation.lock";
const fd = fs.openSync(lock, "wx");
const generated = "platform/generated/catalogs.ts";
const results = [],
  baselines = new Set();
const run = (args) =>
  spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
try {
  for (const c of selected) {
    const args = ["--test", `--test-name-pattern=${c.pattern}`, c.suite];
    if (!baselines.has(c.pattern)) {
      const healthy = run(args);
      fs.writeFileSync(
        `reports/integrations-baseline-${c.id}.log`,
        healthy.stdout + healthy.stderr,
      );
      assert.equal(healthy.status, 0, `Baseline failed: ${c.id}; see reports log`);
      assert.match(healthy.stdout, /# pass [1-9]/, "No regression executed");
      baselines.add(c.pattern);
    }
    const originals = new Map(
      [...c.edits.map(([path]) => path), generated].map((path) => [
        path,
        fs.readFileSync(path, "utf8"),
      ]),
    );
    try {
      for (const [path, before, after] of c.edits) {
        const source = fs.readFileSync(path, "utf8");
        assert.equal(source.split(before).length, 2, `Ambiguous or drifted target: ${c.id}`);
        fs.writeFileSync(path, source.replace(before, after));
      }
      if (c.edits.some(([path]) => path === queries)) {
        const generation = run(["tools/generate.mjs"]);
        assert.equal(generation.status, 0, `Invalid SQL mutation: ${c.id}`);
      }
      const result = run(args),
        output = result.stdout + result.stderr;
      fs.writeFileSync(`reports/integrations-mutation-${c.id}.log`, output);
      const status =
        result.status === 0
          ? "survived"
          : result.status === 1 && /ERR_ASSERTION/.test(output) && /not ok/.test(output)
            ? "killed"
            : "invalid";
      results.push({ id: c.id, status, regression: c.pattern });
      console.log(`${c.id}: ${status}`);
    } finally {
      for (const [path, contents] of originals) fs.writeFileSync(path, contents);
    }
  }
} finally {
  fs.closeSync(fd);
  fs.unlinkSync(lock);
  fs.writeFileSync("reports/integrations-mutations.json", `${JSON.stringify(results, null, 2)}\n`);
}
if (results.some((r) => r.status !== "killed")) process.exitCode = 1;
