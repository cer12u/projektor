import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { coordinationProviderContract } from "./coordination-provider-contract.mjs";

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
    d1Databases: Array.from({ length: 40 }, (_, i) => `COORD${i}`),
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
  const store = platform.createModuleStore(db, "coordination");
  let beforeBatch;
  const deps = {
    store: {
      ...store,
      batch: async (calls) => {
        const hook = beforeBatch;
        beforeBatch = undefined;
        if (hook) await hook(calls);
        return store.batch(calls);
      },
    },
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
    providers: { access: auth.access, projects, issues },
    beforeBatch: (hook) => {
      beforeBatch = hook;
    },
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
test("project pages expose active work and enforce project/tenant authorization", async () => {
  const f = await fixture();
  const a = f.issue("w1", "a"),
    b = f.issue("w1", "b"),
    other = f.issue("w2", "a");
  const viewer = f.issue("w1", "viewer", "viewer");
  await start(f.api, a, "sa");
  await start(f.api, b, "sb");
  await start(f.api, other, "sa");
  await acquire(f.api, a, "sa", "p1-a");
  await acquire(f.api, b, "sb", "p1-b");
  await acquire(f.api, other, "sa", "p2-other");
  await f.api.reportProgress(a, {
    operationId: "progress-a",
    sessionId: "sa",
    issueId: "p1-a",
    fencingToken: 1,
    text: "A",
    status: "working",
  });
  await f.api.reportProgress(b, {
    operationId: "progress-b",
    sessionId: "sb",
    issueId: "p1-b",
    fencingToken: 1,
    text: "B",
    status: "working",
  });
  await f.api.claimFiles(a, {
    operationId: "claim-a",
    sessionId: "sa",
    repo: "repo",
    paths: ["src/a"],
    leaseIssueId: "p1-a",
    fencingToken: 1,
  });
  await f.api.claimFiles(b, {
    operationId: "claim-b",
    sessionId: "sb",
    repo: "repo",
    paths: ["src/b"],
    leaseIssueId: "p1-b",
    fencingToken: 1,
  });
  for (const method of ["projectSessions", "projectLeases", "projectProgress", "projectClaims"]) {
    const first = await f.api[method](viewer, "p1", undefined, 1);
    assert.equal(first.items.length, 1);
    assert.ok(first.nextCursor);
    assert.equal((await f.api[method](viewer, "p1", first.nextCursor, 1)).items.length, 1);
    assert.deepEqual((await f.api[method](other, "p1")).items, []);
    await assert.rejects(f.api[method](viewer, "p1", undefined, 101), code("validation"));
  }
  assert.equal((await f.api.getProjectLimit(viewer, "p1")).cap, 3);
  await assert.rejects(
    f.api.setProjectLimit(viewer, {
      operationId: "viewer-cap",
      projectId: "p1",
      cap: 2,
      expectedVersion: 0,
    }),
    code("forbidden"),
  );
  await assert.rejects(
    f.api.setProjectLimit(a, {
      operationId: "member-cap",
      projectId: "p1",
      cap: 2,
      expectedVersion: 0,
    }),
    code("forbidden"),
  );
  f.denied.add("w1:viewer:p1");
  await assert.rejects(f.api.projectLeases(viewer, "p1"), code("not_found"));
});
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

test("audit live holder and stale token matrix leaves no receipts or effects", async () => {
  const f = await fixture(),
    a = f.issue("w1", "a"),
    b = f.issue("w1", "b");
  await start(f.api, a, "sa");
  await start(f.api, b, "sb");
  await acquire(f.api, a, "sa", "p1-i");
  await assert.rejects(acquire(f.api, b, "sb", "p1-i"), code("conflict"));
  await f.api.releaseLease(a, {
    operationId: "release",
    sessionId: "sa",
    issueId: "p1-i",
    fencingToken: 1,
  });
  const current = await acquire(f.api, a, "sa", "p1-i", "reacquire");
  assert.equal(current.fencingToken, 2);
  for (const method of ["renewLease", "releaseLease", "reportProgress", "claimFiles"]) {
    const input = {
      operationId: method,
      sessionId: "sa",
      issueId: "p1-i",
      fencingToken: 1,
      text: "stale",
      status: "done",
      repo: "repo",
      paths: ["stale"],
      leaseIssueId: "p1-i",
    };
    await assert.rejects(f.api[method](a, input), code("conflict"));
    assert.equal(await f.api.readOperation(a, method), null);
  }
  assert.deepEqual(await f.api.getLease(a, "p1-i"), current);
  assert.equal(await f.api.getProgress(a, "p1-i"), null);
  assert.deepEqual(await f.api.listClaims(a, "repo", "sa"), []);
});

test("audit claims reject non-manager force and isolate both populated tenants", async () => {
  const f = await fixture(),
    a = f.issue("w1", "a"),
    b = f.issue("w1", "b"),
    other = f.issue("w2", "a");
  for (const [s, id] of [
    [a, "sa"],
    [b, "sb"],
    [other, "sa"],
  ])
    await start(f.api, s, id);
  await acquire(f.api, a, "sa", "p1-i");
  await acquire(f.api, other, "sa", "p1-other");
  await f.api.claimFiles(b, {
    operationId: "held",
    sessionId: "sb",
    repo: "repo",
    paths: ["held"],
  });
  await f.api.claimFiles(other, {
    operationId: "other",
    sessionId: "sa",
    repo: "repo",
    paths: ["secret"],
  });
  await assert.rejects(
    f.api.claimFiles(a, {
      operationId: "force-denied",
      sessionId: "sa",
      repo: "repo",
      paths: ["held"],
      leaseIssueId: "p1-i",
      fencingToken: 1,
      force: true,
    }),
    code("forbidden"),
  );
  assert.deepEqual(
    (await f.api.listClaims(a, "repo", "sa")).map((x) => x.path),
    ["held"],
  );
  assert.deepEqual(
    (await f.api.listClaims(other, "repo", "sa")).map((x) => x.path),
    ["secret"],
  );
  assert.equal(await f.api.getLease(other, "p1-i"), null);
  assert.deepEqual(
    (await f.api.listLeases(a, "p1")).map((x) => x.issueId),
    ["p1-i"],
  );
  assert.deepEqual(
    (await f.api.listLeases(other, "p1")).map((x) => x.issueId),
    ["p1-other"],
  );
});

test("audit report history preserves order, retries, tenant and issue keysets and live authorization", async () => {
  const f = await fixture(),
    a = f.issue("w1", "a"),
    other = f.issue("w2", "a");
  for (const s of [a, other]) {
    await start(f.api, s, "sa");
    await acquire(f.api, s, "sa", "p1-i");
  }
  const input = { sessionId: "sa", issueId: "p1-i", fencingToken: 1, status: "working" };
  assert.deepEqual(await f.api.listProgress(a, "p1-i"), { items: [], nextCursor: null });
  for (let i = 1; i <= 3; i++)
    await f.api.reportProgress(a, { ...input, operationId: `report-${i}`, text: `report-${i}` });
  await f.api.reportProgress(other, { ...input, operationId: "foreign", text: "secret" });
  await acquire(f.api, a, "sa", "p1-other");
  await f.api.reportProgress(a, {
    ...input,
    issueId: "p1-other",
    operationId: "other-issue",
    text: "other issue",
  });
  const first = await f.api.listProgress(a, "p1-i", { limit: 2 });
  assert.deepEqual(
    first.items.map((x) => [x.sequence, x.text]),
    [
      [3, "report-3"],
      [2, "report-2"],
    ],
  );
  assert.equal(first.nextCursor, 2);
  await f.api.reportProgress(a, { ...input, operationId: "report-4", text: "report-4" });
  const last = await f.restart().listProgress(a, "p1-i", { cursor: first.nextCursor, limit: 2 });
  assert.deepEqual(
    last.items.map((x) => x.sequence),
    [1],
  );
  assert.equal(last.nextCursor, null);
  const old = await f
    .restart()
    .reportProgress(a, { ...input, operationId: "report-1", text: "report-1" });
  assert.equal(old.text, "report-1");
  assert.equal((await f.api.listProgress(a, "p1-i")).items.length, 4);
  assert.equal((await f.api.getProgress(a, "p1-i")).text, "report-4");
  await assert.rejects(
    f.api.reportProgress(a, { ...input, operationId: "report-1", text: "changed" }),
    code("conflict"),
  );
  for (const args of [
    { limit: 0 },
    { limit: 101 },
    { cursor: 0 },
    { cursor: null },
    { limit: 1.5 },
  ])
    await assert.rejects(f.api.listProgress(a, "p1-i", args), code("validation"));
  f.auth.revoke(a);
  await assert.rejects(f.api.listProgress(a, "p1-i"), code("forbidden"));
});

test("audit history retention and final event failure roll back latest, history and receipt", async () => {
  const f = await fixture(),
    a = f.issue("w1", "a");
  await start(f.api, a, "sa");
  await acquire(f.api, a, "sa", "p1-i");
  await f.db
    .prepare(
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1000) INSERT INTO coord_report_history SELECT 'w1','p1-i',i,'sa',1,'seed','working',10000 FROM n",
    )
    .run();
  const input = {
    operationId: "report",
    sessionId: "sa",
    issueId: "p1-i",
    fencingToken: 1,
    text: "latest",
    status: "done",
  };
  await f.api.reportProgress(a, input);
  const rows = await f.db
    .prepare(
      "SELECT COUNT(*) AS n,MIN(sequence) AS first,MAX(sequence) AS last FROM coord_report_history",
    )
    .first();
  assert.deepEqual(rows, { n: 1000, first: 2, last: 1001 });
  await f.db.exec(
    "CREATE TRIGGER reject_progress BEFORE INSERT ON coord_events WHEN NEW.type='ProgressReported' BEGIN SELECT RAISE(ABORT,'injected'); END",
  );
  await assert.rejects(
    f.api.reportProgress(a, { ...input, operationId: "failed", text: "must rollback" }),
    code("unknown"),
  );
  assert.equal((await f.api.getProgress(a, "p1-i")).text, "latest");
  assert.equal((await f.api.listProgress(a, "p1-i", { limit: 1 })).items[0].sequence, 1001);
  assert.equal(await f.api.readOperation(a, "failed"), null);
  assert.deepEqual(
    await f.db
      .prepare(
        "SELECT COUNT(*) AS n,MIN(sequence) AS first,MAX(sequence) AS last FROM coord_report_history",
      )
      .first(),
    rows,
  );
});

