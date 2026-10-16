// Reproducible local D1/Worker probe. Run after `pnpm build`.
// Fixture uses only UI commands and the Access module's public commands.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { createFetchMock, Miniflare } from "miniflare";
import * as platform from "./test-entry.ts";

assert(fs.existsSync("dist/worker.js"), "Run pnpm build first");
fs.mkdirSync(".tmp", { recursive: true });
fs.writeFileSync(
  ".tmp/perf-entry.mjs",
  'import worker from "../dist/worker.js"; import { instrumentWorker } from "../tools/perf-worker.mjs"; export default instrumentWorker(worker);\n',
);
await build({
  entryPoints: [".tmp/perf-entry.mjs"],
  outfile: ".tmp/perf-worker.mjs",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
});
const reuse = !!process.env.PERF_FIXTURE_DIR;
const temp =
  process.env.PERF_FIXTURE_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "projektor-perf-"));
const issuer = "https://perf-probe.cloudflareaccess.com";
const audience = "perf-probe";
const pair = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);
const jwk = {
  ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
  kid: "perf",
  alg: "RS256",
  use: "sig",
};
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const message = `${b64({ alg: "RS256", kid: "perf" })}.${b64({ iss: issuer, aud: [audience], sub: "perf-owner", email: "owner@example.test", type: "app", iat: now - 1, exp: now + 3600 })}`;
const assertion = `${message}.${Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(message))).toString("base64url")}`;
function makeMf() {
  const fetchMock = createFetchMock();
  fetchMock
    .get(issuer)
    .intercept({ path: "/cdn-cgi/access/certs" })
    .reply(200, JSON.stringify({ keys: [jwk] }), {
      headers: { "content-type": "application/json" },
    })
    .persist();
  return new Miniflare({
    modules: true,
    scriptPath: ".tmp/perf-worker.mjs",
    compatibilityDate: "2026-07-30",
    fetchMock,
    d1Databases: ["DB"],
    d1Persist: path.join(temp, "d1"),
    kvNamespaces: ["KV"],
    kvPersist: path.join(temp, "kv"),
    r2Buckets: ["R2"],
    r2Persist: path.join(temp, "r2"),
    assets: {
      directory: "dist/assets",
      binding: "ASSETS",
      routerConfig: { has_user_worker: true },
    },
    ratelimits: { FEEDBACK_LIMIT: { namespace_id: "2003", simple: { limit: 60, period: 60 } } },
    bindings: {
      ACCESS_TEAM_DOMAIN: issuer,
      ACCESS_AUDIENCE: audience,
      INTEGRATIONS_KEY: "ab".repeat(32),
    },
  });
}
let mf = makeMf();
const db = await mf.getD1Database("DB");
if (!reuse)
  await platform.migrate(db, [
    "access",
    "projects",
    "issues",
    "wiki",
    "coordination",
    "assets",
    "planning",
    "insights",
    "integrations",
    "lifecycle",
  ]);
const access = platform.createAccess({
  store: platform.createModuleStore(db, "access"),
  kv: platform.createScopedKV(await mf.getKVNamespace("KV"), "access"),
  clock: platform.systemClock,
  ids: platform.randomIds,
  config: { teamDomain: issuer, audience },
  fetchJwks: async () => ({ keys: [jwk] }),
}).api;
const owner = await access.authenticate({ kind: "human", assertion });
if (!reuse)
  await access.createWorkspace(owner, {
    workspaceId: "perf",
    name: "Performance fixture",
    operationId: "perf-workspace",
  });
const scope = await access.requireMembership(owner, "perf", "seed", "write");
const machines = [];
for (let i = 1; i <= 2; i++)
  machines.push(
    await access.provisionMachine(scope, {
      principalId: `perf-member-${i}`,
      role: "member",
      operationId: `perf-member-${i}`,
    }),
  );
const mcpSecret = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const mcpCredentialId = crypto.randomUUID();
await access.issueCredential(scope, {
  principalId: machines[0].id,
  credentialId: mcpCredentialId,
  secret: mcpSecret,
  scope: "read",
  expiresAt: now + 3600,
  operationId: `perf-mcp-${mcpCredentialId}`,
});
const mcpToken = `pt1.perf.${mcpCredentialId}.${mcpSecret}`;

