import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { build } from "esbuild";
import { createFetchMock, Miniflare } from "miniflare";
import { assetsProviderContract } from "./assets-provider-contract.mjs";
import { coordinationProviderContract } from "./coordination-provider-contract.mjs";
import { insightsProviderContract } from "./insights-provider-contract.mjs";

let contractProviders;

let mf, platform, write, read, other, ownerAssertion, writeMachineId, unjoinedAssertion;
const issuer = "https://unit.cloudflareaccess.com";
const audience = "projektor-test";
const b64 = (x) => Buffer.from(JSON.stringify(x)).toString("base64url");
const endpoint = (w, op) => `http://localhost/api/w/${w}/${op.replaceAll(".", "/")}`;
async function req(w, op, args, token, method) {
  const url = new URL(endpoint(w, op));
  const action = method ?? (args.operationId ? "POST" : "GET");
  if (action === "GET")
    for (const [k, v] of Object.entries(args)) url.searchParams.set(k, String(v));
  const response = await mf.dispatchFetch(url.toString(), {
    method: action,
    headers: {
      authorization: `Bearer ${token}`,
      ...(action === "POST" ? { "content-type": "application/json" } : {}),
    },
    ...(action === "POST" ? { body: JSON.stringify(args) } : {}),
  });
  return { status: response.status, data: await response.json() };
}
async function rpc(w, name, args, token) {
  const response = await mf.dispatchFetch(`http://localhost/mcp/${w}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  return { status: response.status, data: await response.json() };
}
function mcpResult(response) {
  const result = response.data.result;
  return result.isError ? JSON.parse(result.content[0].text) : JSON.parse(result.content[0].text);
}
before(async () => {
  fs.mkdirSync(".tmp", { recursive: true });
  await build({
    entryPoints: ["tools/test-entry.ts"],
    outfile: ".tmp/test-entry.mjs",
    bundle: true,
    format: "esm",
    platform: "node",
  });
  await build({
    entryPoints: ["apps/worker/index.ts"],
    outfile: ".tmp/gateway-worker.mjs",
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
  });
  platform = await import("../.tmp/test-entry.mjs");
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
    kid: "test",
    alg: "RS256",
    use: "sig",
  };
  const fetchMock = createFetchMock();
  fetchMock
    .get(issuer)
    .intercept({ path: "/cdn-cgi/access/certs" })
    .reply(200, JSON.stringify({ keys: [jwk] }), {
      headers: { "content-type": "application/json" },
    })
    .persist();
  mf = new Miniflare({
    modules: true,
    fetchMock,
    scriptPath: ".tmp/gateway-worker.mjs",
    compatibilityDate: "2026-07-30",
    d1Databases: ["DB"],
    kvNamespaces: ["KV"],
    r2Buckets: ["R2"],
    ratelimits: { FEEDBACK_LIMIT: { namespace_id: "1003", simple: { limit: 60, period: 60 } } },
    bindings: {
      ACCESS_TEAM_DOMAIN: issuer,
      ACCESS_AUDIENCE: audience,
      INTEGRATIONS_KEY: "ab".repeat(32),
    },
  });
  const db = await mf.getD1Database("DB");
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
  ]);
  const clock = { now: () => Math.floor(Date.now() / 1000) };
  const created = platform.createAccess({
    store: platform.createModuleStore(db, "access"),
    kv: platform.createScopedKV(await mf.getKVNamespace("KV"), "access"),
    clock,
    ids: platform.randomIds,
    config: { teamDomain: issuer, audience },
    fetchJwks: async () => ({ keys: [jwk] }),
  });
  const sign = async (subject) => {
    const message = `${b64({ alg: "RS256", kid: "test" })}.${b64({ iss: issuer, aud: [audience], sub: subject, email: `${subject}@example.test`, type: "app", iat: clock.now() - 1, exp: clock.now() + 3600 })}`;
    return `${message}.${Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(message))).toString("base64url")}`;
  };
  unjoinedAssertion = await sign("unjoined-07c");
  for (const w of ["w1", "w2"]) {
    const assertion = await sign(w);
    if (w === "w1") ownerAssertion = assertion;
    const human = await created.api.authenticate({ kind: "human", assertion });
    await created.api.createWorkspace(human, {
      workspaceId: w,
      name: w,
      operationId: `workspace-${w}`,
    });
    const scope = await created.api.requireMembership(human, w, "setup", "write");
    const projectApi = platform.createProjects({
      store: platform.createModuleStore(db, "projects"),
      access: created.api,
      clock,
      ids: platform.randomIds,
    }).api;
    for (const projectId of w === "w1" ? ["p1", "sdkp"] : ["p1"])
      await projectApi.createProject(scope, {
        operationId: `setup-${w}-${projectId}`,
        projectId,
        key: projectId.toUpperCase(),
        name: projectId,
      });
    for (const mode of ["write", "read"]) {
      const principalId = `bot-${w}-${mode}`;
      const machine = await created.api.provisionMachine(scope, {
        principalId,
        role: "member",
        operationId: `provision-${w}-${mode}`,
      });
      if (w === "w1" && mode === "write") writeMachineId = machine.id;
      const credentialId = `key-${w}-${mode}`;
      const secret = mode === "write" ? "a1".repeat(32) : "b2".repeat(32);
      await created.api.issueCredential(scope, {
        principalId: machine.id,
        credentialId,
        secret,
        scope: mode,
        expiresAt: clock.now() + 3600,
        operationId: `issue-${w}-${mode}`,
      });
      for (const projectId of w === "w1" ? ["p1", "sdkp"] : ["p1"])
        await projectApi.grantProjectRole(scope, {
          operationId: `grant-${w}-${mode}-${projectId}`,
          projectId,
          expectedVersion: mode === "write" ? 1 : 2,
          principalId: machine.id,
          role: mode === "write" ? "editor" : "viewer",
        });
      const token = `pt1.${w}.${credentialId}.${secret}`;
      if (w === "w1") {
        if (mode === "write") write = token;
        else read = token;
      } else if (mode === "write") other = token;
    }
    if (w === "w1") {
      const editor = await created.api.requireMembership(
        await created.api.authenticate({ kind: "machine", bearer: write }),
        w,
        "contract-editor",
      );
      const viewer = await created.api.requireMembership(
        await created.api.authenticate({ kind: "machine", bearer: read }),
        w,
        "contract-viewer",
      );
      const issues = platform.createIssues({
        store: platform.createModuleStore(db, "issues"),
        access: created.api,
        projects: projectApi,
        clock,
        ids: platform.randomIds,
      }).api;
      contractProviders = {
        access: created.api,
        projects: projectApi,
        issues,
        editor,
        viewer,
        manager: scope,
        issueId: "contract-issue",
        projectId: "p1",
      };
    }
  }
});

after(async () => {
  await mf?.dispose();
});

test("REST/MCP parity, retry, stale version, unknown and tenant/scope failures", async () => {
  const create = {
    operationId: "issue-1",
    issueId: "i1",
    projectId: "p1",
    title: "Issue",
    description: "Text",
    priority: "medium",
  };
  const rest = await req("w1", "issues.create", create, write);
  assert.deepEqual(rest, { status: 200, data: { id: "i1", number: 1, version: 1 } });
  assert.deepEqual(mcpResult(await rpc("w1", "issues.create", create, write)), rest.data);
  const cases = [
    ["issues.create", { ...create, operationId: "bad", title: "" }, "validation"],
    ["issues.get", { issueId: "missing" }, "not_found"],
    [
      "issues.transition",
      { operationId: "stale", issueId: "i1", expectedVersion: 99, state: "done" },
      "conflict",
    ],
  ];
  for (const [name, args, code] of cases) {
    const a = await req("w1", name, args, write);
    const b = await rpc("w1", name, args, write);
    assert.equal(a.data.code, code);
    assert.equal(mcpResult(b).code, code);
    assert.equal(b.data.result.isError, true);
  }
  assert.equal(
    (await req("w1", "issues.create", { ...create, operationId: "denied", issueId: "i2" }, read))
      .data.code,
    "forbidden",
  );
  assert.equal(
    mcpResult(
      await rpc("w1", "issues.create", { ...create, operationId: "denied2", issueId: "i2" }, read),
    ).code,
    "forbidden",
  );
  assert.equal((await req("w2", "issues.get", { issueId: "i1" }, other)).data.code, "not_found");
  assert.equal((await req("w2", "issues.get", { issueId: "i1" }, write)).data.code, "forbidden");
  const unknown = await rpc("w1", "no.such", {}, write);
  assert.equal(unknown.data.error.code, -32601);
  assert.equal((await req("w1", "projects.noSuch", {}, write)).status, 404);
  const mismatch = await mf.dispatchFetch(endpoint("w1", "issues.get") + "?issueId=i1", {
    headers: { authorization: `Bearer ${write}`, "x-workspace-id": "w2" },
  });
  assert.equal(mismatch.status, 403);
});

test("official MCP SDK creates project and issue, comments, edits wiki, searches Japanese", async () => {
  const client = new Client({ name: "gateway-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp/w1"), {
    requestInit: { headers: { authorization: `Bearer ${write}` } },
    fetch: (input, init) =>
      mf.dispatchFetch(typeof input === "string" ? input : input.toString(), init),
  });
  await client.connect(transport);
  const tools = await client.listTools();
  assert(tools.tools.some((t) => t.name === "wiki.search"));
  assert(
    !tools.tools.some(
      (t) => t.name === "access.credential.issue" || t.name === "access.credential.revoke",
    ),
  );
  const call = async (name, args) => {
    const out = await client.callTool({ name, arguments: args });
    assert.equal(out.isError, false, JSON.stringify(out));
    return JSON.parse(out.content[0].text);
  };
  await call("issues.create", {
    operationId: "sdk-issue",
    issueId: "sdki",
    projectId: "sdkp",
    title: "日本語の課題",
    description: "検索対象",
    priority: "medium",
  });
  await call("issues.transition", {
    operationId: "sdk-transition",
    issueId: "sdki",
    expectedVersion: 1,
    state: "in_progress",
  });
  await call("issues.comment", {
    operationId: "sdk-comment",
    issueId: "sdki",
    expectedVersion: 2,
    commentId: "sdkc",
    body: "確認しました",
  });
  await call("wiki.create", {
    operationId: "sdk-page",
    pageId: "sdkpage",
    projectId: "sdkp",
    slug: "guide",
    title: "日本語の手順",
    body: "初版",
  });
  await call("wiki.edit", {
    operationId: "sdk-edit",
    pageId: "sdkpage",
    expectedVersion: 1,
    title: "日本語の手順",
    body: "改訂版",
  });
  assert.equal((await call("wiki.search", { projectId: "sdkp", text: "日本語" }))[0].id, "sdkpage");
  assert.equal((await call("issues.search", { projectId: "sdkp", text: "日本語" }))[0].id, "sdki");
  await client.close();
});

test("human assertion manages workspace and credential over REST; token retry and revoke", async () => {
  const human = async (w, op, input, method = "POST") => {
    const response = await mf.dispatchFetch(endpoint(w, op), {
      method,
      headers: {
        "cf-access-jwt-assertion": ownerAssertion,
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
      },
      ...(method === "POST" ? { body: JSON.stringify(input) } : {}),
    });
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
  const pre = await human("w1", "access.workspaces", {}, "GET");
  assert.equal(pre.status, 200, JSON.stringify(pre.data));
  const discovery = await mf.dispatchFetch("http://localhost/api/me", {
    headers: { "cf-access-jwt-assertion": ownerAssertion },
  });
  assert.equal(discovery.status, 200);
  assert.deepEqual(
    (await discovery.json()).workspaces.map((w) => w.id),
    ["w1"],
  );
  const machineDiscovery = await mf.dispatchFetch("http://localhost/api/me", {
    headers: { authorization: `Bearer ${write}` },
  });
  const machineMe = await machineDiscovery.json();
  assert.deepEqual(
    machineMe.workspaces.map((w) => w.id),
    ["w1"],
  );
  assert.deepEqual(mcpResult(await rpc("w1", "access.me", {}, write)), machineMe);
  assert.equal((await req("w2", "access.members.list", {}, write)).status, 403);
  const memberList = await req("w1", "access.members.list", { limit: 1 }, write);
  assert.equal(memberList.status, 200);
  assert.equal(memberList.data.items.length, 1);
  assert.deepEqual(
    mcpResult(await rpc("w1", "access.members.list", { limit: 1 }, write)),
    memberList.data,
  );
  assert.equal(
    (
      await req(
        "w1",
        "coordination.wipCap.set",
        { projectId: "p1", cap: 2, expectedVersion: 0, operationId: "viewer-cap" },
        read,
      )
    ).status,
    403,
  );
  const workspace = await human("w3", "access.create", {
    operationId: "new-workspace",
    name: "Third",
  });
  assert.equal(workspace.status, 200, JSON.stringify(workspace.data));
  assert.equal(workspace.data.id, "w3");
  const listed = await human("w1", "access.workspaces", {}, "GET");
  assert.equal(listed.status, 200);
  assert(listed.data.some((item) => item.id === "w3"));
  const input = {
    operationId: "new-credential",
    principalId: writeMachineId,
    credentialId: "rest-key",
    secret: "c3".repeat(32),
    scope: "read",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
  const issued = await human("w1", "access.credential.issue", input);
  assert.equal(issued.status, 200);
  assert.equal(issued.headers.get("cache-control"), "no-store");
  const retry = await human("w1", "access.credential.issue", input);
  assert.deepEqual(retry.data, issued.data);
  assert.equal(
    (await req("w1", "projects.get", { projectId: "p1" }, issued.data.token)).status,
    200,
  );
  const revoked = await human("w1", "access.credential.revoke", {
    operationId: "revoke-rest-key",
    credentialId: "rest-key",
    expectedVersion: 1,
  });
  assert.equal(revoked.status, 200);
  assert.equal(
    (await req("w1", "projects.get", { projectId: "p1" }, issued.data.token)).status,
    403,
  );
  const forbidden = await req("w1", "access.credential.issue", input, write);
  assert.equal(forbidden.status, 403);
  const listedTools = await rpc("w1", "access.credential.issue", input, write);
  assert.equal(listedTools.data.error.code, -32601);
});

test("transport limits, request IDs and generated descriptions", async () => {
  const url = endpoint("w1", "issues.create");
  const headers = { authorization: `Bearer ${write}` };
  const wrongType = await mf.dispatchFetch(url, {
    method: "POST",
    headers: { ...headers, "content-type": "text/plain" },
    body: "{}",
  });
  assert.equal(wrongType.status, 400);
  assert.equal((await wrongType.clone().json()).message, "Expected application/json");
  assert(wrongType.headers.get("x-request-id"));
  const oversized = await mf.dispatchFetch(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ body: "x".repeat(65536) }),
  });
  assert.equal(oversized.status, 400);
  assert.match((await oversized.json()).message, /too large/);
  const foreignOrigin = await mf.dispatchFetch(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json", origin: "https://attacker.example" },
    body: "{}",
  });
  assert.equal(foreignOrigin.status, 403);
  const getMcp = await mf.dispatchFetch("http://localhost/mcp/w1", { method: "GET" });
  assert.equal(getMcp.status, 401);
  assert.equal((await mf.dispatchFetch("http://localhost/mcp/w1", { headers })).status, 405);
  const openapi = await (await mf.dispatchFetch("http://localhost/api/openapi.json")).json();
  assert(openapi.paths["/api/w/{workspaceId}/issues/create"].post);
  assert(openapi.paths["/api/w/{workspaceId}/wiki/search"].get);
  const mismatchBody = await req(
    "w1",
    "issues.create",
    {
      operationId: "bad-workspace",
      workspaceId: "w2",
      issueId: "bad",
      projectId: "p1",
      title: "Bad",
      description: "",
      priority: "medium",
    },
    write,
  );
  assert.equal(mismatchBody.status, 400);
});

test("two MCP SDK agents contend for issue and exact file claims", async () => {
  const created = await req(
    "w1",
    "issues.create",
    {
      operationId: "coord-issue",
      issueId: "coord-i",
      projectId: "p1",
      title: "Shared work",
      description: "",
      priority: "medium",
    },
    write,
  );
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const clients = await Promise.all(
    ["agent-a", "agent-b"].map(async (name) => {
      const client = new Client({ name, version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp/w1"), {
        requestInit: { headers: { authorization: `Bearer ${write}` } },
        fetch: (input, init) =>
          mf.dispatchFetch(typeof input === "string" ? input : input.toString(), init),
      });
      await client.connect(transport);
      return client;
    }),
  );
  const call = async (client, name, args) => {
    const out = await client.callTool({ name, arguments: args });
    return { error: out.isError === true, data: JSON.parse(out.content[0].text) };
  };
  try {
    const tools = await clients[0].listTools();
    assert.match(
      tools.tools.find((t) => t.name === "coordination.acquire").description,
      /start session.*acquire issue lease.*claim exact repo paths/i,
    );
    for (let i = 0; i < 2; i++)
      assert.equal(
        (
          await call(clients[i], "coordination.start", {
            operationId: `sdk-start-${i}`,
            sessionId: `sdk-${i}`,
            agentLabel: `agent-${i}`,
            clientKind: i === 0 ? "codex" : "claude-code",
            repo: "repo",
          })
        ).error,
        false,
      );
    const results = await Promise.all(
      clients.map((c, i) =>
        call(c, "coordination.acquire", {
          operationId: `sdk-acq-${i}`,
          sessionId: `sdk-${i}`,
          issueId: "coord-i",
        }),
      ),
    );
    assert.equal(results.filter((x) => !x.error).length, 1, JSON.stringify(results));
    const winner = results[0].error ? 1 : 0,
      loser = 1 - winner,
      token = results[winner].data.fencingToken;
    assert.equal(
      (
        await call(clients[winner], "coordination.claim", {
          operationId: "sdk-claim",
          sessionId: `sdk-${winner}`,
          repo: "repo",
          paths: ["src/a.ts", "src/b.ts"],
          leaseIssueId: "coord-i",
          fencingToken: token,
        })
      ).error,
      false,
    );
    const denied = await call(clients[loser], "coordination.claim", {
      operationId: "sdk-denied",
      sessionId: `sdk-${loser}`,
      repo: "repo",
      paths: ["src/c.ts", "src/a.ts"],
    });
    assert.equal(denied.error, true);
    assert.equal(denied.data.code, "conflict");
    const progress = await call(clients[winner], "coordination.report", {
      operationId: "sdk-progress",
      sessionId: `sdk-${winner}`,
      issueId: "coord-i",
      fencingToken: token,
      text: "Working",
      status: "in_progress",
    });
    assert.equal(progress.error, false, JSON.stringify(progress));
    for (const name of [
      "projectSessions",
      "projectLeases",
      "projectProgress",
      "projectClaims",
      "wipCap",
    ]) {
      const operation = `coordination.${name}`;
      const args = { projectId: "p1" };
      const rest = await req("w1", operation, args, write);
      assert.equal(rest.status, 200, JSON.stringify(rest));
      assert.deepEqual((await call(clients[loser], operation, args)).data, rest.data);
    }
    assert.equal(
      (await call(clients[loser], "coordination.projectLeases", { projectId: "p1" })).data.items[0]
        .sessionId,
      `sdk-${winner}`,
    );
    assert.equal(
      (await call(clients[loser], "coordination.projectProgress", { projectId: "p1" })).data
        .items[0].text,
      "Working",
    );
    assert.equal(
      (await req("w2", "coordination.projectLeases", { projectId: "p1" }, write)).data.code,
      "forbidden",
    );
    assert.equal(
      (await req("w1", "coordination.getProgress", { issueId: "coord-i" }, write)).data.text,
      "Working",
    );
    const historyArgs = { issueId: "coord-i", limit: 1 };
    const history = await req("w1", "coordination.listProgress", historyArgs, write);
    assert.equal(history.status, 200);
    assert.equal(history.data.items[0].text, "Working");
    assert.equal(history.data.items[0].sequence, 1);
    assert.equal(history.data.nextCursor, null);
    assert.deepEqual(
      (await call(clients[winner], "coordination.listProgress", historyArgs)).data,
      history.data,
    );
    assert.equal((await req("w1", "issues.get", { issueId: "coord-i" }, write)).data.state, "todo");
    const events = await req("w1", "coordination.readEvents", { cursor: 0 }, write);
    assert.equal(events.status, 200);
    assert(events.data.some((event) => event.type === "ProgressReported"));
    assert.deepEqual(
      (await call(clients[winner], "coordination.readEvents", { cursor: 0 })).data,
      events.data,
    );
    assert.equal(
      (
        await call(clients[winner], "coordination.releaseFiles", {
          operationId: "sdk-release-files",
          sessionId: `sdk-${winner}`,
          repo: "repo",
          paths: ["src/a.ts", "src/b.ts"],
        })
      ).error,
      false,
    );
    assert.equal(
      (
        await call(clients[winner], "coordination.release", {
          operationId: "sdk-release",
          sessionId: `sdk-${winner}`,
          issueId: "coord-i",
          fencingToken: token,
        })
      ).error,
      false,
    );
  } finally {
    await Promise.all(clients.map((c) => c.close()));
  }
});

test("audit real providers satisfy Coordination authorization contract", async () => {
  const f = contractProviders;
  await f.issues.createIssue(f.editor, {
    operationId: "contract-issue",
    issueId: f.issueId,
    projectId: f.projectId,
    title: "Contract",
    description: "",
    priority: "medium",
  });
  await coordinationProviderContract(f);
});

test("07c /api/me never provisions membership for an authenticated stranger", async () => {
  const db = await mf.getD1Database("DB");
  const before = await db.prepare("SELECT COUNT(*) AS n FROM access_memberships").first();
  const response = await mf.dispatchFetch("http://localhost/api/me", {
    headers: { "cf-access-jwt-assertion": unjoinedAssertion },
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).workspaces, []);
  assert.deepEqual(
    await db.prepare("SELECT COUNT(*) AS n FROM access_memberships").first(),
    before,
  );
});

test("Assets binary REST and MCP metadata parity with live download authorization", async () => {
  const data = new TextEncoder().encode("asset transport");
  const sha256 = Buffer.from(await crypto.subtle.digest("SHA-256", data)).toString("hex");
  const created = await req(
    "w1",
    "issues.create",
    {
      operationId: "asset-issue-create",
      issueId: "asset-issue",
      projectId: "p1",
      title: "With attachment",
      description: "",
      priority: "medium",
    },
    write,
  );
  assert.equal(created.status, 200);
  const beginArgs = {
    operationId: "asset-begin",
    assetId: "asset-transport",
    projectId: "p1",
    size: data.length,
    contentType: "text/plain",
    filename: "asset.txt",
    sha256,
  };
  const begin = await req("w1", "assets.begin", beginArgs, write);
  assert.deepEqual(begin.data, { id: "asset-transport", version: 1 });
  assert.deepEqual(mcpResult(await rpc("w1", "assets.begin", beginArgs, write)), begin.data);
  const put = await mf.dispatchFetch("http://localhost/api/w/w1/assets/upload/asset-transport", {
    method: "PUT",
    headers: { authorization: `Bearer ${write}`, "content-type": "application/octet-stream" },
    body: data,
  });
  assert.equal(put.status, 200);
  const completeArgs = {
    operationId: "asset-complete",
    assetId: "asset-transport",
    expectedVersion: 1,
  };
  const complete = await req("w1", "assets.complete", completeArgs, write);
  assert.deepEqual(complete.data, { id: "asset-transport", version: 2 });
  assert.deepEqual(
    mcpResult(await rpc("w1", "assets.complete", completeArgs, write)),
    complete.data,
  );
  const linkArgs = {
    operationId: "asset-link",
    assetId: "asset-transport",
    expectedVersion: 2,
    linkId: "asset-link-id",
    targetKind: "issue",
    targetId: "asset-issue",
  };
  const linked = await req("w1", "assets.link", linkArgs, write);
  assert.deepEqual(linked.data, { id: "asset-transport", version: 3 });
  assert.deepEqual(mcpResult(await rpc("w1", "assets.link", linkArgs, write)), linked.data);
  const listArgs = { targetKind: "issue", targetId: "asset-issue" };
  const rest = await req("w1", "assets.list", listArgs, read);
  const mcp = await rpc("w1", "assets.list", listArgs, read);
  assert.deepEqual(mcpResult(mcp), rest.data);
  const metaArgs = { assetId: "asset-transport" };
  assert.deepEqual(
    mcpResult(await rpc("w1", "assets.get", metaArgs, read)),
    (await req("w1", "assets.get", metaArgs, read)).data,
  );
  const receiptArgs = { operationId: "asset-link" };
  assert.deepEqual(
    mcpResult(await rpc("w1", "assets.readOperation", receiptArgs, write)),
    (await req("w1", "assets.readOperation", receiptArgs, write, "GET")).data,
  );
  const url = mcpResult(
    await rpc("w1", "assets.downloadUrl", { assetId: "asset-transport" }, read),
  ).url;
  assert.equal(url, "/api/w/w1/assets/download/asset-transport");
  assert.deepEqual(
    mcpResult(await rpc("w1", "assets.downloadUrl", metaArgs, read)),
    (await req("w1", "assets.downloadUrl", metaArgs, read)).data,
  );
  const download = await mf.dispatchFetch(`http://localhost${url}`, {
    headers: { authorization: `Bearer ${read}` },
  });
  assert.equal(download.status, 200);
  assert.equal(await download.text(), "asset transport");
  assert.match(download.headers.get("content-disposition"), /asset\.txt/);
  const wrong = await mf.dispatchFetch(
    "http://localhost/api/w/w2/assets/download/asset-transport",
    { headers: { authorization: `Bearer ${other}` } },
  );
  assert.equal(wrong.status, 404);
  const unlinkArgs = {
    operationId: "asset-unlink",
    assetId: "asset-transport",
    expectedVersion: 3,
    linkId: "asset-link-id",
  };
  const unlinked = await req("w1", "assets.unlink", unlinkArgs, write);
  assert.equal(unlinked.status, 200);
  assert.deepEqual(mcpResult(await rpc("w1", "assets.unlink", unlinkArgs, write)), unlinked.data);
  const after = await mf.dispatchFetch(`http://localhost${url}`, {
    headers: { authorization: `Bearer ${read}` },
  });
  assert.notEqual(after.status, 200);
  const openapi = await (await mf.dispatchFetch("http://localhost/api/openapi.json")).json();
  assert(openapi.paths["/api/w/{workspaceId}/assets/upload/{assetId}"].put);
  assert(openapi.paths["/api/w/{workspaceId}/assets/download/{assetId}"].get);
  const tools = await mf.dispatchFetch("http://localhost/mcp/w1", {
    method: "POST",
    headers: {
      authorization: `Bearer ${read}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const names = (await tools.json()).result.tools.map((x) => x.name);
  assert(!names.includes("assets.uploadBinary"));
  assert(!names.includes("assets.downloadBinary"));
});

async function auditAsset(id, contentType = "text/html") {
  const body = "<script>globalThis.assetExecuted=true</script>";
  const begin = {
    operationId: `${id}-begin`,
    assetId: id,
    projectId: "p1",
    size: Buffer.byteLength(body),
    contentType,
    filename: `${id}.html`,
    sha256: Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)),
    ).toString("hex"),
  };
  assert.equal((await req("w1", "assets.begin", begin, write)).status, 200);
  assert.equal(
    (
      await mf.dispatchFetch(`http://localhost/api/w/w1/assets/upload/${id}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${write}` },
        body,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await req(
        "w1",
        "assets.complete",
        { operationId: `${id}-complete`, assetId: id, expectedVersion: 1 },
        write,
      )
    ).status,
    200,
  );
  const issueId = `${id}-issue`;
  assert.equal(
    (
      await req(
        "w1",
        "issues.create",
        {
          operationId: `${id}-issue`,
          issueId,
          projectId: "p1",
          title: "Audit attachment",
          description: "",
          priority: "medium",
        },
        write,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await req(
        "w1",
        "assets.link",
        {
          operationId: `${id}-link`,
          assetId: id,
          expectedVersion: 2,
          linkId: `${id}-link`,
          targetKind: "issue",
          targetId: issueId,
        },
        write,
      )
    ).status,
    200,
  );
  return { body, begin, url: `/api/w/w1/assets/download/${id}` };
}

test("09a HTML and SVG download as attachments with nosniff; MCP returns only a relative URL", async () => {
  for (const [id, mime] of [
    ["audit-html", "text/html"],
    ["audit-svg", "image/svg+xml"],
  ]) {
    const { body, url } = await auditAsset(id, mime);
    const response = await mf.dispatchFetch(`http://localhost${url}`, {
      headers: { authorization: `Bearer ${read}` },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), mime);
    assert.match(response.headers.get("content-disposition"), /^attachment; filename\*=UTF-8''/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.match(response.headers.get("cache-control"), /no-store/);
    assert.equal(await response.text(), body);
    const result = (await rpc("w1", "assets.downloadUrl", { assetId: id }, read)).data.result;
    assert.equal(result.isError, false);
    assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify({ url }) }]);
    assert.equal(JSON.stringify(result).includes(body), false);
  }
});

