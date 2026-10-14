import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";
import { auth, extractWWWAuthenticateParams } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { build } from "esbuild";
import { createFetchMock, Miniflare } from "miniflare";

const origin = "https://projektor.example";
const resource = `${origin}/mcp`;
const issuer = "https://unit.cloudflareaccess.com";
const audience = "projektor-test";
let mf, api, ownerScope, adminScope, ownerAssertion, viewerAssertion;
const calls = [];
const b64 = (x) => Buffer.from(JSON.stringify(x)).toString("base64url");
const fetcher = async (input, init) => {
  const request = new Request(input, init);
  calls.push(new URL(request.url).pathname);
  const response = await mf.dispatchFetch(request.url, {
    method: request.method,
    headers: Object.fromEntries(request.headers),
    ...(request.body ? { body: await request.text() } : {}),
    redirect: "manual",
  });
  return new Response(
    response.status === 204 || response.status === 202 ? null : await response.arrayBuffer(),
    {
      status: response.status,
      headers: response.headers,
    },
  );
};
const post = (path, values, extra = {}) =>
  fetcher(origin + path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...extra },
    body: new URLSearchParams(values),
  });
function provider() {
  let info, tokens, verifier, authorizationUrl;
  return {
    redirectUrl: "http://127.0.0.1:32123/callback?code=old&error=old&state=old&iss=old",
    clientMetadata: {
      client_name: "SDK <client> 日本語",
      redirect_uris: ["http://127.0.0.1:32123/callback?code=old&error=old&state=old&iss=old"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "read write",
    },
    state: () => "state + & 日本語",
    clientInformation: () => info,
    saveClientInformation: (x) => {
      info = x;
    },
    tokens: () => tokens,
    saveTokens: (x) => {
      tokens = x;
    },
    saveCodeVerifier: (x) => {
      verifier = x;
    },
    codeVerifier: () => verifier,
    redirectToAuthorization: (url) => {
      authorizationUrl = url;
    },
    get url() {
      return authorizationUrl;
    },
  };
}
async function page(p, assertion = ownerAssertion, params = {}) {
  const url = new URL(p.url);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetcher(url, { headers: { "cf-access-jwt-assertion": assertion } });
  assert.equal(response.status, 200, await response.clone().text());
  const html = await response.text();
  return {
    token: html.match(/name="form_token" value="([^"]+)"/)[1],
    cookie: response.headers.get("set-cookie").split(";")[0],
    html,
    headers: response.headers,
  };
}
function approve(form, assertion = ownerAssertion, headers = {}, decision = "approve") {
  return post(
    "/oauth/authorize",
    { form_token: form.token, decision },
    { origin, cookie: form.cookie, "cf-access-jwt-assertion": assertion, ...headers },
  );
}
async function start(p = provider()) {
  const challenge = extractWWWAuthenticateParams(await rpc());
  assert.equal(
    await auth(p, {
      serverUrl: `${resource}/w1`,
      scope: "read write",
      resourceMetadataUrl: new URL(challenge.resourceMetadataUrl),
      fetchFn: fetcher,
    }),
    "REDIRECT",
  );
  return p;
}
async function login(p = provider(), assertion = ownerAssertion) {
  await start(p);
  const form = await page(p, assertion);
  const result = await approve(form, assertion);
  assert.equal(result.status, 303, await result.clone().text());
  const callback = new URL(result.headers.get("location"));
  assert.equal(callback.searchParams.get("state"), p.state());
  assert.equal(callback.searchParams.get("iss"), origin);
  assert.equal(callback.searchParams.has("error"), false);
  assert.equal(
    await auth(p, {
      serverUrl: `${resource}/w1`,
      authorizationCode: callback.searchParams.get("code"),
      fetchFn: fetcher,
    }),
    "AUTHORIZED",
  );
  return p;
}
const rpc = (token, w = "w1", name = "issues.get", args = { issueId: "issue" }) =>
  fetcher(`${resource}/${w}`, {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
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
    outfile: ".tmp/oauth-worker.mjs",
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
  });
  const platform = await import("../.tmp/test-entry.mjs");
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
    scriptPath: ".tmp/oauth-worker.mjs",
    fetchMock,
    compatibilityDate: "2026-07-30",
    ratelimits: {
      OAUTH_REGISTER_LIMIT: { namespace_id: "1001", simple: { limit: 10, period: 60 } },
      OAUTH_TOKEN_LIMIT: { namespace_id: "1002", simple: { limit: 60, period: 60 } },
    },
    d1Databases: ["DB"],
    kvNamespaces: ["KV"],
    bindings: {
      ACCESS_TEAM_DOMAIN: issuer,
      ACCESS_AUDIENCE: audience,
      OAUTH_ISSUER: origin,
      OAUTH_RESOURCE: resource,
      OAUTH_FORM_SECRET: "test-only-secret".repeat(4),
    },
  });
  const db = await mf.getD1Database("DB");
  await platform.migrate(db, ["access", "projects", "issues", "wiki", "coordination"]);
  const clock = { now: () => Math.floor(Date.now() / 1000) };
  const options = {
    store: platform.createModuleStore(db, "access"),
    kv: platform.createScopedKV(await mf.getKVNamespace("KV"), "access"),
    clock,
    ids: platform.randomIds,
    config: { teamDomain: issuer, audience },
    oauth: { issuer: origin, resource },
    fetchJwks: async () => ({ keys: [jwk] }),
  };
  api = platform.createAccess(options).api;
  async function sign(sub) {
    const text = `${b64({ alg: "RS256", kid: "test" })}.${b64({ iss: issuer, aud: [audience], sub, email: `${sub}@example.test`, type: "app", iat: clock.now() - 1, exp: clock.now() + 3600 })}`;
    return `${text}.${Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(text))).toString("base64url")}`;
  }
  ownerAssertion = await sign("owner");
  viewerAssertion = await sign("viewer");
  const owner = await api.authenticate({ kind: "human", assertion: ownerAssertion });
  for (const w of ["w1", "w2"])
    await api.createWorkspace(owner, { workspaceId: w, name: `Workspace ${w}`, operationId: w });
  ownerScope = await api.requireMembership(owner, "w1", "setup", "write");
  await api.inviteMember(ownerScope, {
    operationId: "invite",
    expectedVersion: 0,
    issuer,
    subject: "viewer",
    role: "viewer",
  });
  await api.inviteMember(ownerScope, {
    operationId: "invite-admin",
    expectedVersion: 0,
    issuer,
    subject: "admin",
    role: "admin",
  });
  adminScope = await api.requireMembership(
    await api.authenticate({ kind: "human", assertion: await sign("admin") }),
    "w1",
    "admin",
    "write",
  );
  const projects = platform.createProjects({
    store: platform.createModuleStore(db, "projects"),
    access: api,
    clock,
    ids: platform.randomIds,
  }).api;
  await projects.createProject(ownerScope, {
    operationId: "project",
    projectId: "p1",
    name: "Project",
    key: "PROJ",
  });
  const viewer = await api.requireMembership(
    await api.authenticate({ kind: "human", assertion: viewerAssertion }),
    "w1",
    "viewer",
  );
  await projects.grantProjectRole(ownerScope, {
    operationId: "viewer-project",
    projectId: "p1",
    expectedVersion: 1,
    principalId: viewer.principalId,
    role: "viewer",
  });
});
after(async () => {
  await mf?.dispose();
});