test("audit claim race rolls back every path when a later path loses CAS", async () => {
  const f = await fixture(),
    a = f.issue("w1", "a");
  await start(f.api, a, "sa");
  f.beforeBatch(async () => {
    await f.db
      .prepare("INSERT INTO coord_file_claims VALUES ('w1','repo','z','competitor',NULL,20000)")
      .run();
  });
  await assert.rejects(
    f.api.claimFiles(a, { operationId: "race", sessionId: "sa", repo: "repo", paths: ["a", "z"] }),
    code("conflict"),
  );
  assert.deepEqual(
    (await f.api.listClaims(a, "repo", "sa")).map((x) => [x.path, x.sessionId]),
    [["z", "competitor"]],
  );
  assert.equal(await f.api.readOperation(a, "race"), null);
});

for (const method of ["reportProgress", "renewLease", "releaseLease", "claimFiles"]) {
  test(`audit SQL fence survives admission race: ${method}`, async () => {
    const f = await fixture(),
      a = f.issue("w1", "a");
    await start(f.api, a, "sa");
    await acquire(f.api, a, "sa", "p1-i");
    f.beforeBatch(async () => {
      await f.db
        .prepare(
          "UPDATE coord_leases SET fencing_token=2 WHERE workspace_id='w1' AND issue_id='p1-i'",
        )
        .run();
    });
    await assert.rejects(
      f.api[method](a, {
        operationId: "race",
        sessionId: "sa",
        issueId: "p1-i",
        fencingToken: 1,
        text: "stale",
        status: "done",
        repo: "repo",
        paths: ["a"],
        leaseIssueId: "p1-i",
      }),
      code("conflict"),
    );
    assert.equal(await f.api.readOperation(a, "race"), null);
    assert.equal((await f.api.getLease(a, "p1-i")).fencingToken, 2);
    assert.equal((await f.api.getLease(a, "p1-i")).sessionId, "sa");
    assert.equal(await f.api.getProgress(a, "p1-i"), null);
    assert.deepEqual(await f.api.listProgress(a, "p1-i"), { items: [], nextCursor: null });
    assert.deepEqual(await f.api.listClaims(a, "repo", "sa"), []);
  });
}