test("09a issued download URL rechecks permission at stream request after target archive", async () => {
  const { url } = await auditAsset("audit-live");
  assert.deepEqual(
    mcpResult(await rpc("w1", "assets.downloadUrl", { assetId: "audit-live" }, read)),
    { url },
  );
  assert.equal(
    (
      await req(
        "w1",
        "issues.archive",
        { operationId: "audit-archive", issueId: "audit-live-issue", expectedVersion: 1 },
        write,
      )
    ).status,
    200,
  );
  const response = await mf.dispatchFetch(`http://localhost${url}`, {
    headers: { authorization: `Bearer ${read}` },
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "forbidden");
});

test("09a read-scoped machine cannot begin complete link unlink or PUT an upload", async () => {
  const { begin } = await auditAsset("audit-read-scope");
  for (const [name, args] of [
    ["assets.begin", { ...begin, operationId: "read-begin", assetId: "read-denied" }],
    [
      "assets.complete",
      { operationId: "read-complete", assetId: begin.assetId, expectedVersion: 3 },
    ],
    [
      "assets.link",
      {
        operationId: "read-link",
        assetId: begin.assetId,
        expectedVersion: 3,
        linkId: "read-link",
        targetKind: "issue",
        targetId: "audit-read-scope-issue",
      },
    ],
    [
      "assets.unlink",
      {
        operationId: "read-unlink",
        assetId: begin.assetId,
        expectedVersion: 3,
        linkId: "audit-read-scope-link",
      },
    ],
  ]) {
    const response = await rpc("w1", name, args, read);
    assert.equal(mcpResult(response).code, "forbidden", name);
  }
  const response = await mf.dispatchFetch(
    "http://localhost/api/w/w1/assets/upload/audit-read-scope",
    { method: "PUT", headers: { authorization: `Bearer ${read}` }, body: "denied" },
  );
  assert.equal(response.status, 403);
});

test("09a Worker scheduled GC collects expired incomplete uploads in both workspaces", async () => {
  const db = await mf.getD1Database("DB"),
    bucket = await mf.getR2Bucket("R2");
  for (const [w, token] of [
    ["w1", write],
    ["w2", other],
  ]) {
    const assetId = "audit-expired";
    const input = {
      operationId: "audit-expired",
      assetId,
      projectId: "p1",
      size: 5,
      contentType: "text/plain",
      filename: "pending.txt",
      sha256: Buffer.from(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode("hello")),
      ).toString("hex"),
    };
    assert.equal((await req(w, "assets.begin", input, token)).status, 200);
    assert.equal(
      (
        await mf.dispatchFetch(`http://localhost/api/w/${w}/assets/upload/${assetId}`, {
          method: "PUT",
          headers: { authorization: `Bearer ${token}` },
          body: "hello",
        })
      ).status,
      200,
    );
    await db
      .prepare("UPDATE assets_gc_jobs SET due_at=0 WHERE workspace_id=? AND asset_id=?")
      .bind(w, assetId)
      .run();
  }
  const worker = await mf.getWorker();
  await worker.scheduled();
  for (const w of ["w1", "w2"]) {
    assert.equal((await bucket.get(`assets/${w}/audit-expired`)) === null, true);
    assert.equal(
      await db
        .prepare("SELECT id FROM assets_blobs WHERE workspace_id=? AND id='audit-expired'")
        .bind(w)
        .first(),
      null,
    );
    assert.equal(
      await db
        .prepare(
          "SELECT asset_id FROM assets_gc_jobs WHERE workspace_id=? AND asset_id='audit-expired'",
        )
        .bind(w)
        .first(),
      null,
    );
  }
  await worker.scheduled();
});

