import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { Miniflare } from "miniflare";
import { firstRemoteMigration } from "./smoke-retry.mjs";

export async function checkSmoke(send, origin, smokeSecret, remote = false) {
  const workspaceId = `smoke_${randomBytes(12).toString("hex")}`;
  const credentialSecret = randomBytes(32).toString("hex");
  const bearer = `pt1.${workspaceId}.smoke.${credentialSecret}`;
  const request = async (path, method = "GET", value, headers = {}, retryFirst = false) => {
    const url = `${origin}${path}`;
    const init = {
      method,
      headers: { ...headers, ...(value ? { "content-type": "application/json" } : {}) },
      ...(value ? { body: JSON.stringify(value) } : {}),
    };
    const response = await (retryFirst ? firstRemoteMigration(send, url, init) : send(url, init));
    // Remote error bodies can contain credentials. Keep diagnostics to path/status.
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return response.json();
  };
  const smoke = (path, value = {}, retryFirst = false) =>
    request(`/__smoke/${path}`, "POST", value, { "x-smoke-secret": smokeSecret }, retryFirst);
  const api = (name, value, method = "POST") => {
    const path = `/api/w/${workspaceId}/${name.replace(".", "/")}`;
    if (method === "GET") {
      const query = new URLSearchParams(value);
      return request(`${path}?${query}`, "GET", undefined, { authorization: `Bearer ${bearer}` });
    }
    return request(path, "POST", value, { authorization: `Bearer ${bearer}` });
  };
  const first = await smoke("migrate", {}, remote);
  const second = await smoke("migrate");
  assert.equal(second.migrations, first.migrations, "migration ledger changed on retry");
  assert(first.migrations > 0);
  const { feedbackSecret } = await smoke("bootstrap", { workspaceId, secret: credentialSecret });
  assert.equal(typeof feedbackSecret === "string" && /^[0-9a-f]{64}$/.test(feedbackSecret), true);
  const feedback = { title: "Smoke feedback", body: "Signed public feedback" };
  const timestamp = Math.floor(Date.now() / 1000);
  const deliveryId = "smoke_delivery";
  const signature = createHmac("sha256", feedbackSecret)
    .update(`${timestamp}.${deliveryId}.${JSON.stringify(feedback)}`)
    .digest("hex");
  const receive = () =>
    request(`/integrations/feedback/${workspaceId}/smoke`, "POST", feedback, {
      "x-projektor-timestamp": String(timestamp),
      "x-projektor-delivery-id": deliveryId,
      "x-projektor-signature": signature,
    });
  const accepted = await receive();
  assert.equal(typeof accepted.id, "string");
  assert.deepEqual(await receive(), accepted, "feedback retry was not deduplicated");
  const inbox = await api("integrations.feedback", {}, "GET");
  assert.equal(inbox.items.length, 1, "feedback retry created a second row");
  assert.equal(inbox.items[0].id, accepted.id);
  assert.equal(inbox.items[0].title, feedback.title);
  assert.deepEqual(await smoke("probes", { workspaceId }), {
    rollback: true,
    binds: 100,
    r2Cleanup: true,
  });
  assert.deepEqual(await request("/health"), { phase: "gateway", deployable: false });
  const create = {
    operationId: "create",
    issueId: "issue",
    projectId: "smoke",
    title: "日本語の確認",
    description: "短語と Japanese trigram smoke",
    priority: "medium",
  };
  assert.deepEqual(await api("issues.create", create), { id: "issue", number: 1, version: 1 });
  assert.deepEqual(await api("issues.create", create), { id: "issue", number: 1, version: 1 });
  assert.equal((await api("issues.get", { issueId: "issue" }, "GET")).id, "issue");
  for (const term of ["日本語", "短語", "本語", "語"]) {
    const found = await api("issues.search", { projectId: "smoke", text: term }, "GET");
    assert(
      found.some((item) => item.id === "issue"),
      `FTS5 trigram/short search failed: ${term}`,
    );
  }
  const stale = await request(
    `/api/w/${workspaceId}/issues/transition`,
    "POST",
    { operationId: "stale", issueId: "issue", expectedVersion: 99, state: "done" },
    { authorization: `Bearer ${bearer}` },
  ).then(
    () => null,
    (error) => error,
  );
  assert.match(stale?.message ?? "", /HTTP 409/);
  assert.deepEqual(await smoke("receipt", { workspaceId, operationId: "stale" }), { receipts: 0 });
  const rpc = await request(
    `/mcp/${workspaceId}`,
    "POST",
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "issues.get", arguments: { issueId: "issue" } },
    },
    {
      authorization: `Bearer ${bearer}`,
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
    },
  );
  assert.equal(JSON.parse(rpc.result.content[0].text).id, "issue");
  return { workspaceId, migrations: first.migrations };
}

if (process.argv[1]?.endsWith("smoke-check.mjs")) {
  let mf;
  try {
    if (process.argv[2] === "local") {
      mf = new Miniflare({
        modules: true,
        scriptPath: "dist/smoke-worker.js",
        compatibilityDate: "2026-07-30",
        d1Databases: ["DB"],
        kvNamespaces: ["KV"],
        r2Buckets: ["R2"],
        ratelimits: { FEEDBACK_LIMIT: { namespace_id: "1003", simple: { limit: 60, period: 60 } } },
        bindings: {
          SMOKE_ENABLED: "1",
          SMOKE_SECRET: "local-test-secret",
          ACCESS_TEAM_DOMAIN: "https://unit.cloudflareaccess.com",
          ACCESS_AUDIENCE: "test",
          INTEGRATIONS_KEY: "ab".repeat(32),
        },
      });
      const result = await checkSmoke(
        (url, init) => mf.dispatchFetch(url, init),
        "http://localhost",
        "local-test-secret",
      );
      console.log(`Local smoke passed: ${result.migrations} migrations`);
    } else if (process.argv[2] === "remote") {
      const origin = process.env.SMOKE_ORIGIN;
      const secret = process.env.SMOKE_SECRET;
      if (!origin || !secret || !/^https:\/\/.+\.workers\.dev$/.test(origin))
        throw new Error("SMOKE_ORIGIN workers.dev URL and SMOKE_SECRET are required");
      const result = await checkSmoke(fetch, origin, secret, true);
      console.log(
        `Cloudflare smoke passed: ${result.migrations} migrations; workspace ${result.workspaceId}`,
      );
    } else throw new Error("Usage: node tools/smoke-check.mjs local|remote");
  } finally {
    await mf?.dispose();
  }
}
