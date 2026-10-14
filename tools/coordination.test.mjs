import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

let platform,
  mf,
  index = 0;
const code = (c) => (e) => e.code === c;
before(async () => {
  fs.mkdirSync(".tmp", { recursive: true });
  const output = await build({
    entryPoints: ["tools/coordination-test-entry.ts"],
    outfile: ".tmp/test-entry.mjs",
    bundle: true,
    format: "esm",
    platform: "node",
    metafile: true,
  });
  assert(
    Object.keys(output.metafile.inputs).every(
      (p) =>
        !p.startsWith("modules/issues/internal/") && !p.startsWith("modules/projects/internal/"),
    ),
  );
  platform = await import("../.tmp/test-entry.mjs");
  mf = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('ok')}}",
    compatibilityDate: "2026-07-30",
    d1Databases: Array.from({ length: 20 }, (_, i) => `COORD${i}`),
  });
});
after(async () => mf?.dispose());
async function fixture() {
  const db = await mf.getD1Database(`COORD${index++}`);
  await platform.migrate(db, ["coordination"]);
  const auth = platform.fakeAccess();
  let now = 10000;
  const calls = [];
  const denied = new Set();
  const issue = (workspaceId, principalId, role = "member") =>
    auth.issue({
      id: principalId,
      workspaceId,
      kind: "machine",
      role,
      scope: "write",
      active: true,
    });
  const projects = {
    async authorizeProject(scope, projectId, permission = "read") {
      calls.push(["project", projectId, permission]);
      await auth.access.authorize(scope, permission === "read" ? "read" : "write");
      if (denied.has(`${scope.workspaceId}:${scope.principalId}:${projectId}`))
        throw new platform.PlatformError("not_found", "Project missing");
      if (!["p1", "p2"].includes(projectId))
        throw new platform.PlatformError("not_found", "Project missing");
      if (permission === "manage" && scope.role !== "admin" && scope.role !== "owner")
        throw new platform.PlatformError("forbidden", "Manager only");
      return { id: projectId };
    },
  };
  const issues = {
    async authorizeIssue(scope, issueId, permission = "read") {
      calls.push(["issue", issueId, permission]);
      await projects.authorizeProject(scope, issueId.startsWith("p2") ? "p2" : "p1", permission);
      if (!/^p[12]-/.test(issueId)) throw new platform.PlatformError("not_found", "Issue missing");
      return { id: issueId, projectId: issueId.startsWith("p2") ? "p2" : "p1" };
    },
  };
  const deps = {
    store: platform.createModuleStore(db, "coordination"),
    access: auth.access,
    projects,
    issues,
    clock: { now: () => now },
    ids: { next: () => crypto.randomUUID() },
    eventConsumer: "test",
  };
  const { api, eventReader } = platform.createCoordination(deps);
  return {
    db,
    api,
    auth,
    issue,
    calls,
    denied,
    eventReader,
    advance: (n) => {
      now += n;
    },
    restart: () => platform.createCoordination(deps).api,
  };
}
const start = (api, s, sessionId) =>
  api.startSession(s, {
    operationId: `start-${sessionId}`,
    sessionId,
    agentLabel: sessionId,
    clientKind: "codex",
    repo: "repo",
  });
const acquire = (api, s, sessionId, issueId, operationId = `acq-${sessionId}-${issueId}`) =>
  api.acquireLease(s, { operationId, sessionId, issueId });