test("09a real Access Projects Issues Wiki satisfy Assets provider contract", async () => {
  const f = contractProviders;
  const wiki = platform.createWiki({
    store: platform.createModuleStore(await mf.getD1Database("DB"), "wiki"),
    projects: f.projects,
    clock: { now: () => Math.floor(Date.now() / 1000) },
    ids: platform.randomIds,
  }).api;
  const issueId = "assets-contract-issue",
    pageId = "assets-contract-page";
  await f.issues.createIssue(f.editor, {
    operationId: issueId,
    issueId,
    projectId: f.projectId,
    title: "Contract",
    description: "",
    priority: "medium",
  });
  await wiki.createPage(f.editor, {
    operationId: pageId,
    pageId,
    projectId: f.projectId,
    slug: "assets-contract",
    title: "Contract",
    body: "",
  });
  await assetsProviderContract({ ...f, wiki, issueId, pageId });
});

test("09a binary PUT accepts exactly 10 MiB and rejects one byte more", async () => {
  const data = new Uint8Array(10 * 1024 * 1024);
  const sha256 = Buffer.from(await crypto.subtle.digest("SHA-256", data)).toString("hex");
  const input = {
    operationId: "http-cap",
    assetId: "http-cap",
    projectId: "p1",
    size: data.byteLength,
    contentType: "application/octet-stream",
    filename: "cap.bin",
    sha256,
  };
  assert.equal((await req("w1", "assets.begin", input, write)).status, 200);
  const upload = (body) =>
    mf.dispatchFetch("http://localhost/api/w/w1/assets/upload/http-cap", {
      method: "PUT",
      headers: { authorization: `Bearer ${write}`, "content-length": String(body.byteLength) },
      body,
    });
  assert.equal((await upload(data)).status, 200);
  assert.equal((await upload(new Uint8Array(data.byteLength + 1))).status, 400);
  // Rejected overwrite leaves the original, completable object intact.
  assert.equal(
    (
      await req(
        "w1",
        "assets.complete",
        { operationId: "http-cap-complete", assetId: "http-cap", expectedVersion: 1 },
        write,
      )
    ).status,
    200,
  );
});

