import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { build } from "esbuild";
import { createFetchMock, Miniflare } from "miniflare";

let mf, platform, write, read, other, ownerAssertion, writeMachineId;
const issuer = "https://unit.cloudflareaccess.com";
const audience = "projektor-test";
const b64 = (x) => Buffer.from(JSON.stringify(x)).toString("base64url");
const endpoint = (w, op) => `http://localhost/api/w/${w}/${op.replace(".", "/")}`;
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
    bindings: { ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUDIENCE: audience },
  });
  const db = await mf.getD1Database("DB");
  await platform.migrate(db, ["access", "projects", "issues", "wiki", "coordination"]);
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
    assert.equal(
      (await req("w1", "coordination.getProgress", { issueId: "coord-i" }, write)).data.text,
      "Working",
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
