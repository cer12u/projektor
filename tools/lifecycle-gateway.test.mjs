import assert from "node:assert/strict";
import { before, test } from "node:test";
import { build } from "esbuild";

let handleHttp, tools, openApi;
before(async () => {
  await build({
    entryPoints: ["tools/lifecycle-gateway-test-entry.ts"],
    outfile: ".tmp/test-entry.mjs",
    bundle: true,
    format: "esm",
    platform: "node",
  });
  ({ handleHttp, tools, openApi } = await import("../.tmp/test-entry.mjs"));
});

const job = {
  id: "job-1",
  workspaceId: "workspace-1",
  projectId: null,
  version: 1,
  state: "freezing",
  steps: [],
};
function fixture() {
  const principal = { id: "owner-1", kind: "human" };
  const calls = [];
  const services = {
    access: {
      authenticate: async () => principal,
      requireMembership: async () => {
        throw Error("Gateway must preserve principal for Lifecycle");
      },
    },
    lifecycle: {
      requestPurge: async (scope, input) => {
        calls.push({ method: "request", scope, input });
        return job;
      },
      resumePurge: async (scope, input) => {
        calls.push({ method: "resume", scope, input });
        return job;
      },
      getPurgeStatus: async (scope, input) => {
        calls.push({ method: "status", scope, input });
        return job;
      },
    },
  };
  return { calls, principal, services };
}
const url = (action) => `https://example.test/api/w/workspace-1/lifecycle/${action}`;
const headers = { "cf-access-jwt-assertion": "signed", "content-type": "application/json" };

test("Lifecycle REST routes preserve authenticated identity and validate input", async () => {
  const { calls, principal, services } = fixture();
  const request = await handleHttp(
    new Request(url("requestPurge"), {
      method: "POST",
      headers,
      body: JSON.stringify({
        operationId: "op-1",
        expectedVersion: 0,
        confirmation: "workspace-1",
      }),
    }),
    services,
  );
  assert.equal(request.status, 200);
  assert.deepEqual(await request.json(), job);
  assert.deepEqual(calls[0].input, {
    operationId: "op-1",
    expectedVersion: 0,
    projectId: undefined,
    confirmation: "workspace-1",
  });
  assert.equal(calls[0].scope.principal, principal);
  assert.equal(calls[0].scope.workspaceId, "workspace-1");
  assert.ok(calls[0].scope.requestId);

  const status = await handleHttp(
    new Request(`${url("getPurgeStatus")}?projectId=project-1`, { headers }),
    services,
  );
  assert.equal(status.status, 200);
  assert.deepEqual(calls[1].input, { projectId: "project-1" });
  const resume = await handleHttp(
    new Request(url("resumePurge"), {
      method: "POST",
      headers,
      body: JSON.stringify({ operationId: "op-2", expectedVersion: 1, jobId: "job-1" }),
    }),
    services,
  );
  assert.equal(resume.status, 200);
  assert.deepEqual(calls[2].input, { operationId: "op-2", expectedVersion: 1, jobId: "job-1" });

  const invalid = await handleHttp(
    new Request(url("requestPurge"), {
      method: "POST",
      headers,
      body: JSON.stringify({
        operationId: "op-3",
        expectedVersion: 0,
        confirmation: "workspace-1",
        arbitrary: true,
      }),
    }),
    services,
  );
  assert.equal(invalid.status, 400);
  assert.equal(calls.length, 3);
});

test("Lifecycle appears in OpenAPI and never in MCP tools", () => {
  const operations = tools().map((entry) => entry.name);
  assert.equal(
    operations.some((name) => name.startsWith("lifecycle.")),
    false,
  );
  const paths = openApi().paths;
  assert.ok(paths["/api/w/{workspaceId}/lifecycle/requestPurge"].post);
  assert.ok(paths["/api/w/{workspaceId}/lifecycle/resumePurge"].post);
  assert.ok(paths["/api/w/{workspaceId}/lifecycle/getPurgeStatus"].get);
});
