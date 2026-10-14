/** Local browser fixture. This file is tooling and is never bundled into Worker assets. */

import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { build } from "esbuild";
import { createFetchMock, Miniflare } from "miniflare";

const issuer = "https://web-test.cloudflareaccess.com";
const audience = "web-test";
const oauthIssuer = "https://web-oauth-test.example";
const oauthResource = `${oauthIssuer}/mcp`;
const port = Number(process.env.WEB_TEST_PORT ?? 8789);
await build({
  entryPoints: ["tools/test-entry.ts"],
  outfile: ".tmp/test-entry.mjs",
  bundle: true,
  format: "esm",
  platform: "node",
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
  kid: "web-test",
  alg: "RS256",
  use: "sig",
};
const fetchMock = createFetchMock();
fetchMock
  .get(issuer)
  .intercept({ path: "/cdn-cgi/access/certs" })
  .reply(200, JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } })
  .persist();
const mf = new Miniflare({
  modules: true,
  fetchMock,
  scriptPath: "dist/worker.js",
  compatibilityDate: "2026-07-30",
  ratelimits: {
    OAUTH_REGISTER_LIMIT: { namespace_id: "2001", simple: { limit: 10, period: 60 } },
    OAUTH_TOKEN_LIMIT: { namespace_id: "2002", simple: { limit: 60, period: 60 } },
    FEEDBACK_LIMIT: { namespace_id: "2003", simple: { limit: 60, period: 60 } },
  },
  assets: { directory: "dist/assets", routerConfig: { has_user_worker: true } },
  d1Databases: ["DB"],
  kvNamespaces: ["KV"],
  r2Buckets: ["R2"],
  bindings: {
    ACCESS_TEAM_DOMAIN: issuer,
    ACCESS_AUDIENCE: audience,
    OAUTH_ISSUER: oauthIssuer,
    OAUTH_RESOURCE: oauthResource,
    OAUTH_FORM_SECRET: "web-fixture-secret-keep-out-of-production",
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
  "lifecycle",
]);
const clock = { now: () => Math.floor(Date.now() / 1000) };
const access = platform.createAccess({
  store: platform.createModuleStore(db, "access"),
  kv: platform.createScopedKV(await mf.getKVNamespace("KV"), "access"),
  clock,
  ids: platform.randomIds,
  config: { teamDomain: issuer, audience },
  oauth: { issuer: oauthIssuer, resource: oauthResource },
  fetchJwks: async () => ({ keys: [jwk] }),
}).api;
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const sign = async (subject) => {
  const message = `${b64({ alg: "RS256", kid: "web-test" })}.${b64({ iss: issuer, aud: [audience], sub: subject, email: `${subject}@example.test`, type: "app", iat: clock.now() - 1, exp: clock.now() + 3600 })}`;
  return `${message}.${Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(message))).toString("base64url")}`;
};
const assertion = await sign("web-owner");
const human = await access.authenticate({ kind: "human", assertion });
const tokens = {};
const machines = {};
const oauthClients = {};
for (const workspaceId of ["web1", "web2"]) {
  await access.createWorkspace(human, {
    workspaceId,
    name: workspaceId,
    operationId: `workspace-${workspaceId}`,
  });
  const scope = await access.requireMembership(human, workspaceId, "seed", "write");
  const principalId = `agent-${workspaceId}`;
  const machine = await access.provisionMachine(scope, {
    principalId,
    role: "member",
    operationId: `machine-${workspaceId}`,
  });
  const secret = randomBytes(32).toString("hex");
  await access.issueCredential(scope, {
    principalId: machine.id,
    credentialId: "e2e",
    secret,
    scope: "write",
    expiresAt: clock.now() + 3600,
    operationId: `credential-${workspaceId}`,
  });
  machines[workspaceId] = machine.id;
  tokens[workspaceId] = `pt1.${workspaceId}.e2e.${secret}`;
  const client = await access.registerOAuthClient({
    client_name: "Browser OAuth Client",
    redirect_uris: ["http://127.0.0.1:32123/callback"],
    scope: "read write",
  });
  const verifier = randomBytes(32).toString("base64url");
  const challenge = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  ).toString("base64url");
  const consent = await access.getOAuthConsent(
    human,
    {
      client_id: client.client_id,
      redirect_uri: "http://127.0.0.1:32123/callback",
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: oauthResource,
      scope: "read write",
    },
    scope,
  );
  const code = await access.approveOAuthConsent(scope, consent, {
    operationId: `oauth-consent-${workspaceId}`,
    codeSecret: randomBytes(32).toString("hex"),
  });
  const oauthToken = await access.exchangeOAuthToken({
    grant_type: "authorization_code",
    client_id: client.client_id,
    resource: oauthResource,
    code: code.code,
    redirect_uri: "http://127.0.0.1:32123/callback",
    code_verifier: verifier,
  });
  oauthClients[workspaceId] = {
    clientId: client.client_id,
    name: client.client_name,
    token: oauthToken.access_token,
  };
}
for (let index = 0; index < 101; index++) {
  const workspaceId = `zz-web-${String(index).padStart(3, "0")}`;
  await access.createWorkspace(human, {
    workspaceId,
    name: workspaceId,
    operationId: `workspace-${workspaceId}`,
  });
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (url.pathname === "/__test/token") {
      const token = tokens[url.searchParams.get("w")];
      res.writeHead(token ? 200 : 404, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ token, machineId: machines[url.searchParams.get("w")] }));
      return;
    }
    if (url.pathname === "/__test/oauth") {
      const client = oauthClients[url.searchParams.get("w")];
      res.writeHead(client ? 200 : 404, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(client));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers))
      if (value && key !== "host") headers.set(key, Array.isArray(value) ? value.join(",") : value);
    if (url.pathname.startsWith("/api/")) headers.set("cf-access-jwt-assertion", assertion);
    const workerUrl = url.pathname.startsWith("/mcp/")
      ? new URL(url.pathname + url.search, oauthIssuer).toString()
      : url.toString();
    const response = await mf.dispatchFetch(workerUrl, {
      method: req.method,
      headers,
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    res.writeHead(500);
    res.end(String(error));
  }
});
server.listen(port, "127.0.0.1", () => console.log(`WEB_TEST_READY http://127.0.0.1:${port}`));
process.on("SIGTERM", async () => {
  server.close();
  await mf.dispose();
});