async function request(pathname, method = "GET", body, instance = mf, strict = true) {
  const response = await instance.dispatchFetch(`http://localhost${pathname}`, {
    method,
    headers: {
      cookie: `CF_Authorization=${assertion}`,
      "x-workspace-slug": "perf",
      ...(method !== "GET"
        ? { origin: "http://localhost", "content-type": "application/json" }
        : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const responseText = await response.text();
  const value = responseText ? JSON.parse(responseText) : null;
  if (strict && !response.ok)
    throw new Error(`${method} ${pathname}: ${response.status} ${JSON.stringify(value)}`);
  return {
    status: response.status,
    value,
    metric: {
      ...JSON.parse(response.headers.get("x-perf-probe")),
      responseBytes: Buffer.byteLength(responseText),
    },
  };
}
async function mcp(method, params, instance = mf) {
  const response = await instance.dispatchFetch("http://localhost/mcp/perf", {
    method: "POST",
    headers: {
      authorization: `Bearer ${mcpToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
  const responseText = await response.text();
  const value = JSON.parse(responseText);
  if (!response.ok || value.error)
    throw new Error(`MCP ${method}: ${response.status} ${JSON.stringify(value)}`);
  return {
    status: response.status,
    metric: {
      ...JSON.parse(response.headers.get("x-perf-probe")),
      responseBytes: Buffer.byteLength(responseText),
    },
  };
}

const projects = reuse ? (await request("/api/projects")).value : [];
if (!reuse)
  for (let i = 0; i < 5; i++)
    projects.push(
      (await request("/api/projects", "POST", { name: `Project ${i}`, key: `PERF${i}` })).value,
    );
const sprints = [];
if (!reuse)
  for (let i = 0; i < 10; i++)
    sprints.push(
      (
        await request("/api/sprints", "POST", {
          projectId: projects[i % 5].id,
          name: `Sprint ${i}`,
        })
      ).value,
    );
if (!reuse)
  for (let i = 0; i < 200; i++)
    await request("/api/wiki", "POST", {
      projectId: projects[i % 5].id,
      title: `Page ${i}`,
      slug: `page-${i}`,
      content: `Reference material ${i}. `.repeat(8),
    });
const issues = [];
if (!reuse)
  for (let i = 0; i < 2000; i++) {
    const created = (
      await request("/api/issues", "POST", {
        projectId: projects[i % 5].id,
        title: `Performance issue ${i}`,
        body: `Detailed issue body ${i}. `.repeat(8),
        labels: [i % 3 ? "feature" : "bug", "triage"],
        ...(i % 7 === 0 ? { assigneeId: scope.principalId } : {}),
        ...(i % 100 < 5 ? { sprintId: sprints[(Math.floor(i / 20) % 2) * 5 + (i % 5)].id } : {}),
      })
    ).value;
    issues.push(created);
    if (i % 20 === 0)
      await request(`/api/issues/${created.id}/comments`, "POST", { body: `Comment for ${i}` });
    if (i % 40 === 1)
      await request(`/api/issues/${created.id}/links`, "POST", {
        targetIssueId: issues[i - 1].id,
        type: "blocks",
      });
    if (i % 200 === 0) process.stderr.write(`seeded ${i + 1}/2000 issues\n`);
  }
if (reuse) issues.push((await request("/api/issues/PERF0-1")).value);

const p = projects[0].id,
  issue = issues[0].id;
const projectSprints = (await request(`/api/sprints?projectId=${p}`)).value.items;
if (!reuse) {
  const form = new FormData();
  form.set("entityType", "issue");
  form.set("entityId", issue);
  form.set(
    "file",
    new Blob(["Performance fixture attachment"], { type: "text/plain" }),
    "fixture.txt",
  );
  const multipart = new Request("http://localhost/api/files", { method: "POST", body: form });
  const upload = await mf.dispatchFetch("http://localhost/api/files", {
    method: "POST",
    headers: {
      cookie: `CF_Authorization=${assertion}`,
      "x-workspace-slug": "perf",
      origin: "http://localhost",
      "content-type": multipart.headers.get("content-type"),
    },
    body: await multipart.arrayBuffer(),
  });
  assert.equal(upload.status, 201, await upload.text());
}
const groups = {
  "projects list": ["/auth/me", "/api/projects"],
  "project landing": [`/api/projects/${p}`, `/api/issues?project=${p}`, `/api/wiki?projectId=${p}`],
  "issue list": [
    "/api/projects",
    "/api/issues?limit=30",
    "/api/task-statuses",
    "/api/task-types",
    "/api/issues?typeId=type_epic&limit=100",
  ],
  board: [
    "/api/projects",
    `/api/issues?project=${p}&limit=100`,
    "/api/task-statuses",
    "/api/task-types",
    `/api/issues?project=${p}&typeId=type_epic&limit=100`,
  ],
  "issue detail": [
    `/api/issues/PERF0-1`,
    `/api/issues/${issue}/comments`,
    `/api/issues/${issue}/links`,
    `/api/files?entityType=issue&entityId=${issue}`,
    "/api/task-statuses",
    "/api/task-types",
    "/api/workspaces/perf",
  ],
  "My Issues": ["/auth/me", "/api/issues?assignee=me&limit=100"],
  "sprint page": [
    "/api/projects",
    `/api/projects/${p}`,
    `/api/sprints?projectId=${p}`,
    ...projectSprints.map((sprint) => `/api/issues?sprintId=${sprint.id}&limit=100`),
  ],
  "wiki page": [
    "/api/projects",
    `/api/wiki?projectId=${p}`,
    "/api/wiki/page-0",
    "/api/wiki/templates",
  ],
  "metrics page": [`/api/projects/${p}/flow-metrics`],
  "issue search": ["/api/issues/search?q=Performance"],
  "MCP tools/list": [["mcp:tools/list"]],
  "MCP issue read": [["mcp:issues.get", "POST", { issueId: issue }]],
};
const results = [];
async function measure(name, calls, instance, phase) {
  const rows = [];
  let boardCursor;
  let myIssuesCursor;
  for (const call of calls) {
    const [pathname, method, body] = Array.isArray(call) ? call : [call, "GET", undefined];
    const result = pathname.startsWith("mcp:")
      ? await mcp(
          pathname === "mcp:tools/list" ? "tools/list" : "tools/call",
          pathname === "mcp:tools/list" ? undefined : { name: "issues.get", arguments: body },
          instance,
        )
      : await request(pathname, method, body, instance, false);
    rows.push({ path: pathname, method, status: result.status, ...result.metric });
    if (name === "board" && pathname.startsWith("/api/issues?") && !pathname.includes("typeId="))
      boardCursor = result.value?.nextCursor;
    if (name === "My Issues" && pathname.startsWith("/api/issues?"))
      myIssuesCursor = result.value?.nextCursor;
  }
  if (name === "board")
    for (let page = 0; boardCursor != null && page < 50; page++) {
      const pathname = `/api/issues?project=${p}&cursor=${encodeURIComponent(boardCursor)}`;
      const result = await request(pathname, "GET", undefined, instance);
      rows.push({ path: pathname, method: "GET", status: result.status, ...result.metric });
      boardCursor = result.value.nextCursor;
    }
  if (name === "My Issues")
    for (let page = 0; myIssuesCursor != null && page < 50; page++) {
      const pathname = `/api/issues?assignee=me&limit=100&cursor=${encodeURIComponent(myIssuesCursor)}`;
      const result = await request(pathname, "GET", undefined, instance);
      rows.push({ path: pathname, method: "GET", status: result.status, ...result.metric });
      myIssuesCursor = result.value.nextCursor;
    }
  const aggregate = {
    name,
    phase,
    requests: rows.length,
    roundTrips: rows.reduce((n, r) => n + r.roundTrips, 0),
    statements: rows.reduce((n, r) => n + r.statements, 0),
    rowsRead: rows.reduce((n, r) => n + r.rowsRead, 0),
    responseBytes: rows.reduce((n, r) => n + r.responseBytes, 0),
    sequentialWaves: Math.max(...rows.map((r) => r.sequentialWaves)),
    wallMs: Math.round(Math.max(...rows.map((r) => r.wallMs)) * 10) / 10,
    cpuApproxMs: Math.round(rows.reduce((n, r) => n + r.cpuApproxMs, 0) * 10) / 10,
    calls: rows,
  };
  results.push(aggregate);
  return aggregate;
}
const writes = {
  "PATCH issue": [[`/api/issues/${issue}`, "PATCH", { title: "Performance issue revised" }]],
  "add comment": [[`/api/issues/${issue}/comments`, "POST", { body: "Measured comment" }]],
  "create issue": [["/api/issues", "POST", { projectId: p, title: "Measured creation" }]],
};
// Read sets use the same fixture before either phase's writes change it.
for (const [name, calls] of Object.entries(groups)) await measure(name, calls, mf, "warm");
await mf.dispose();
for (const [name, calls] of Object.entries(groups)) {
  mf = makeMf();
  await measure(name, calls, mf, "cold");
  await mf.dispose();
}
mf = makeMf();
await request("/auth/me", "GET", undefined, mf); // warm the write isolate
for (const [name, calls] of Object.entries(writes)) await measure(name, calls, mf, "warm");
await mf.dispose();
for (const [name, calls] of Object.entries(writes)) {
  mf = makeMf();
  await measure(name, calls, mf, "cold");
  await mf.dispose();
}
fs.mkdirSync("docs/performance", { recursive: true });
const baseline = {
  generatedAt: new Date().toISOString(),
  fixture: {
    workspaces: 1,
    projects: 5,
    issues: 2000,
    comments: 100,
    links: 50,
    files: 1,
    labelsPerIssue: 2,
    sprints: 10,
    wikiPages: 200,
    members: 3,
    assignedToOwner: 286,
    sprintAssigned: 100,
  },
  note: "Miniflare wall time minus union of D1 wait intervals approximates CPU; first() omits rows_read metadata. Sequential waves approximate a dependency chain, not a traced async DAG.",
  results,
};
fs.writeFileSync("docs/performance/baseline.json", `${JSON.stringify(baseline, null, 2)}\n`);
console.table(
  results.map(
    ({
      name,
      phase,
      requests,
      roundTrips,
      statements,
      rowsRead,
      responseBytes,
      sequentialWaves,
      wallMs,
      cpuApproxMs,
    }) => ({
      name,
      phase,
      requests,
      roundTrips,
      statements,
      rowsRead,
      responseBytes,
      sequentialWaves,
      wallMs,
      cpuApproxMs,
    }),
  ),
);
if (!reuse) fs.rmSync(temp, { recursive: true, force: true });