test("SDK discovery/DCR/consent/token, tools retry/CAS, refresh rotation and revoke through real Worker", async () => {
  const p = provider();
  // The official SDK drives discovery, DCR, PKCE and exchange. Request the
  // write scope needed by this agent task before launching the consent UI.
  await start(p);
  const form = await page(p);
  assert.match(form.html, /SDK &lt;client&gt; 日本語/);
  assert.match(form.html, /Workspace w2/);
  assert.match(form.html, /127.0.0.1:32123/);
  assert.equal(form.headers.get("referrer-policy"), "origin");
  const response = await approve(form);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  const callback = new URL(response.headers.get("location"));
  assert.equal(callback.searchParams.get("iss"), origin);
  assert.equal(callback.searchParams.get("state"), p.state());
  assert.equal(await approve(form).then((x) => x.status), 400);
  assert.equal(
    await auth(p, {
      serverUrl: `${resource}/w1`,
      authorizationCode: callback.searchParams.get("code"),
      fetchFn: fetcher,
    }),
    "AUTHORIZED",
  );
  const connected = new Client({ name: "oauth-test", version: "1" });
  await connected.connect(
    new StreamableHTTPClientTransport(new URL(`${resource}/w1`), {
      authProvider: p,
      fetch: fetcher,
    }),
  );
  const input = {
    operationId: "create",
    issueId: "issue",
    projectId: "p1",
    title: "OAuth issue",
    description: "",
    priority: "medium",
  };
  const result = await connected.callTool({ name: "issues.create", arguments: input });
  assert.equal(result.isError, false);
  assert.deepEqual(await connected.callTool({ name: "issues.create", arguments: input }), result);
  const moved = await connected.callTool({
    name: "issues.transition",
    arguments: { operationId: "move", issueId: "issue", expectedVersion: 1, state: "in_progress" },
  });
  assert.equal(JSON.parse(moved.content[0].text).version, 2);
  const stale = await connected.callTool({
    name: "issues.transition",
    arguments: { operationId: "stale", issueId: "issue", expectedVersion: 1, state: "done" },
  });
  assert.equal(JSON.parse(stale.content[0].text).code, "conflict");
  assert.equal((await rpc(p.tokens().access_token, "w2")).status, 403);
  assert.equal(
    (
      await fetcher(`${origin}/api/w/w1/issues/get?issueId=issue`, {
        headers: { authorization: `Bearer ${p.tokens().access_token}` },
      })
    ).status,
    403,
  );
  const old = p.tokens();
  assert.equal(await auth(p, { serverUrl: `${resource}/w1`, fetchFn: fetcher }), "AUTHORIZED");
  assert.notEqual(p.tokens().refresh_token, old.refresh_token);
  assert.notEqual(p.tokens().access_token, old.access_token);
  assert.equal((await rpc(p.tokens().access_token)).status, 200);
  assert.equal(
    (
      await post("/oauth/revoke", {
        client_id: p.clientInformation().client_id,
        token: p.tokens().refresh_token,
      })
    ).status,
    200,
  );
  const denied = await rpc(p.tokens().access_token);
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get("www-authenticate"), /invalid_token/);
  for (const path of [
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-authorization-server",
    "/oauth/register",
    "/oauth/token",
  ])
    assert(calls.includes(path), path);
  await connected.close();
});