test("concurrent acquire, fencing, stale recovery and retries after restart", async () => {
  const f = await fixture(),
    a = f.issue("w1", "a"),
    b = f.issue("w1", "b");
  await start(f.api, a, "sa");
  await start(f.api, b, "sb");
  const attempts = await Promise.allSettled([
    acquire(f.api, a, "sa", "p1-i"),
    acquire(f.api, b, "sb", "p1-i"),
  ]);
  assert.equal(attempts.filter((x) => x.status === "fulfilled").length, 1);
  const winner = attempts[0].status === "fulfilled" ? a : b,
    loser = winner === a ? b : a,
    ws = winner === a ? "sa" : "sb",
    ls = winner === a ? "sb" : "sa",
    first = attempts.find((x) => x.status === "fulfilled").value;
  assert.equal(first.fencingToken, 1);
  assert.deepEqual(await acquire(f.restart(), winner, ws, "p1-i"), first);
  f.advance(121);
  await f.api.heartbeat(loser, { operationId: "hb-loser", sessionId: ls }).catch(() => {});
  await assert.rejects(acquire(f.api, loser, ls, "p1-i"), code("conflict"));
});
test("stale lease reclaim, progress and renew fence, two tenants", async () => {
  const f = await fixture(),
    a = f.issue("w1", "a"),
    b = f.issue("w1", "b"),
    other = f.issue("w2", "a");
  await start(f.api, a, "sa");
  await start(f.api, b, "sb");
  await start(f.api, other, "sa");
  const first = await acquire(f.api, a, "sa", "p1-i");
  f.advance(100);
  await f.api.heartbeat(b, { operationId: "hb", sessionId: "sb" });
  await f.api.heartbeat(other, { operationId: "hb-other", sessionId: "sa" });
  f.advance(21);
  const second = await acquire(f.restart(), b, "sb", "p1-i");
  assert.equal(second.fencingToken, 2);
  assert.equal(second.releaseReason, "expired");
  await assert.rejects(
    f.api.renewLease(a, {
      operationId: "old-renew",
      sessionId: "sa",
      issueId: "p1-i",
      fencingToken: first.fencingToken,
    }),
    code("conflict"),
  );
  await assert.rejects(
    f.api.reportProgress(a, {
      operationId: "old-report",
      sessionId: "sa",
      issueId: "p1-i",
      fencingToken: 1,
      text: "done",
      status: "done",
    }),
    code("conflict"),
  );
  assert.equal(await f.api.getProgress(b, "p1-i"), null);
  assert.equal(await f.api.getLease(other, "p1-i"), null);
  assert.equal((await acquire(f.api, other, "sa", "p1-i")).fencingToken, 1);
});
test("WIP cap, all-or-nothing file claims and manager force event", async () => {
  const f = await fixture(),
    m = f.issue("w1", "manager", "admin"),
    a = f.issue("w1", "a"),
    b = f.issue("w1", "b");
  for (const [s, id] of [
    [m, "sm"],
    [a, "sa"],
    [b, "sb"],
  ])
    await start(f.api, s, id);
  await f.api.setProjectLimit(m, {
    operationId: "lim",
    projectId: "p1",
    cap: 1,
    expectedVersion: 0,
  });
  const attempts = await Promise.allSettled([
    acquire(f.api, a, "sa", "p1-a"),
    acquire(f.api, b, "sb", "p1-b"),
  ]);
  assert.equal(attempts.filter((x) => x.status === "fulfilled").length, 1);
  const lease = await acquire(f.api, m, "sm", "p2-x");
  await f.api.claimFiles(a, {
    operationId: "files-a",
    sessionId: "sa",
    repo: "repo",
    paths: ["src/a"],
  });
  await assert.rejects(
    f.api.claimFiles(b, {
      operationId: "files-b",
      sessionId: "sb",
      repo: "repo",
      paths: ["src/b", "src/a"],
    }),
    code("conflict"),
  );
  assert.deepEqual(
    (await f.api.listClaims(a, "repo", "sa")).map((x) => x.path),
    ["src/a"],
  );
  await f.api.claimFiles(m, {
    operationId: "force",
    sessionId: "sm",
    repo: "repo",
    paths: ["src/a"],
    leaseIssueId: "p2-x",
    fencingToken: lease.fencingToken,
    force: true,
  });
  assert.equal((await f.api.listClaims(m, "repo", "sm"))[0].sessionId, "sm");
  assert(
    (await f.api.readAgentEvents(a, 0, 50)).some(
      (e) => e.type === "FileClaimForced" && e.otherSessionId === "sa",
    ),
  );
});

