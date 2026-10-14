import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

await build({
  entryPoints: ["tools/web-test-entry.ts"],
  outfile: ".tmp/test-entry.mjs",
  bundle: true,
  format: "esm",
  platform: "browser",
});
const { WireClient, WireError, OperationState } = await import("../.tmp/test-entry.mjs");
globalThis.location = new URL("http://localhost/");
const spec = {
  paths: {
    "/api/w/{workspaceId}/issues/create": { post: { operationId: "issues.create" } },
    "/api/w/{workspaceId}/issues/get": { get: { operationId: "issues.get" } },
  },
};
test("OpenAPI-derived route, cookie transport and no browser token", async () => {
  const seen = [];
  const client = new WireClient(async (url, init) => {
    seen.push([url, init]);
    return new Response(JSON.stringify(url === "/api/openapi.json" ? spec : { id: "i" }), {
      status: 200,
    });
  });
  await client.call("w1", "issues.create", { title: "日本語", operationId: "op" });
  assert.equal(seen[1][0], "/api/w/w1/issues/create");
  assert.equal(seen[1][1].credentials, "same-origin");
  assert.equal(seen[1][1].headers.authorization, undefined);
  await client.call("w1", "issues.get", { issueId: "i" });
  assert.equal(seen[2][0], "/api/w/w1/issues/get?issueId=i");
});
test("unknown retries identical request; conflict releases it", async () => {
  const calls = [];
  let attempt = 0;
  const client = new WireClient(async (url, init) => {
    if (url === "/api/openapi.json") return Response.json(spec);
    calls.push(init.body);
    attempt++;
    if (attempt === 1) throw new Error("lost response");
    return Response.json({ id: "i" });
  });
  const op = new OperationState(client, () => {});
  assert.equal(await op.run("w1", "issues.create", { issueId: "i" }), null);
  assert.equal(op.status, "unknown");
  await op.retry();
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(op.status, "idle");
});
test("HTTP conflict is distinguishable from unknown", async () => {
  const client = new WireClient(async (url) =>
    url === "/api/openapi.json"
      ? Response.json(spec)
      : Response.json({ code: "conflict", message: "stale" }, { status: 409 }),
  );
  const op = new OperationState(client, () => {});
  await op.run("w1", "issues.create", { issueId: "i" });
  assert.equal(op.status, "error");
  assert.equal(op.pending, null);
  await assert.rejects(
    client.call("w1", "issues.create", {}),
    (error) => error instanceof WireError && error.code === "conflict",
  );
});

test("server unknown outcome keeps operation identity for replay", async () => {
  const seen = [];
  const client = new WireClient(async (url, init) => {
    if (url === "/api/openapi.json") return Response.json(spec);
    seen.push(init.body);
    return seen.length === 1
      ? Response.json({ code: "unknown", message: "uncertain" }, { status: 500 })
      : Response.json({ id: "i" });
  });
  const op = new OperationState(client, () => {});
  await op.run("w1", "issues.create", { issueId: "i" });
  assert.equal(op.status, "unknown");
  await op.retry();
  assert.deepEqual(seen[0], seen[1]);
});