test("Planning REST/MCP parity and live archived issue state", async () => {
  const issue = {
    operationId: "planning-issue",
    issueId: "planning-i",
    projectId: "p1",
    title: "Plan me",
    description: "",
    priority: "medium",
  };
  assert.equal((await req("w1", "issues.create", issue, write)).status, 200);
  const created = {
    operationId: "planning-create",
    sprintId: "planning-s",
    projectId: "p1",
    name: "Next batch",
  };
  const rest = await req("w1", "planning.create", created, write);
  assert.equal(rest.status, 200);
  assert.deepEqual(mcpResult(await rpc("w1", "planning.create", created, write)), rest.data);
  const schedule = {
    operationId: "planning-schedule",
    sprintId: "planning-s",
    issueId: "planning-i",
    expectedVersion: 1,
  };
  const scheduled = await req("w1", "planning.schedule", schedule, write);
  assert.equal(scheduled.status, 200);
  assert.deepEqual(
    mcpResult(await rpc("w1", "planning.schedule", schedule, write)),
    scheduled.data,
  );
  const listed = await req("w1", "planning.list", { projectId: "p1" }, read);
  assert.equal(listed.status, 200);
  assert.deepEqual(
    mcpResult(await rpc("w1", "planning.list", { projectId: "p1" }, read)),
    listed.data,
  );
  const items = await req("w1", "planning.items", { sprintId: "planning-s" }, read);
  assert.equal(items.data.items[0].issue.state, "todo");
  assert.deepEqual(
    mcpResult(await rpc("w1", "planning.items", { sprintId: "planning-s" }, read)),
    items.data,
  );
  assert.equal(
    (await req("w2", "planning.items", { sprintId: "planning-s" }, other)).data.code,
    "not_found",
  );
  assert.equal(
    (
      await req(
        "w1",
        "planning.schedule",
        { ...schedule, operationId: "read-only", expectedVersion: 2 },
        read,
      )
    ).data.code,
    "forbidden",
  );
  assert.equal(
    (await req("w1", "planning.schedule", { ...schedule, operationId: "stale" }, write)).data.code,
    "conflict",
  );
  const archived = await req(
    "w1",
    "issues.archive",
    { operationId: "planning-archive", issueId: "planning-i", expectedVersion: 1 },
    write,
  );
  assert.equal(archived.status, 200);
  const after = await req("w1", "planning.items", { sprintId: "planning-s" }, read);
  assert.equal(after.data.items[0].archived, true);
  assert.equal(after.data.items[0].issue.title, "Plan me");
  const closed = await req(
    "w1",
    "planning.close",
    { operationId: "planning-close", sprintId: "planning-s", expectedVersion: 2 },
    write,
  );
  assert.equal(closed.status, 200);
  assert.equal(
    (await req("w1", "planning.items", { sprintId: "planning-s" }, read)).data.items.length,
    1,
  );
  const db = await mf.getD1Database("DB");
  assert.equal(
    (
      await db
        .prepare("SELECT version FROM issues_issues WHERE workspace_id='w1' AND id='planning-i'")
        .first()
    ).version,
    2,
  );
});

