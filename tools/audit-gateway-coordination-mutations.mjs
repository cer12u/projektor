import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

// Run alone: patches source and generated catalog, always restoring in finally.
// Only executed assertion failures count, never compilation/setup failures.
const cases = [
  {
    id: "dual-credentials",
    patches: [
      {
        path: "gateway/public.ts",
        before: "if (assertion && authorization)",
        after: "if (false)",
      },
    ],
    file: "tools/gateway-oauth-rules.test.mjs",
    pattern: "audit Gateway guards",
  },
  {
    id: "workspace-header",
    patches: [
      {
        path: "gateway/public.ts",
        before: "if (fromHeader && fromHeader !== fromPath)",
        after: "if (false)",
      },
    ],
    file: "tools/gateway-oauth-rules.test.mjs",
    pattern: "audit Gateway guards",
  },
  {
    id: "origin",
    patches: [
      {
        path: "gateway/public.ts",
        before: "if (origin && origin !== new URL(request.url).origin)",
        after: "if (false)",
      },
    ],
    file: "tools/gateway-oauth-rules.test.mjs",
    pattern: "audit Gateway guards",
  },
  {
    id: "non-json",
    patches: [
      {
        path: "gateway/public.ts",
        before:
          'request.headers.get("content-type")?.toLowerCase().split(";")[0].trim() !== "application/json"',
        after: "false",
      },
    ],
    file: "tools/gateway-oauth-rules.test.mjs",
    pattern: "audit Gateway guards",
  },
  {
    id: "internal-error",
    patches: [
      {
        path: "gateway/public.ts",
        before: 'error instanceof PlatformError && error.code !== "unknown"',
        after: "error instanceof PlatformError",
      },
    ],
    file: "tools/gateway-oauth-rules.test.mjs",
    pattern: "audit Gateway guards",
  },
  {
    id: "mcp-write-scope",
    patches: [
      {
        path: "gateway/public.ts",
        before: '          entry.write ? "write" : "read",',
        after: '          "read",',
      },
    ],
    file: "tools/gateway-oauth-rules.test.mjs",
    pattern: "audit Gateway guards",
  },
  {
    id: "oauth-on-rest",
    patches: [
      {
        path: "gateway/public.ts",
        before: 'if (endpoint === "mcp" && services.oauthOrigin) {',
        after: "if (services.oauthOrigin) {",
      },
    ],
    file: "tools/gateway-oauth-rules.test.mjs",
    pattern: "audit Gateway guards",
  },
  {
    id: "www-authenticate",
    patches: [
      {
        path: "gateway/public.ts",
        before: '{ "www-authenticate": challenge, "x-request-id": requestId }',
        after: '{ "x-request-id": requestId }',
      },
    ],
    file: "tools/gateway-oauth-rules.test.mjs",
    pattern: "audit Gateway guards",
  },
  {
    id: "form-replay",
    patches: [
      {
        path: "gateway/oauth.ts",
        before: "await access.consumeOAuthForm(scope, await digest(form.form_token));",
        after: "",
      },
    ],
    file: "tools/gateway-oauth.test.mjs",
    pattern: "CSRF origin",
  },
  {
    id: "csrf-cookie",
    patches: [
      {
        path: "gateway/oauth.ts",
        before: "state.csrf === (await digest(cookies[0].slice(cookieName.length + 1)))",
        after: "true",
      },
    ],
    file: "tools/gateway-oauth.test.mjs",
    pattern: "CSRF origin",
  },
  {
    id: "unregistered-redirect",
    patches: [
      {
        path: "gateway/oauth.ts",
        before: "      const code =\n        error instanceof OAuthError",
        after:
          '      if (interactive && url.searchParams.has("redirect_uri")) return redirect({redirect_uri: url.searchParams.get("redirect_uri")!, iss:config.issuer}, {error:"access_denied"});\n      const code =\n        error instanceof OAuthError',
      },
    ],
    file: "tools/gateway-oauth.test.mjs",
    pattern: "CSRF origin",
  },
  {
    id: "two-live-holders",
    patches: [
      {
        path: "modules/coordination/internal/factory.ts",
        before: "if (previous && previous.sessionId !== null && previous.expiresAt > now)",
        after: "if (false)",
      },
      {
        path: "modules/coordination/storage/queries.ts",
        before:
          "\"UPDATE coord_leases SET session_id=?,fencing_token=fencing_token+1,expires_at=?,release_reason=CASE WHEN session_id IS NULL THEN release_reason ELSE 'expired' END WHERE workspace_id=? AND issue_id=? AND (session_id IS NULL OR expires_at<=?) AND (SELECT COUNT(*) FROM coord_leases WHERE workspace_id=? AND project_id=? AND session_id IS NOT NULL AND expires_at>?) < COALESCE((SELECT cap FROM coord_limits WHERE workspace_id=? AND project_id=?),3)\"",
        after:
          "\"UPDATE coord_leases SET session_id=?,fencing_token=fencing_token+1,expires_at=?,release_reason=CASE WHEN session_id IS NULL THEN release_reason ELSE 'expired' END WHERE workspace_id=? AND issue_id=? AND (? IS NOT NULL) AND (SELECT COUNT(*) FROM coord_leases WHERE workspace_id=? AND project_id=? AND session_id IS NOT NULL AND expires_at>?) < COALESCE((SELECT cap FROM coord_limits WHERE workspace_id=? AND project_id=?),3)\"",
      },
    ],
    file: "tools/coordination.test.mjs",
    pattern: "audit live holder",
  },
  {
    id: "stale-reportProgress",
    patches: [
      {
        path: "modules/coordination/internal/factory.ts",
        before: "lease.fencingToken !== integer(token, 1) ||",
        after: "",
      },
      {
        path: "modules/coordination/storage/queries.ts",
        before:
          '"INSERT INTO coord_reports(workspace_id,issue_id,session_id,fencing_token,text,status,reported_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM coord_leases WHERE workspace_id=? AND issue_id=? AND session_id=? AND fencing_token=? AND expires_at>?) ON CONFLICT(workspace_id,issue_id) DO UPDATE SET session_id=excluded.session_id,fencing_token=excluded.fencing_token,text=excluded.text,status=excluded.status,reported_at=excluded.reported_at"',
        after:
          '"INSERT INTO coord_reports(workspace_id,issue_id,session_id,fencing_token,text,status,reported_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM coord_leases WHERE workspace_id=? AND issue_id=? AND session_id=? AND ? IS NOT NULL AND expires_at>?) ON CONFLICT(workspace_id,issue_id) DO UPDATE SET session_id=excluded.session_id,fencing_token=excluded.fencing_token,text=excluded.text,status=excluded.status,reported_at=excluded.reported_at"',
      },
    ],
    file: "tools/coordination.test.mjs",
    pattern: "audit live holder",
  },
  {
    id: "sql-fence-reportProgress",
    patches: [
      {
        path: "modules/coordination/storage/queries.ts",
        before:
          '"INSERT INTO coord_reports(workspace_id,issue_id,session_id,fencing_token,text,status,reported_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM coord_leases WHERE workspace_id=? AND issue_id=? AND session_id=? AND fencing_token=? AND expires_at>?) ON CONFLICT(workspace_id,issue_id) DO UPDATE SET session_id=excluded.session_id,fencing_token=excluded.fencing_token,text=excluded.text,status=excluded.status,reported_at=excluded.reported_at"',
        after:
          '"INSERT INTO coord_reports(workspace_id,issue_id,session_id,fencing_token,text,status,reported_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM coord_leases WHERE workspace_id=? AND issue_id=? AND session_id=? AND ? IS NOT NULL AND expires_at>?) ON CONFLICT(workspace_id,issue_id) DO UPDATE SET session_id=excluded.session_id,fencing_token=excluded.fencing_token,text=excluded.text,status=excluded.status,reported_at=excluded.reported_at"',
      },
    ],
    file: "tools/coordination.test.mjs",
    pattern: "audit SQL fence survives admission race: reportProgress",
  },
  {
    id: "stale-renewLease",
    patches: [
      {
        path: "modules/coordination/internal/factory.ts",
        before: "lease.fencingToken !== integer(token, 1) ||",
        after: "",
      },
      {
        path: "modules/coordination/storage/queries.ts",
        before:
          '"UPDATE coord_leases SET expires_at=? WHERE workspace_id=? AND issue_id=? AND session_id=? AND fencing_token=? AND expires_at>?"',
        after:
          '"UPDATE coord_leases SET expires_at=? WHERE workspace_id=? AND issue_id=? AND session_id=? AND ? IS NOT NULL AND expires_at>?"',
      },
    ],
    file: "tools/coordination.test.mjs",
    pattern: "audit live holder",
  },
  {
    id: "sql-fence-renewLease",
    patches: [
      {
        path: "modules/coordination/storage/queries.ts",
        before:
          '"UPDATE coord_leases SET expires_at=? WHERE workspace_id=? AND issue_id=? AND session_id=? AND fencing_token=? AND expires_at>?"',
        after:
          '"UPDATE coord_leases SET expires_at=? WHERE workspace_id=? AND issue_id=? AND session_id=? AND ? IS NOT NULL AND expires_at>?"',
      },
    ],
    file: "tools/coordination.test.mjs",
    pattern: "audit SQL fence survives admission race: renewLease",
  },
  {
    id: "stale-releaseLease",
    patches: [
      {
        path: "modules/coordination/internal/factory.ts",
        before: "lease.fencingToken !== integer(token, 1) ||",
        after: "",
      },
      {
        path: "modules/coordination/storage/queries.ts",
        before:
          "\"UPDATE coord_leases SET session_id=NULL,expires_at=?,release_reason='released' WHERE workspace_id=? AND issue_id=? AND session_id=? AND fencing_token=? AND expires_at>?\"",
        after:
          "\"UPDATE coord_leases SET session_id=NULL,expires_at=?,release_reason='released' WHERE workspace_id=? AND issue_id=? AND session_id=? AND ? IS NOT NULL AND expires_at>?\"",
      },
    ],
    file: "tools/coordination.test.mjs",
    pattern: "audit live holder",
  },
  {
    id: "sql-fence-releaseLease",
    patches: [
      {
        path: "modules/coordination/storage/queries.ts",
        before:
          "\"UPDATE coord_leases SET session_id=NULL,expires_at=?,release_reason='released' WHERE workspace_id=? AND issue_id=? AND session_id=? AND fencing_token=? AND expires_at>?\"",
        after:
          "\"UPDATE coord_leases SET session_id=NULL,expires_at=?,release_reason='released' WHERE workspace_id=? AND issue_id=? AND session_id=? AND ? IS NOT NULL AND expires_at>?\"",
      },
    ],
    file: "tools/coordination.test.mjs",
    pattern: "audit SQL fence survives admission race: releaseLease",
  },
  {
    id: "stale-claimFiles",
    patches: [
      {
        path: "modules/coordination/internal/factory.ts",
        before: "lease.fencingToken !== integer(token, 1) ||",
        after: "",
      },
      {
        path: "modules/coordination/storage/queries.ts",
        before:
          '"INSERT INTO coord_file_claims(workspace_id,repo,path,session_id,lease_issue_id,expires_at) SELECT ?,?,?,?,?,? WHERE (? IS NULL OR EXISTS (SELECT 1 FROM coord_leases WHERE workspace_id=? AND issue_id=? AND session_id=? AND fencing_token=? AND expires_at>?)) ON CONFLICT(workspace_id,repo,path) DO UPDATE SET session_id=excluded.session_id,lease_issue_id=excluded.lease_issue_id,expires_at=excluded.expires_at WHERE (coord_file_claims.expires_at<=? OR coord_file_claims.session_id=? OR ?=1) AND coord_file_claims.session_id=?"',
        after:
          '"INSERT INTO coord_file_claims(workspace_id,repo,path,session_id,lease_issue_id,expires_at) SELECT ?,?,?,?,?,? WHERE (? IS NULL OR EXISTS (SELECT 1 FROM coord_leases WHERE workspace_id=? AND issue_id=? AND session_id=? AND ? IS NOT NULL AND expires_at>?)) ON CONFLICT(workspace_id,repo,path) DO UPDATE SET session_id=excluded.session_id,lease_issue_id=excluded.lease_issue_id,expires_at=excluded.expires_at WHERE (coord_file_claims.expires_at<=? OR coord_file_claims.session_id=? OR ?=1) AND coord_file_claims.session_id=?"',
      },
    ],
    file: "tools/coordination.test.mjs",
    pattern: "audit live holder",
  },
  {
    id: "sql-fence-claimFiles",
    patches: [
      {
        path: "modules/coordination/storage/queries.ts",
        before:
          '"INSERT INTO coord_file_claims(workspace_id,repo,path,session_id,lease_issue_id,expires_at) SELECT ?,?,?,?,?,? WHERE (? IS NULL OR EXISTS (SELECT 1 FROM coord_leases WHERE workspace_id=? AND issue_id=? AND session_id=? AND fencing_token=? AND expires_at>?)) ON CONFLICT(workspace_id,repo,path) DO UPDATE SET session_id=excluded.session_id,lease_issue_id=excluded.lease_issue_id,expires_at=excluded.expires_at WHERE (coord_file_claims.expires_at<=? OR coord_file_claims.session_id=? OR ?=1) AND coord_file_claims.session_id=?"',
        after:
          '"INSERT INTO coord_file_claims(workspace_id,repo,path,session_id,lease_issue_id,expires_at) SELECT ?,?,?,?,?,? WHERE (? IS NULL OR EXISTS (SELECT 1 FROM coord_leases WHERE workspace_id=? AND issue_id=? AND session_id=? AND ? IS NOT NULL AND expires_at>?)) ON CONFLICT(workspace_id,repo,path) DO UPDATE SET session_id=excluded.session_id,lease_issue_id=excluded.lease_issue_id,expires_at=excluded.expires_at WHERE (coord_file_claims.expires_at<=? OR coord_file_claims.session_id=? OR ?=1) AND coord_file_claims.session_id=?"',
      },
    ],
    file: "tools/coordination.test.mjs",
    pattern: "audit SQL fence survives admission race: claimFiles",
  },
  {
    id: "wip-off-by-one",
    patches: [
      {
        path: "modules/coordination/storage/queries.ts",
        before:
          '"INSERT INTO coord_leases(workspace_id,issue_id,project_id,session_id,fencing_token,expires_at,release_reason) SELECT ?,?,?,?,1,?,NULL WHERE (SELECT COUNT(*) FROM coord_leases WHERE workspace_id=? AND project_id=? AND session_id IS NOT NULL AND expires_at>?) < COALESCE((SELECT cap FROM coord_limits WHERE workspace_id=? AND project_id=?),3)"',
        after:
          '"INSERT INTO coord_leases(workspace_id,issue_id,project_id,session_id,fencing_token,expires_at,release_reason) SELECT ?,?,?,?,1,?,NULL WHERE (SELECT COUNT(*) FROM coord_leases WHERE workspace_id=? AND project_id=? AND session_id IS NOT NULL AND expires_at>?) <= COALESCE((SELECT cap FROM coord_limits WHERE workspace_id=? AND project_id=?),3)"',
      },
    ],
    file: "tools/coordination.test.mjs",
    pattern: "WIP cap,",
  },
  {
    id: "partial-claim",
    patches: [
      {
        path: "modules/coordination/internal/factory.ts",
        before: "await store.batch([",
        after:
          'await (async (calls: readonly Statement[]) => { if (!calls.some(call => call.name === "putClaim")) return store.batch(calls); for (let i=0; i<calls.length; i+=3) await store.batch(calls.slice(i,i+3)); })([',
      },
    ],
    file: "tools/coordination.test.mjs",
    pattern: "audit claim race",
  },
  {
    id: "force-non-manager",
    patches: [
      {
        path: "modules/coordination/internal/factory.ts",
        before: 'await projects.authorizeProject(scope, lease.projectId, "manage");',
        after: "",
      },
    ],
    file: "tools/coordination.test.mjs",
    pattern: "audit claims reject",
  },
  {
    id: "tenant-lease",
    patches: [
      {
        path: "modules/coordination/storage/queries.ts",
        before:
          '"SELECT issue_id,project_id,session_id,fencing_token,expires_at,release_reason FROM coord_leases WHERE workspace_id=? AND issue_id=?"',
        after:
          '"SELECT issue_id,project_id,session_id,fencing_token,expires_at,release_reason FROM coord_leases WHERE ? IS NOT NULL AND issue_id=?"',
      },
    ],
    file: "tools/coordination.test.mjs",
    pattern: "audit claims reject",
  },
  {
    id: "tenant-leases",
    patches: [
      {
        path: "modules/coordination/storage/queries.ts",
        before:
          '"SELECT issue_id,project_id,session_id,fencing_token,expires_at,release_reason FROM coord_leases WHERE workspace_id=? AND project_id=? ORDER BY issue_id LIMIT 100"',
        after:
          '"SELECT issue_id,project_id,session_id,fencing_token,expires_at,release_reason FROM coord_leases WHERE ? IS NOT NULL AND project_id=? ORDER BY issue_id LIMIT 100"',
      },
    ],
    file: "tools/coordination.test.mjs",
    pattern: "audit claims reject",
  },
  {
    id: "tenant-claims",
    patches: [
      {
        path: "modules/coordination/storage/queries.ts",
        before:
          '"SELECT repo,path,session_id,lease_issue_id,expires_at FROM coord_file_claims WHERE workspace_id=? AND repo=? ORDER BY path LIMIT 100"',
        after:
          '"SELECT repo,path,session_id,lease_issue_id,expires_at FROM coord_file_claims WHERE ? IS NOT NULL AND repo=? ORDER BY path LIMIT 100"',
      },
    ],
    file: "tools/coordination.test.mjs",
    pattern: "audit claims reject",
  },
  {
    id: "issues-state",
    patches: [
      {
        path: "modules/coordination/internal/factory.ts",
        before: 'Pick<IssuesApi, "authorizeIssue">',
        after: 'Pick<IssuesApi, "authorizeIssue" | "transitionIssue">',
      },
      {
        path: "modules/coordination/internal/factory.ts",
        before: "      const result: Progress = {",
        after:
          '      await issues.transitionIssue(scope, {operationId:input.operationId,issueId:iid,expectedVersion:(await issues.authorizeIssue(scope,iid)).version,state:"in_progress"});\n      const result: Progress = {',
      },
    ],
    file: "tools/gateway.test.mjs",
    pattern: "two MCP SDK agents",
  },
];
const baseline = process.argv.includes("--original");
const requested = process.argv.slice(2).filter((x) => x !== "--original");
const selected = requested.length ? cases.filter((x) => requested.includes(x.id)) : cases;
assert(selected.length, "Unknown mutation");
fs.mkdirSync(".tmp", { recursive: true });
fs.mkdirSync("reports", { recursive: true });
const lock = ".tmp/gateway-coordination-mutation.lock",
  fd = fs.openSync(lock, "wx");
