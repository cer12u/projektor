import assert from "node:assert/strict";
import { before, test } from "node:test";
import { build } from "esbuild";

let createOAuthHttp, createRateLimiter;
before(async () => {
  await build({
    entryPoints: ["tools/test-entry.ts"],
    outfile: ".tmp/test-entry.mjs",
    bundle: true,
    format: "esm",
    platform: "node",
  });
  ({ createOAuthHttp, createRateLimiter } = await import("../.tmp/test-entry.mjs"));
});
const issuer = "https://projektor.example";
function fixture(overrides = {}) {
  let now = 1000,
    registrations = 0,
    exchanges = 0;
  const api = {
    getProtectedResourceMetadata: () => ({
      resource: `${issuer}/mcp`,
      authorization_servers: [issuer],
      scopes_supported: ["read", "write"],
      bearer_methods_supported: ["header"],
    }),
    registerOAuthClient: async (input) => {
      registrations++;
      return {
        ...input,
        client_id: "client",
        client_id_issued_at: now,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
        scope: "read",
      };
    },
    exchangeOAuthToken: async () => {
      exchanges++;
      return { access_token: "test", token_type: "Bearer", expires_in: 300, scope: "read" };
    },
    ...overrides,
  };
  const config = {
    issuer,
    resource: `${issuer}/mcp`,
    formSecret: "x".repeat(32),
    clock: { now: () => now },
    registerLimit: { allow: async () => registrations < 10 },
    tokenLimit: { allow: async () => exchanges < 60 },
  };
  const handle = createOAuthHttp(config, api);
  const post = (path, body, type = "application/x-www-form-urlencoded", headers = {}) =>
    handle(
      new Request(issuer + path, {
        method: "POST",
        headers: { "content-type": type, ...headers },
        body,
      }),
    );
  return {
    handle,
    post,
    config,
    api,
    nextMinute: () => {
      now += 60;
    },
    counts: () => ({ registrations, exchanges }),
  };
}
test("provider-contract fake: Platform rate denial prevents Access calls and admission permits them", async () => {
  const f = fixture();
  const registration = JSON.stringify({ redirect_uris: ["https://client.example/callback"] });
  for (let n = 0; n < 10; n++)
    assert.equal((await f.post("/oauth/register", registration, "application/json")).status, 201);
  assert.equal((await f.post("/oauth/register", registration, "application/json")).status, 429);
  const token = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: "client",
    resource: `${issuer}/mcp`,
    code: "test",
    code_verifier: "test",
    redirect_uri: "https://client.example/callback",
  });
  for (let n = 0; n < 60; n++) assert.equal((await f.post("/oauth/token", token)).status, 200);
  assert.equal((await f.post("/oauth/token", token)).status, 429);
  assert.deepEqual(f.counts(), { registrations: 10, exchanges: 60 });
  f.config.registerLimit.allow = async () => true;
  f.config.tokenLimit.allow = async () => true;
  assert.equal((await f.post("/oauth/token", token)).status, 200);
  assert.equal((await f.post("/oauth/register", registration, "application/json")).status, 201);
});
test("provider-contract fake: parser rejects ambiguous, unsupported and oversized input before Access", async () => {
  const f = fixture();
  for (const body of [
    "resource=a&resource=b",
    "grant_type=authorization_code&response_mode=fragment",
    "client_id=a&client_id=b",
    `grant_type=${"x".repeat(32768)}`,
  ])
    assert.equal((await f.post("/oauth/token", body)).status, 400);
  assert.equal((await f.post("/oauth/token", "{}", "application/json")).status, 400);
  assert.equal(
    (
      await f.post("/oauth/token", "grant_type=authorization_code", undefined, {
        authorization: "Basic x",
      })
    ).status,
    400,
  );
  assert.equal(
    (await f.post("/oauth/register", '{"redirect_uris":"bad"}', "application/json")).status,
    400,
  );
  assert.equal(
    (await f.post("/oauth/token", "grant_type=client_credentials").then((x) => x.json())).error,
    "unsupported_grant_type",
  );
  assert.deepEqual(f.counts(), { registrations: 0, exchanges: 0 });
});
test("provider-contract fake: backend uncertainty is sanitized 503, origin and incomplete config fail closed", async () => {
  const f = fixture({
    revokeOAuthToken: async () => {
      throw new Error("secret backend detail");
    },
  });
  const failed = await f.post("/oauth/revoke", "client_id=client&token=opaque");
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get("cache-control"), "no-store");
  assert.deepEqual(await failed.json(), { error: "temporarily_unavailable" });
  assert.equal(
    (await f.handle(new Request("https://evil.example/.well-known/oauth-protected-resource")))
      .status,
    400,
  );
  assert.throws(() => createOAuthHttp({ ...f.config, resource: `${issuer}/mcp/w1` }, f.api));
  assert.throws(() => createOAuthHttp({ ...f.config, formSecret: "short" }, f.api));
});

