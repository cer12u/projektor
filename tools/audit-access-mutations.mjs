import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

// Run without concurrent source edits: node tools/audit-access-mutations.mjs [case-id].
const factory = "modules/access/internal/factory.ts";
const assertions = "modules/access/internal/assertions.ts";
const rules = "modules/access/internal/rules.ts";
const oauth = "modules/access/internal/oauth.ts";
const queries = "modules/access/storage/queries.ts";
const cases = [
  [
    "jwks-kv-trust",
    assertions,
    "let list = cached();",
    "let list = cached(); const entry = await kv.get(`access:jwks:${issuer}`); if (entry) list = keys(object(JSON.parse(entry)).jwks);",
    "audit JWKS:",
  ],
  [
    "last-owner-demotion",
    queries,
    "(SELECT COUNT(*) FROM access_memberships WHERE workspace_id=? AND role='owner' AND active=1)>1",
    "(SELECT COUNT(*) FROM access_memberships WHERE workspace_id=? AND role='owner' AND active=1)>0",
    "concurrent last-owner changes",
  ],
  [
    "live-membership",
    factory,
    "return admit(state.identity, state.workspaceId, state.requestId, mode);",
    "return scope;",
    "public provider contract",
  ],
  ["revoked-credential", factory, "c?.revoked !== 0 ||", "false ||", "machine credentials:"],
  ["expired-assertion", assertions, "claims.exp <= now ||", "false ||", "human JWT:"],
  ["wrong-issuer", assertions, "claims.iss !== issuer ||", "false ||", "human JWT:"],
  ["wrong-audience", assertions, "aud === audience ||", "true ||", "human JWT:"],
  [
    "pkce",
    oauth,
    "row.challenge === (await challenge(input.code_verifier))",
    "true",
    "OAuth code security:",
  ],
  [
    "code-reuse",
    oauth,
    'await revoke(w, id);\n          throw new OAuthError("invalid_grant");',
    'return (await tokens(w, id, str(row, "scope"), clock.now() + 300, false)).result;',
    "OAuth code security:",
  ],
  [
    "refresh-reuse-family",
    oauth,
    "// A used token remains a tombstone even after expiry; never grant a grace replay.\n        if (row.used === 1) {\n          await revoke(w, id);",
    "// Mutant leaves the family usable after replay.\n        if (row.used === 1) {",
    "OAuth refresh:",
  ],
  [
    "oauth-confinement",
    factory,
    "if (p.workspaceId !== undefined && p.workspaceId !== w) deny();",
    'if (p.kind === "machine" && p.workspaceId !== w) deny();',
    "OAuth public API:",
  ],
  [
    "machine-confinement",
    factory,
    "if (p.workspaceId !== undefined && p.workspaceId !== w) deny();",
    "if (p.clientId && p.workspaceId !== w) deny();",
    "audit confinement:",
  ],
  ["viewer-write", factory, 'memberRole === "viewer" ||', "false ||", "public provider contract"],
  ["admin-owner", rules, 'current === "owner" ||', "false ||", "public provider contract"],
  [
    "last-owner",
    queries,
    "(role!='owner' OR (SELECT COUNT(*) FROM access_memberships WHERE workspace_id=? AND role='owner' AND active=1)>1)",
    "(? IS NOT NULL)",
    "public provider contract",
  ],
  [
    "scope-provenance",
    factory,
    "const state = scopes.get(scope);",
    'const state = scopes.get(scope) ?? { identity: { id: scope.principalId, kind: scope.kind, issuer: teamDomain, subject: "forged", expiresAt: clock.now() + 3600 }, workspaceId: scope.workspaceId, requestId: scope.requestId };',
    "audit provenance:",
  ],
];
const chosen = process.argv[2] ? cases.filter(([id]) => id === process.argv[2]) : cases;
assert(chosen.length, "Unknown mutation case");
fs.mkdirSync("reports", { recursive: true });
fs.mkdirSync(".tmp", { recursive: true });
const lock = ".tmp/access-mutation.lock";
const fd = fs.openSync(lock, "wx");
const catalog = "platform/generated/catalogs.ts";
const run = (args) =>
  spawnSync(process.execPath, args, {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024,
  });
const results = [];
try {
  for (const [id, path, before, after, pattern] of chosen) {
    const args = ["--test", `--test-name-pattern=${pattern}`, "tools/access.test.mjs"];
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
      fs.writeFileSync(`reports/access-mutation-${id}.log`, output);
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
  fs.writeFileSync("reports/access-mutations.json", `${JSON.stringify(results, null, 2)}\n`);
}
if (results.some(({ status }) => status !== "killed")) process.exitCode = 1;