test("limit CAS, liveness, receipt recovery, tenant visibility and live authorization", async () => {
  const f = await fixture();
  const manager = f.issue("w1", "manager", "admin");
  const worker = f.issue("w1", "worker");
  const outsider = f.issue("w2", "worker");
  await start(f.api, worker, "sw");
  await start(f.api, outsider, "sw");
  await start(f.api, manager, "sm");
  const lease = await acquire(f.api, worker, "sw", "p1-one");
  const limit = await f.api.setProjectLimit(manager, {
    operationId: "cap",
    projectId: "p1",
    cap: 1,
    expectedVersion: 0,
  });
  assert.equal(limit.version, 1);
  assert.deepEqual(
    await f.restart().setProjectLimit(manager, {
      operationId: "cap",
      projectId: "p1",
      cap: 1,
      expectedVersion: 0,
    }),
    limit,
  );
  await assert.rejects(
    f.api.setProjectLimit(manager, {
      operationId: "stale-cap",
      projectId: "p1",
      cap: 2,
      expectedVersion: 0,
    }),
    code("conflict"),
  );
  await assert.rejects(
    f.api.setProjectLimit(manager, {
      operationId: "too-low",
      projectId: "p1",
      cap: 0,
      expectedVersion: 1,
    }),
    code("validation"),
  );
  assert.equal((await f.api.listLeases(worker, "p1")).length, 1);
  assert.deepEqual(await f.api.listLeases(outsider, "p1"), []);
  assert.equal(
    (await f.api.readOperation(worker, "acq-sw-p1-one")).fencingToken,
    lease.fencingToken,
  );
  f.auth.revoke(worker);
  await assert.rejects(f.api.getLease(worker, "p1-one"), code("forbidden"));
  await assert.rejects(f.api.readOperation(worker, "acq-sw-p1-one"), code("forbidden"));
  assert(f.calls.every((call) => call[0] === "project" || call[0] === "issue"));
});

test("endSession releases claims and leases; exact paths stay distinct", async () => {
  const f = await fixture();
  const a = f.issue("w1", "a");
  const b = f.issue("w1", "b");
  await start(f.api, a, "sa");
  await start(f.api, b, "sb");
  const first = await acquire(f.api, a, "sa", "p1-i");
  await f.api.claimFiles(a, {
    operationId: "claim",
    sessionId: "sa",
    repo: "repo",
    paths: ["src/A.ts", "src/a.ts"],
  });
  await assert.rejects(
    f.api.claimFiles(b, {
      operationId: "blocked",
      sessionId: "sb",
      repo: "repo",
      paths: ["src/A.ts"],
    }),
    code("conflict"),
  );
  const ended = await f.api.endSession(a, { operationId: "end", sessionId: "sa" });
  assert.equal(ended.live, false);
  assert.deepEqual(await f.restart().endSession(a, { operationId: "end", sessionId: "sa" }), ended);
  assert.deepEqual(await f.api.listClaims(b, "repo", "sb"), []);
  const next = await acquire(f.api, b, "sb", "p1-i");
  assert.equal(next.fencingToken, first.fencingToken + 1);
  assert.equal((await f.api.listClaims(b, "repo", "sb")).length, 0);
});

test("heartbeat keeps active session claims live", async () => {
  const f = await fixture();
  const a = f.issue("w1", "a");
  const b = f.issue("w1", "b");
  await start(f.api, a, "sa");
  await start(f.api, b, "sb");
  await f.api.claimFiles(a, {
    operationId: "claim",
    sessionId: "sa",
    repo: "repo",
    paths: ["src/a"],
  });
  f.advance(100);
  await f.api.heartbeat(a, { operationId: "heartbeat-a", sessionId: "sa" });
  await f.api.heartbeat(b, { operationId: "heartbeat-b", sessionId: "sb" });
  f.advance(30);
  await assert.rejects(
    f.api.claimFiles(b, {
      operationId: "claim-b",
      sessionId: "sb",
      repo: "repo",
      paths: ["src/a"],
    }),
    code("conflict"),
  );
  assert.equal((await f.api.listClaims(a, "repo", "sa"))[0].expiresAt, 10250);
});