test("CSRF origin/cookie/signature/subject checks, single use race, safe redirects and denial", async () => {
  const p = await start();
  let form = await page(p);
  const fields = { form_token: form.token, decision: "approve" };
  assert.equal(
    (
      await post("/oauth/authorize", fields, {
        cookie: form.cookie,
        "cf-access-jwt-assertion": ownerAssertion,
      })
    ).status,
    400,
  );
  assert.equal(
    (await approve(form, ownerAssertion, { origin: "https://evil.example" })).status,
    400,
  );
  assert.equal((await approve(form, ownerAssertion, { origin: "null" })).status, 400);
  assert.equal((await approve(form, ownerAssertion, { cookie: "" })).status, 400);
  assert.equal(
    (
      await approve({
        ...form,
        token: form.token.slice(0, -1) + (form.token.endsWith("a") ? "b" : "a"),
      })
    ).status,
    400,
  );
  assert.equal((await approve(form, viewerAssertion)).status, 400);
  const race = await Promise.all([approve(form), approve(form)]);
  assert.deepEqual(race.map((x) => x.status).sort(), [303, 400]);
  const invalid = new URL(p.url);
  invalid.searchParams.set("redirect_uri", "https://evil.example/callback");
  const bad = await fetcher(invalid, { headers: { "cf-access-jwt-assertion": ownerAssertion } });
  assert.equal(bad.status, 400);
  assert.equal(bad.headers.get("location"), null);
  form = await page(p, ownerAssertion, { workspace: "w2" });
  const denied = await approve(form, ownerAssertion, {}, "deny");
  const callback = new URL(denied.headers.get("location"));
  assert.equal(callback.searchParams.get("error"), "access_denied");
  assert.equal(callback.searchParams.has("code"), false);
  assert.equal(callback.searchParams.get("state"), p.state());
  assert.equal((await approve(form)).status, 400);
});