test("Platform limiter adapter and Gateway preserve bounded source keys and fail closed", async () => {
  const keys = [];
  const limiter = createRateLimiter({
    limit: async ({ key }) => {
      keys.push(key);
      return { success: key === "198.51.100.8" };
    },
  });
  assert.equal(await limiter.allow("198.51.100.8"), true);
  assert.equal(await limiter.allow("unknown"), false);
  await assert.rejects(limiter.allow(""));
  await assert.rejects(limiter.allow("x".repeat(129)));
  assert.deepEqual(keys, ["198.51.100.8", "unknown"]);
  const f = fixture();
  f.config.registerLimit.allow = limiter.allow;
  const input = JSON.stringify({ redirect_uris: ["https://client.example/callback"] });
  assert.equal(
    (
      await f.post("/oauth/register", input, "application/json", {
        "cf-connecting-ip": "198.51.100.8",
      })
    ).status,
    201,
  );
  assert.equal((await f.post("/oauth/register", input, "application/json")).status, 429);
  f.config.registerLimit.allow = async () => {
    throw new Error("limiter unavailable");
  };
  assert.equal((await f.post("/oauth/register", input, "application/json")).status, 503);
});

test("audit Gateway guards before dispatch and sanitizes internal errors on REST and MCP", async () => {
  const { handleHttp, PlatformError } = await import("../.tmp/test-entry.mjs");
  let writes = 0,
    reads = 0,
    thrown;
  const services = {
    oauthOrigin: issuer,
    access: {
      authenticate: async (input) => ({ kind: input.kind }),
      requireMembership: async (_actor, w, _id, mode) => {
        if (mode === "write") throw new PlatformError("forbidden", "read only");
        return { workspaceId: w };
      },
    },
    issues: {
      getIssue: async () => {
        reads++;
        if (thrown) throw thrown;
        return { id: "issue" };
      },
      createIssue: async () => {
        writes++;
        return { id: "unexpected" };
      },
    },
  };
  const request = (path, headers = {}, body) =>
    handleHttp(
      new Request(issuer + path, {
        method: body ? "POST" : "GET",
        headers: {
          authorization: "Bearer pt1.fake",
          "content-type": "application/json",
          ...headers,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      services,
    );
  const get = "/api/w/w1/issues/get?issueId=issue";
  for (const [headers, status] of [
    [{ "cf-access-jwt-assertion": "signed" }, 400],
    [{ "x-workspace-id": "w2" }, 403],
    [{ origin: "https://evil.example" }, 403],
  ]) {
    assert.equal((await request(get, headers)).status, status);
    assert.equal(reads, 0);
  }
  assert.equal((await request(get, { authorization: "Bearer oauth-token" })).status, 200);
  assert.equal(reads, 1);
  const args = {
    operationId: "op",
    issueId: "new",
    projectId: "p",
    title: "new",
    description: "",
    priority: "medium",
  };
  const rpc = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "issues.create", arguments: args },
  };
  const response = await request("/mcp/w1", { accept: "application/json, text/event-stream" }, rpc);
  assert.equal((await response.json()).result.isError, true);
  assert.equal(writes, 0);
  const badType = await request(
    "/mcp/w1",
    { accept: "application/json, text/event-stream", "content-type": "text/plain" },
    rpc,
  );
  assert.equal(badType.status, 400);
  for (const error of [
    new Error("private database secret"),
    new PlatformError("unknown", "private database secret"),
  ]) {
    thrown = error;
    const rest = await request(get);
    assert.equal(rest.status, 500);
    assert.equal((await rest.json()).message, "Internal error");
    const mcp = await request(
      "/mcp/w1",
      { accept: "application/json, text/event-stream" },
      { ...rpc, params: { name: "issues.get", arguments: { issueId: "issue" } } },
    );
    const data = await mcp.json();
    assert.equal(data.result.isError, true);
    assert.deepEqual(JSON.parse(data.result.content[0].text), {
      code: "unknown",
      message: "Internal error",
    });
  }
  const anonymous = await request("/mcp/w1", { authorization: "" });
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get("www-authenticate"), /^Bearer /);
});