test("audit progress migration preserves prior latest row without rewriting migration 0001", async () => {
  const db = await mf.getD1Database(`COORD${index++}`);
  const sql = fs.readFileSync(
    "modules/coordination/storage/migrations/0001_coordination.sql",
    "utf8",
  );
  for (const statement of sql.trim().split(";"))
    if (statement.trim()) await db.prepare(statement).run();
  await db
    .prepare("INSERT INTO coord_reports VALUES ('w1','p1-i','sa',7,'previous','working',9000)")
    .run();
  const next = fs.readFileSync(
    "modules/coordination/storage/migrations/0002_progress_history.sql",
    "utf8",
  );
  for (const statement of next.trim().split(";"))
    if (statement.trim()) await db.prepare(statement).run();
  const old = await db.prepare("SELECT * FROM coord_reports").first();
  assert.deepEqual(await db.prepare("SELECT * FROM coord_report_history").first(), {
    ...old,
    sequence: 1,
  });
});

test("audit every command rolls back on receipt failure, retries and recovers after restart", async () => {
  const inputs = {
    startSession: { sessionId: "new", agentLabel: "new", clientKind: "codex" },
    heartbeat: { sessionId: "sa" },
    endSession: { sessionId: "sa" },
    acquireLease: { sessionId: "sa", issueId: "p1-next" },
    renewLease: { sessionId: "sa", issueId: "p1-i", fencingToken: 1 },
    releaseLease: { sessionId: "sa", issueId: "p1-i", fencingToken: 1 },
    setProjectLimit: { projectId: "p1", cap: 2, expectedVersion: 0 },
    claimFiles: { sessionId: "sa", repo: "repo", paths: ["new"] },
    releaseFiles: { sessionId: "sa", repo: "repo", paths: ["held"] },
    reportProgress: {
      sessionId: "sa",
      issueId: "p1-i",
      fencingToken: 1,
      text: "progress",
      status: "working",
    },
  };
  for (const [method, fields] of Object.entries(inputs)) {
    const f = await fixture(),
      a = f.issue("w1", "a", "admin");
    await start(f.api, a, "sa");
    await acquire(f.api, a, "sa", "p1-i");
    await f.api.claimFiles(a, {
      operationId: "setup",
      sessionId: "sa",
      repo: "repo",
      paths: ["held"],
    });
    const tables = [
      "coord_sessions",
      "coord_leases",
      "coord_file_claims",
      "coord_reports",
      "coord_report_history",
      "coord_limits",
      "coord_receipts",
      "coord_events",
      "coord_guards",
    ];
    const snapshot = () =>
      Promise.all(
        tables.map(
          async (table) =>
            (await f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results,
        ),
      );
    const before = await snapshot();
    await f.db.exec(
      "CREATE TRIGGER reject_receipt BEFORE INSERT ON coord_receipts WHEN NEW.operation_id='audit' BEGIN SELECT RAISE(ABORT,'injected'); END",
    );
    const input = { ...fields, operationId: "audit" };
    await assert.rejects(f.api[method](a, input), code("unknown"), method);
    assert.deepEqual(await snapshot(), before, `${method}: whole owner state rollback`);
    await f.db.exec("DROP TRIGGER reject_receipt");
    const result = await f.api[method](a, input),
      committed = await snapshot();
    assert.deepEqual(await f.restart()[method](a, input), result, `${method}: replay`);
    assert.deepEqual(await f.api.readOperation(a, "audit"), result, `${method}: recovery`);
    assert.deepEqual(await snapshot(), committed, `${method}: no repeated effects`);
  }
});

test("audit Coordination dependency fakes satisfy the consumed provider contract", async () => {
  const f = await fixture();
  await coordinationProviderContract({
    ...f.providers,
    editor: f.issue("w1", "editor"),
    viewer: f.issue("w1", "viewer", "viewer"),
    manager: f.issue("w1", "manager", "admin"),
    issueId: "p1-i",
    projectId: "p1",
  });
});

test("audit session visibility, operation partition and event reader capabilities", async () => {
  const f = await fixture(),
    a = f.issue("w1", "a"),
    b = f.issue("w1", "b"),
    m = f.issue("w1", "m", "admin"),
    other = f.issue("w2", "a");
  for (const [s, id] of [
    [a, "sa"],
    [b, "sb"],
    [other, "sa"],
  ])
    await start(f.api, s, id);
  assert.deepEqual(
    (await f.api.listSessions(a)).map((x) => x.id),
    ["sa"],
  );
  assert.deepEqual(
    (await f.api.listSessions(m)).map((x) => x.id),
    ["sa", "sb"],
  );
  assert.deepEqual(
    (await f.api.listSessions(other)).map((x) => x.id),
    ["sa"],
  );
  await acquire(f.api, a, "sa", "p1-i");
  await acquire(f.api, other, "sa", "p1-other");
  assert.equal(await f.api.readOperation(b, "acq-sa-p1-i"), null);
  assert.equal(await f.api.readOperation(other, "acq-sa-p1-i"), null);
  const input = {
    operationId: "report",
    sessionId: "sa",
    issueId: "p1-i",
    fencingToken: 1,
    text: "working",
    status: "working",
  };
  await Promise.all([f.api.reportProgress(a, input), f.api.reportProgress(a, input)]);
  assert.equal((await f.api.listProgress(a, "p1-i")).items.length, 1);
  const events = await f.api.readEvents(f.eventReader, "w1", 0, 100);
  assert.deepEqual(
    events.map((x) => [x.type, x.workspaceId, x.actorId, x.subjectId]),
    [
      ["LeaseChanged", "w1", "a", "p1-i"],
      ["ProgressReported", "w1", "a", "p1-i"],
    ],
  );
  assert.deepEqual(await f.api.readEvents(f.eventReader, "w1", events[0].cursor, 1), [events[1]]);
  assert.equal((await f.api.readEvents(f.eventReader, "w2", 0, 100)).length, 1);
  assert.deepEqual(await f.api.readAgentEvents(b, 0, 100), []);
  assert.deepEqual(await f.api.readAgentEvents(a, 0, 100), events);
  await assert.rejects(f.api.readEvents({}, "w1", 0, 100), code("forbidden"));
  await assert.rejects(f.restart().readEvents(f.eventReader, "w1", 0, 100), code("forbidden"));
  await assert.rejects(f.api.readAgentEvents(a, -1, 100), code("validation"));
  await assert.rejects(f.api.readEvents(f.eventReader, "w1", 0, 101), code("validation"));
  await f.api.endSession(a, { operationId: "end", sessionId: "sa" });
  assert.equal((await f.api.listSessions(a))[0].live, false);
});

test("07c project pages bind tenant, project, both cursor components and live deadlines", async () => {
  const f = await fixture();
  const a = f.issue("w1", "a");
  const other = f.issue("w2", "b");
  for (const [scope, pid, suffix] of [
    [a, "p1", "a"],
    [a, "p1", "b"],
    [a, "p1", "c"],
    [a, "p2", "foreign"],
    [other, "p1", "foreign"],
  ]) {
    const sid = `${pid}-${suffix}`;
    await start(f.api, scope, sid);
    await acquire(f.api, scope, sid, sid);
    // Two tied timestamps plus a later timestamp exercise both progress cursor bounds.
    if (suffix === "c") f.advance(1);
    await f.api.reportProgress(scope, {
      operationId: `report-${sid}`,
      sessionId: sid,
      issueId: sid,
      fencingToken: 1,
      text: `${scope.workspaceId}:${sid}`,
      status: "working",
    });
    await f.api.claimFiles(scope, {
      operationId: `claim-${sid}`,
      sessionId: sid,
      repo: suffix === "c" ? "z-repo" : "repo",
      paths: [sid],
      leaseIssueId: sid,
      fencingToken: 1,
    });
  }
  const expected = {
    projectSessions: ["p1-a", "p1-b", "p1-c"],
    projectLeases: ["p1-a", "p1-b", "p1-c"],
    projectClaims: ["p1-a", "p1-b", "p1-c"],
    projectProgress: ["p1-c", "p1-b", "p1-a"],
  };
  for (const [method, ids] of Object.entries(expected)) {
    let cursor;
    const seen = [];
    for (let i = 0; i < 3; i++) {
      const page = await f.api[method](a, "p1", cursor, 1);
      assert.equal(page.items.length, 1, `${method} page size`);
      const item = page.items[0];
      seen.push(item.id ?? item.issueId ?? item.path);
      if (method === "projectProgress") assert.equal(item.text, `w1:${item.issueId}`);
      assert.equal(page.nextCursor === null, i === 2, `${method} terminal cursor`);
      cursor = page.nextCursor;
    }
    assert.deepEqual(seen, ids, method);
    assert.equal((await f.api[method](other, "p1")).items.length, 1, `${method} other tenant`);
    f.denied.add("w1:a:p1");
    await assert.rejects(f.api[method](a, "p1"), code("not_found"));
    f.denied.delete("w1:a:p1");
  }
  // Independent expiry predicates: live session with expired lease; expired session
  // with live lease. Storage fixture avoids one expiry masking the other.
  await f.db
    .prepare("UPDATE coord_leases SET expires_at=10001 WHERE workspace_id='w1' AND issue_id='p1-a'")
    .run();
  await f.db
    .prepare("UPDATE coord_sessions SET expires_at=10001 WHERE workspace_id='w1' AND id='p1-b'")
    .run();
  for (const method of ["projectSessions", "projectLeases"]) {
    const page = await f.api[method](a, "p1");
    assert.deepEqual(
      page.items.map((x) => x.id ?? x.issueId),
      ["p1-c"],
      method,
    );
  }
  await f.db
    .prepare(
      "UPDATE coord_file_claims SET expires_at=10001 WHERE workspace_id='w1' AND path='p1-c'",
    )
    .run();
  assert.deepEqual(
    (await f.api.projectClaims(a, "p1")).items.map((x) => x.path),
    ["p1-b"],
  );
  // Progress is history, deliberately retained when the holder expires.
  assert.equal((await f.api.projectProgress(a, "p1")).items.length, 3);
});

test("07c OAuth owner cannot set WIP cap; interactive owner retains CAS and retry", async () => {
  const f = await fixture();
  const actor = {
    id: "owner",
    workspaceId: "w1",
    role: "owner",
    kind: "human",
    scope: "write",
    active: true,
  };
  const oauth = f.auth.issue({ ...actor, clientId: "oauth-client" });
  const command = { operationId: "cap", projectId: "p1", cap: 2, expectedVersion: 0 };
  await assert.rejects(f.api.setProjectLimit(oauth, command), code("forbidden"));
  assert.deepEqual(await f.api.getProjectLimit(oauth, "p1"), {
    projectId: "p1",
    cap: 3,
    version: 0,
  });
  assert.equal(await f.api.readOperation(oauth, "cap"), null);
  const human = f.auth.issue(actor);
  const result = await f.api.setProjectLimit(human, command);
  for (const [scope, project] of [
    [human, "p2"],
    [f.auth.issue({ ...actor, workspaceId: "w2" }), "p1"],
  ]) {
    assert.deepEqual(await f.api.getProjectLimit(scope, project), {
      projectId: project,
      cap: 3,
      version: 0,
    });
  }
  assert.deepEqual(await f.api.setProjectLimit(human, command), result);
  await assert.rejects(
    f.api.setProjectLimit(human, { ...command, operationId: "stale" }),
    code("conflict"),
  );
});