test("PKCE and redirect mismatches do not consume code; viewer read grant and write step-up; admin revoke", async () => {
  const p = await start();
  const response = await approve(await page(p));
  const code = new URL(response.headers.get("location")).searchParams.get("code");
  const values = {
    grant_type: "authorization_code",
    client_id: p.clientInformation().client_id,
    code,
    redirect_uri: p.redirectUrl,
    code_verifier: p.codeVerifier(),
    resource,
  };
  assert.equal(
    (await post("/oauth/token", { ...values, code_verifier: "a".repeat(43) }).then((x) => x.json()))
      .error,
    "invalid_grant",
  );
  assert.equal(
    (
      await post("/oauth/token", { ...values, redirect_uri: "https://evil.example/callback" }).then(
        (x) => x.json(),
      )
    ).error,
    "invalid_grant",
  );
  assert.equal((await post("/oauth/token", values)).status, 200);
  const viewer = await login(provider(), viewerAssertion);
  assert.equal(viewer.tokens().scope, "read");
  const read = await rpc(viewer.tokens().access_token);
  assert.equal(read.status, 200);
  assert.equal((await read.json()).result.isError, false);
  const write = await rpc(viewer.tokens().access_token, "w1", "issues.transition", {
    operationId: "viewer",
    issueId: "issue",
    expectedVersion: 2,
    state: "done",
  });
  assert.equal(write.status, 403);
  assert.match(write.headers.get("www-authenticate"), /error="insufficient_scope"/);
  assert.match(write.headers.get("www-authenticate"), /scope="read write"/);
  // A role promotion between display and POST must not silently enlarge consent.
  const review = await page(viewer, viewerAssertion);
  const viewerScope = await api.requireMembership(
    await api.authenticate({ kind: "human", assertion: viewerAssertion }),
    "w1",
    "promote",
  );
  await api.changeRole(ownerScope, {
    operationId: "promote-viewer",
    principalId: viewerScope.principalId,
    expectedVersion: 1,
    role: "member",
  });
  const changedGrant = await approve(review, viewerAssertion);
  assert.equal(changedGrant.status, 303);
  const changedCallback = new URL(changedGrant.headers.get("location"));
  assert.equal(changedCallback.searchParams.get("error"), "access_denied");
  assert.equal(changedCallback.searchParams.has("code"), false);
  const admin = await login();
  const clientId = admin.clientInformation().client_id;
  const binding = await api.getOAuthClient(adminScope, clientId);
  const command = { operationId: "admin-revoke", clientId, expectedVersion: binding.version };
  const revoked = await api.revokeOAuthClient(adminScope, command);
  assert.deepEqual(await api.revokeOAuthClient(adminScope, command), revoked);
  assert.equal((await rpc(admin.tokens().access_token)).status, 401);
  assert.equal(
    (
      await post("/oauth/token", {
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: admin.tokens().refresh_token,
        resource,
      }).then((x) => x.json())
    ).error,
    "invalid_grant",
  );
});

test("metadata aliases, duplicate/oversize/unsupported forms, CORS and bounded endpoint rate limits", async () => {
  for (const path of ["", "/mcp", "/mcp/w1"]) {
    const response = await fetcher(`${origin}/.well-known/oauth-protected-resource${path}`);
    assert.equal((await response.json()).resource, resource);
  }
  const missing = await rpc();
  assert.equal(missing.status, 401);
  assert.match(
    missing.headers.get("www-authenticate"),
    /resource_metadata="https:\/\/projektor.example\/\.well-known\/oauth-protected-resource\/mcp"/,
  );
  assert.equal(
    (
      await post("/oauth/token", [
        ["client_id", "a"],
        ["client_id", "b"],
      ]).then((x) => x.json())
    ).error,
    "invalid_request",
  );
  assert.equal(
    (await post("/oauth/token", { grant_type: "password" }).then((x) => x.json())).error,
    "unsupported_grant_type",
  );
  assert.equal((await post("/oauth/token", { grant_type: "x".repeat(33000) })).status, 400);
  const preflight = await fetcher(`${origin}/oauth/token`, {
    method: "OPTIONS",
    headers: { origin: "https://client.example" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  let registrationLimited = false;
  for (let n = 0; n < 11; n++) {
    const r = await fetcher(`${origin}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (r.status === 429) {
      registrationLimited = true;
      assert(r.headers.get("retry-after"));
      break;
    }
  }
  assert(registrationLimited);
  let tokenLimited = false;
  for (let n = 0; n < 61; n++) {
    const r = await post("/oauth/token", { grant_type: "password" });
    if (r.status === 429) {
      tokenLimited = true;
      break;
    }
  }
  assert(tokenLimited);
});