const catalog = "platform/generated/catalogs.ts",
  results = [];
const run = (args) =>
  spawnSync(process.execPath, args, {
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 8 * 1024 * 1024,
  });
try {
  for (const probe of selected) {
    const args = [
      "--test",
      "--test-reporter=tap",
      ...(baseline ? [] : [`--test-name-pattern=${probe.pattern}`]),
      probe.file,
    ];
    const originals = new Map(
      [catalog, probe.file, ...probe.patches.map((x) => x.path)].map((path) => [
        path,
        fs.readFileSync(path, "utf8"),
      ]),
    );
    try {
      if (baseline) {
        const old = spawnSync("git", ["show", `3bf12fa:${probe.file}`], { encoding: "utf8" });
        assert.equal(old.status, 0, "Cannot load original suite");
        fs.writeFileSync(probe.file, old.stdout);
      }
      const healthy = run(args);
      fs.writeFileSync(
        `reports/08a-${baseline ? "original-" : ""}${probe.id}-healthy.log`,
        healthy.stdout + healthy.stderr,
      );
      assert.equal(healthy.status, 0, `Healthy regression failed: ${probe.id} (see reports)`);
      assert.match(healthy.stdout, /# pass [1-9]/);
      for (const patch of probe.patches) {
        const source = fs.readFileSync(patch.path, "utf8");
        assert.equal(source.split(patch.before).length, 2, `Target drift: ${probe.id}`);
        fs.writeFileSync(patch.path, source.replace(patch.before, patch.after));
      }
      if (probe.patches.some((x) => x.path.endsWith("queries.ts"))) {
        const generated = run(["tools/generate.mjs"]);
        fs.writeFileSync(
          `reports/08a-${probe.id}-generate.log`,
          generated.stdout + generated.stderr,
        );
        assert.equal(generated.status, 0, `Generation failed: ${probe.id}`);
      }
      const tested = run(args),
        output = tested.stdout + tested.stderr;
      fs.writeFileSync(`reports/08a-${baseline ? "original-" : ""}${probe.id}.log`, output);
      const status =
        tested.status === 1 && /ERR_ASSERTION/.test(output) && /not ok/.test(output)
          ? "killed"
          : tested.status === 0
            ? "survived"
            : "invalid";
      results.push({ id: probe.id, status, regression: probe.pattern });
      console.log(`${probe.id}: ${status}`);
    } finally {
      for (const [path, source] of originals) fs.writeFileSync(path, source);
    }
  }
} finally {
  fs.closeSync(fd);
  fs.unlinkSync(lock);
  fs.writeFileSync(
    `reports/gateway-coordination-${baseline ? "original-" : ""}mutations.json`,
    JSON.stringify(results, null, 2) + "\n",
  );
}
if (results.some((x) => x.status === "invalid" || (!baseline && x.status !== "killed")))
  process.exitCode = 1;