test("archived project keeps sprint and live issue details read-only", async () => {
  const f = contractProviders;
  await f.projects.createProject(f.manager, {
    operationId: "planning-project-create",
    projectId: "planning-arch-p",
    key: "PLANARCH",
    name: "Archived project",
  });
  await f.issues.createIssue(f.manager, {
    operationId: "planning-project-issue",
    issueId: "planning-arch-i",
    projectId: "planning-arch-p",
    title: "Historical task",
    description: "",
    priority: "medium",
  });
  const call = async (name, args, method = args.operationId ? "POST" : "GET") => {
    const url = new URL(endpoint("w1", name));
    if (method === "GET")
      for (const [k, v] of Object.entries(args)) url.searchParams.set(k, String(v));
    const response = await mf.dispatchFetch(url.toString(), {
      method,
      headers: {
        "cf-access-jwt-assertion": ownerAssertion,
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
      },
      ...(method === "POST" ? { body: JSON.stringify(args) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  assert.equal(
    (
      await call("planning.create", {
        operationId: "planning-arch-create",
        sprintId: "planning-arch-s",
        projectId: "planning-arch-p",
        name: "Old sprint",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call("planning.schedule", {
        operationId: "planning-arch-schedule",
        sprintId: "planning-arch-s",
        issueId: "planning-arch-i",
        expectedVersion: 1,
      })
    ).status,
    200,
  );
  await f.projects.archiveProject(f.manager, {
    operationId: "planning-project-archive",
    projectId: "planning-arch-p",
    expectedVersion: 1,
  });
  const item = await call("planning.items", { sprintId: "planning-arch-s" });
  assert.equal(item.status, 200);
  assert.equal(item.data.sprint.archived, true);
  assert.equal(item.data.items[0].issue.title, "Historical task");
  assert.equal(item.data.items[0].archived, true);
  assert.equal(
    (
      await call("planning.unschedule", {
        operationId: "planning-arch-denied",
        sprintId: "planning-arch-s",
        issueId: "planning-arch-i",
        expectedVersion: 2,
      })
    ).data.code,
    "not_found",
  );
});

test("10a Planning REST and MCP deny project viewers and read credentials; events stay private", async () => {
  const { projects, issues, manager } = contractProviders;
  await projects.createProject(manager, {
    operationId: "audit-project",
    projectId: "audit-project",
    name: "Audit",
    key: "AUDIT",
  });
  await projects.grantProjectRole(manager, {
    operationId: "audit-viewer",
    projectId: "audit-project",
    principalId: writeMachineId,
    role: "viewer",
    expectedVersion: 1,
  });
  await issues.createIssue(manager, {
    operationId: "audit-issue",
    issueId: "audit-issue",
    projectId: "audit-project",
    title: "Audit",
    description: "",
    priority: "medium",
  });
  const created = await mf.dispatchFetch(endpoint("w1", "planning.create"), {
    method: "POST",
    headers: { "cf-access-jwt-assertion": ownerAssertion, "content-type": "application/json" },
    body: JSON.stringify({
      operationId: "audit-sprint",
      sprintId: "audit-sprint",
      projectId: "audit-project",
      name: "Audit",
    }),
  });
  assert.equal(created.status, 200);
  for (const token of [write, read]) {
    const input = {
      operationId: `audit-${token === write ? "viewer" : "read"}-schedule`,
      sprintId: "audit-sprint",
      issueId: "audit-issue",
      expectedVersion: 1,
    };
    assert.equal((await req("w1", "planning.schedule", input, token)).data.code, "forbidden");
    assert.equal(mcpResult(await rpc("w1", "planning.schedule", input, token)).code, "forbidden");
  }
  assert.equal(
    (await req("w1", "planning.items", { sprintId: "audit-sprint" }, write)).data.items.length,
    0,
  );
  const args = { workspaceId: "w1", cursor: 0, limit: 10 };
  assert.equal((await req("w1", "planning.readEvents", args, write)).status, 404);
  assert.equal((await rpc("w1", "planning.readEvents", args, write)).data.error?.code, -32601);
});

test("10a Planning page cursor and limit cross REST and MCP with live issue updates", async () => {
  for (const [id, op, args] of [
    [
      "a",
      "issues.create",
      { issueId: "page-a", projectId: "p1", title: "Page A", description: "", priority: "medium" },
    ],
    [
      "b",
      "issues.create",
      { issueId: "page-b", projectId: "p1", title: "Page B", description: "", priority: "medium" },
    ],
    ["s", "planning.create", { sprintId: "page-s", projectId: "p1", name: "Pages" }],
    ["sa", "planning.schedule", { sprintId: "page-s", issueId: "page-a", expectedVersion: 1 }],
    ["sb", "planning.schedule", { sprintId: "page-s", issueId: "page-b", expectedVersion: 2 }],
  ])
    assert.equal((await req("w1", op, { operationId: `page-${id}`, ...args }, write)).status, 200);
  for (const call of [
    async (args) => (await req("w1", "planning.items", args, read)).data,
    async (args) => mcpResult(await rpc("w1", "planning.items", args, read)),
  ]) {
    const first = await call({ sprintId: "page-s", limit: 1 });
    assert.deepEqual(
      first.items.map((i) => i.issueId),
      ["page-a"],
    );
    assert.equal(first.nextCursor, "page-a");
    const last = await call({ sprintId: "page-s", limit: 1, cursor: first.nextCursor });
    assert.deepEqual(
      last.items.map((i) => i.issueId),
      ["page-b"],
    );
    assert.equal(last.nextCursor, null);
    assert.equal((await call({ sprintId: "page-s", limit: 101 })).code, "validation");
  }
  assert.equal(
    (
      await req(
        "w1",
        "issues.transition",
        {
          operationId: "page-transition",
          issueId: "page-a",
          expectedVersion: 1,
          state: "in_progress",
        },
        write,
      )
    ).status,
    200,
  );
  assert.equal(
    (await req("w1", "planning.items", { sprintId: "page-s", limit: 1 }, read)).data.items[0].issue
      .state,
    "in_progress",
  );
});

test("Insights REST and MCP expose the same scoped feed, metrics and markers", async () => {
  const issue = {
    operationId: "insights-create",
    issueId: "insights-i",
    projectId: "p1",
    title: "Insight task",
    description: "",
    priority: "medium",
  };
  assert.equal((await req("w1", "issues.create", issue, write)).status, 200);
  const activity = (await req("w1", "insights.activity", { projectId: "p1", limit: 10 }, read))
    .data;
  assert(activity.items.some((item) => item.entityId === "insights-i"));
  assert.deepEqual(
    mcpResult(await rpc("w1", "insights.activity", { projectId: "p1", limit: 10 }, read)),
    activity,
  );
  const metrics = (await req("w1", "insights.metrics", { projectId: "p1" }, read)).data;
  assert(metrics.todo >= 1);
  assert.deepEqual(
    mcpResult(await rpc("w1", "insights.metrics", { projectId: "p1" }, read)),
    metrics,
  );
  const subscription = { operationId: "insights-watch", issueId: "insights-i", expectedVersion: 0 };
  const watched = (await req("w1", "insights.subscribe", subscription, write)).data;
  assert.equal(watched.active, true);
  assert.deepEqual(mcpResult(await rpc("w1", "insights.subscribe", subscription, write)), watched);
  const notifications = (await req("w1", "insights.notifications", {}, read)).data;
  assert.deepEqual(mcpResult(await rpc("w1", "insights.notifications", {}, read)), notifications);
  assert(
    !(await req("w2", "insights.activity", { projectId: "p1" }, other)).data.items.some(
      (item) => item.entityId === "insights-i",
    ),
  );
});

test("11a background consumption and discovery are unreachable through REST and MCP", async () => {
  for (const token of [read, write]) {
    for (const name of [
      "insights.consumeEvents",
      "insights.drainKnownWorkspaces",
      "access.listActiveWorkspaceIds",
    ]) {
      const args = { workspaceId: "w1", limit: 100 };
      assert.equal((await req("w1", name, args, token, "POST")).status, 404);
      assert.equal((await rpc("w1", name, args, token)).data.error?.code, -32601);
    }
  }
});

test("11a Insights provider read contract matches real owners", async () => {
  const f = contractProviders,
    issueId = "insights-contract-archive";
  await f.issues.createIssue(f.editor, {
    operationId: "insights-contract-create",
    issueId,
    projectId: "p1",
    title: "Contract",
    description: "",
    priority: "medium",
  });
  await insightsProviderContract({
    ...f,
    scope: f.editor,
    issueId,
    archiveIssue: () =>
      f.issues.archiveIssue(f.editor, {
        operationId: "insights-contract-archive",
        issueId,
        expectedVersion: 1,
      }),
  });
});

test("Integrations REST/MCP parity and public signed feedback intake", async () => {
  const link = {
    operationId: "int-link-1",
    refId: "int-ref-1",
    targetKind: "issue",
    targetId: "i1",
    kind: "github_issue",
    url: "https://github.com/example/project/issues/1",
  };
  const linked = await req("w1", "integrations.link", link, write);
  assert.equal(linked.status, 200, JSON.stringify(linked.data));
  const refs = (
    await req("w1", "integrations.links", { targetKind: "issue", targetId: "i1" }, read)
  ).data;
  assert.deepEqual(
    mcpResult(await rpc("w1", "integrations.links", { targetKind: "issue", targetId: "i1" }, read)),
    refs,
  );
  assert(refs.items.some((x) => x.id === link.refId));
  assert.equal(
    (await req("w2", "integrations.links", { targetKind: "issue", targetId: "i1" }, other)).data
      .code,
    "not_found",
  );
  const sourceResponse = await mf.dispatchFetch(endpoint("w1", "integrations.source.register"), {
    method: "POST",
    headers: { "cf-access-jwt-assertion": ownerAssertion, "content-type": "application/json" },
    body: JSON.stringify({
      operationId: "int-source-op",
      sourceId: "int-source",
      projectId: "p1",
      name: "Form",
    }),
  });
  assert.equal(sourceResponse.status, 200);
  const source = await sourceResponse.json();
  assert.match(source.secret, /^[0-9a-f]{64}$/);
  assert.equal(
    (await rpc("w1", "integrations.source.register", {}, write)).data.error?.code,
    -32601,
  );
  const body = JSON.stringify({ title: "Reported issue", body: "Feedback body" });
  const timestamp = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(source.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = Buffer.from(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${timestamp}.delivery-1.${body}`),
    ),
  ).toString("hex");
  const received = await mf.dispatchFetch("http://localhost/integrations/feedback/w1/int-source", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-projektor-timestamp": String(timestamp),
      "x-projektor-delivery-id": "delivery-1",
      "x-projektor-signature": signature,
    },
    body,
  });
  assert.equal(received.status, 200);
  const feedbackId = (await received.json()).id;
  const feedback = (await req("w1", "integrations.feedback", {}, read)).data;
  assert.deepEqual(mcpResult(await rpc("w1", "integrations.feedback", {}, read)), feedback);
  assert(feedback.items.some((x) => x.id === feedbackId));
  const converted = await req(
    "w1",
    "integrations.convert",
    { operationId: "int-convert-op", feedbackId, expectedVersion: 1 },
    write,
  );
  assert.equal(converted.status, 200, JSON.stringify(converted.data));
  assert.equal(
    (await req("w1", "issues.get", { issueId: converted.data.issueId }, read)).status,
    200,
  );
});
