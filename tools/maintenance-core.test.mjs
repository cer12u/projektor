import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

let platform;
let mf;
let serial = 0;
before(async () => {
  fs.mkdirSync(".tmp", { recursive: true });
  await build({
    entryPoints: ["tools/maintenance-core-entry.ts"],
    outfile: ".tmp/test-entry.mjs",
    bundle: true,
    format: "esm",
    platform: "node",
  });
  platform = await import("../.tmp/test-entry.mjs");
  mf = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('ok')}}",
    compatibilityDate: "2026-07-30",
    d1Databases: Array.from({ length: 12 }, (_, i) => `MAINT${i}`),
    kvNamespaces: ["MAINTKV"],
  });
});
after(async () => mf?.dispose());

async function fixture(owner) {
  const db = await mf.getD1Database(`MAINT${serial++}`);
  await platform.migrate(db, [owner]);
  return {
    db,
    maintenance: platform[`${owner}Maintenance`](platform.createModuleStore(db, owner)),
  };
}
const run = (db, sql, ...values) =>
  db
    .prepare(sql)
    .bind(...values)
    .run();
const count = async (db, table, where = "workspace_id='w1'") =>
  (await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).first()).n;

function delayedStore(raw, owner) {
  let pending;
  const store = {
    owner,
    run: (...args) => raw.run(...args),
    async batch(calls) {
      if (pending) {
        const gate = pending;
        pending = undefined;
        gate.enter();
        await gate.releasePromise;
      }
      return raw.batch(calls);
    },
  };
  return {
    store,
    pause() {
      let enter;
      let release;
      const entered = new Promise((resolve) => (enter = resolve));
      const releasePromise = new Promise((resolve) => (release = resolve));
      pending = { enter, releasePromise };
      return { entered, release };
    },
  };
}

async function awaitAdmitted(gate, command) {
  let timer;
  try {
    await Promise.race([
      gate.entered,
      command.then(
        () => Promise.reject(new Error("Command completed before batch admission")),
        (error) => Promise.reject(error),
      ),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Command did not reach owner batch")), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("delayed public commands reject after freeze in four owners", async () => {
  const auth = platform.fakeAccess();
  const scope = auth.issue({
    id: "owner",
    workspaceId: "w1",
    role: "owner",
    kind: "human",
    scope: "write",
    active: true,
  });
  const clock = { now: () => 1000 };
  const ids = { next: () => crypto.randomUUID() };
  const project = {
    async authorizeProject() {
      return { id: "p1", key: "ONE", name: "One", version: 1, archived: false, role: "manager" };
    },
  };
  const cases = [
    {
      owner: "projects",
      make: (store) => platform.createProjects({ store, access: auth.access, clock, ids }),
      command: (api) =>
        api.createProject(scope, { operationId: "late", projectId: "p1", key: "ONE", name: "One" }),
      target: { workspaceId: "w1", projectId: "p1" },
      receipt: "projects_receipts",
    },
    {
      owner: "issues",
      make: (store) =>
        platform.createIssues({ store, access: auth.access, projects: project, clock, ids }),
      command: (api) =>
        api.createIssue(scope, {
          operationId: "late",
          issueId: "i1",
          projectId: "p1",
          title: "Title",
          description: "Text",
          priority: "medium",
        }),
      target: { workspaceId: "w1", projectId: "p1" },
      receipt: "issues_receipts",
    },
    {
      owner: "wiki",
      make: (store) => platform.createWiki({ store, projects: project, clock, ids }),
      command: (api) =>
        api.createPage(scope, {
          operationId: "late",
          pageId: "page1",
          projectId: "p1",
          slug: "page1",
          title: "Title",
          body: "Text",
        }),
      target: { workspaceId: "w1", projectId: "p1" },
      receipt: "wiki_receipts",
    },
    {
      owner: "coordination",
      make: (store) =>
        platform.createCoordination({
          store,
          access: auth.access,
          projects: project,
          issues: {},
          clock,
          ids,
        }),
      command: (api) =>
        api.startSession(scope, {
          operationId: "late",
          sessionId: "s1",
          agentLabel: "Agent",
          clientKind: "codex",
        }),
      target: { workspaceId: "w1" },
      receipt: "coord_receipts",
    },
  ];
  for (const { owner, make, command, target, receipt } of cases) {
    const { db } = await fixture(owner);
    const raw = platform.createModuleStore(db, owner);
    const delayed = delayedStore(raw, owner);
    const api = make(delayed.store).api;
    const gate = delayed.pause();
    const write = command(api);
    await awaitAdmitted(gate, write);
    await platform[`${owner}Maintenance`](raw).freezeScope(target);
    gate.release();
    await assert.rejects(write, (error) => error.code === "conflict");
    assert.equal(await count(db, receipt), 0);
  }
});

test("delayed Access public command rejects after workspace freeze", async () => {
  const { db } = await fixture("access");
  const raw = platform.createModuleStore(db, "access");
  const delayed = delayedStore(raw, "access");
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
  const issuer = "https://unit.cloudflareaccess.com";
  const jwk = {
    ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
    kid: "unit",
    alg: "RS256",
    use: "sig",
  };
  const now = 1800000000;
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const text = `${b64({ alg: "RS256", kid: "unit" })}.${b64({ iss: issuer, aud: ["test"], sub: "alice", email: "alice@example.test", type: "app", iat: now - 1, exp: now + 3600 })}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    pair.privateKey,
    new TextEncoder().encode(text),
  );
  const assertion = `${text}.${Buffer.from(signature).toString("base64url")}`;
  const api = platform.createAccess({
    store: delayed.store,
    kv: platform.createScopedKV(await mf.getKVNamespace("MAINTKV"), "access"),
    clock: { now: () => now },
    ids: { next: () => crypto.randomUUID() },
    config: { teamDomain: issuer, audience: "test" },
    fetchJwks: async () => ({ keys: [jwk] }),
  }).api;
  const principal = await api.authenticate({ kind: "human", assertion });
  await api.createWorkspace(principal, { workspaceId: "w1", name: "One", operationId: "setup" });
  const scope = await api.requireMembership(principal, "w1", "test");
  const gate = delayed.pause();
  const write = api.archiveWorkspace(scope, { expectedVersion: 1, operationId: "late" });
  await awaitAdmitted(gate, write);
  await platform.accessMaintenance(raw).freezeScope({ workspaceId: "w1" });
  gate.release();
  await assert.rejects(write, (error) => error.code === "conflict");
  assert.equal(await count(db, "access_receipts", "workspace_id='w1' AND operation_id='late'"), 0);
});

test("Projects freeze rejects delayed writes and bounded purge preserves other scopes", async () => {
  const { db, maintenance } = await fixture("projects");
  await run(
    db,
    "INSERT INTO projects_projects(workspace_id,id,project_key,name,version) VALUES('w1','p1','ONE','One',1),('w1','p2','TWO','Two',1),('w2','p1','ONE','Other',1)",
  );
  for (let i = 0; i < 51; i++)
    await run(
      db,
      "INSERT INTO projects_grants(workspace_id,project_id,principal_id,role,active) VALUES('w1','p1',?,'viewer',1)",
      `u${i}`,
    );
  const delayed = db.prepare(
    "INSERT INTO projects_grants(workspace_id,project_id,principal_id,role,active) VALUES('w1','p1','late','viewer',1)",
  );
  const frozen = await maintenance.freezeScope({ workspaceId: "w1", projectId: "p1" });
  assert.equal(frozen.state, "frozen");
  assert.equal(frozen.pending, 0);
  await assert.rejects(delayed.run(), /scope frozen/);
  await run(
    db,
    "INSERT INTO projects_grants(workspace_id,project_id,principal_id,role,active) VALUES('w1','p2','safe','viewer',1)",
  );
  const first = await maintenance.purgeScope({ workspaceId: "w1", projectId: "p1" });
  assert.equal(first.state, "purging");
  assert.equal(await count(db, "projects_grants", "workspace_id='w1' AND project_id='p1'"), 1);
  const done = await maintenance.purgeScope({ workspaceId: "w1", projectId: "p1" });
  assert.deepEqual(done, { state: "purged", remaining: 0, pending: 0 });
  assert.equal(await count(db, "projects_projects", "workspace_id='w1' AND id='p2'"), 1);
  assert.equal(await count(db, "projects_projects", "workspace_id='w2' AND id='p1'"), 1);
  await assert.rejects(delayed.run(), /scope frozen/);
});

test("workspace freeze blocks Access OAuth and removes tenant data without resetting marker", async () => {
  const { db, maintenance } = await fixture("access");
  await run(
    db,
    "INSERT INTO access_workspaces(workspace_id,name,version) VALUES('w1','One',1),('w2','Two',1)",
  );
  await maintenance.freezeScope({ workspaceId: "w1" });
  await assert.rejects(
    run(
      db,
      "INSERT INTO access_oauth_forms(workspace_id,token_hash,principal_id,expires_at) VALUES('w1','t','p',1)",
    ),
    /scope frozen/,
  );
  await assert.rejects(
    maintenance.freezeScope({ workspaceId: "w1", projectId: "p1" }),
    /Access accepts workspace/,
  );
  assert.equal((await maintenance.purgeScope({ workspaceId: "w1" })).state, "purged");
  assert.equal(await count(db, "access_workspaces", "workspace_id='w2'"), 1);
  await assert.rejects(
    run(db, "INSERT INTO access_workspaces(workspace_id,name,version) VALUES('w1','Again',1)"),
    /scope frozen/,
  );
});

for (const [owner, parent, child, parentInsert, childInsert] of [
  [
    "issues",
    "issues_issues",
    "issues_comments",
    "INSERT INTO issues_issues(workspace_id,id,project_id,number,title,description,priority,state,version) VALUES(?, ?, ?, 1,'Title','Text','medium','todo',1)",
    "INSERT INTO issues_comments(workspace_id,id,issue_id,body,actor_id,actor_kind,created_at) VALUES(?, ?, ?, 'Text','u','human',1)",
  ],
  [
    "wiki",
    "wiki_pages",
    "wiki_revisions",
    "INSERT INTO wiki_pages(workspace_id,id,project_id,slug,title,body,version) VALUES(?, ?, ?, 'slug','Title','Text',1)",
    "INSERT INTO wiki_revisions(workspace_id,page_id,version,action,title,body,actor_id,actor_kind,occurred_at) VALUES(?, ?, 1,'create','Title','Text','u','human',1)",
  ],
]) {
  test(`${owner} project freeze rejects delayed child write and purges only target`, async () => {
    const { db, maintenance } = await fixture(owner);
    await run(db, parentInsert, "w1", "item1", "p1");
    await run(db, parentInsert, "w1", "item2", "p2");
    await run(db, parentInsert, "w2", "item1", "p1");
    if (owner === "issues") {
      await run(db, childInsert, "w1", "c1", "item1");
      await run(db, childInsert, "w1", "c2", "item2");
    } else {
      await run(db, childInsert, "w1", "item1");
      await run(db, childInsert, "w1", "item2");
    }
    await maintenance.freezeScope({ workspaceId: "w1", projectId: "p1" });
    const delayed =
      owner === "issues"
        ? run(db, childInsert, "w1", "late", "item1")
        : run(db, childInsert, "w1", "item1");
    await assert.rejects(delayed, /scope frozen/);
    assert.equal(
      (await maintenance.purgeScope({ workspaceId: "w1", projectId: "p1" })).state,
      "purged",
    );
    assert.equal(await count(db, parent, "workspace_id='w1' AND id='item1'"), 0);
    assert.equal(await count(db, parent, "workspace_id='w1' AND id='item2'"), 1);
    assert.equal(await count(db, parent, "workspace_id='w2' AND id='item1'"), 1);
    assert.equal(await count(db, child, "workspace_id='w1'"), 1);
  });
}

test("Coordination retains workspace sessions while purging project claims and receipts", async () => {
  const { db, maintenance } = await fixture("coordination");
  await run(
    db,
    "INSERT INTO coord_sessions(workspace_id,id,principal_id,agent_label,client_kind,ttl_seconds,expires_at) VALUES('w1','s','u','Agent','codex',120,999)",
  );
  await run(
    db,
    "INSERT INTO coord_leases(workspace_id,issue_id,project_id,fencing_token,expires_at) VALUES('w1','i1','p1',1,999),('w1','i2','p2',1,999)",
  );
  await run(
    db,
    "INSERT INTO coord_file_claims(workspace_id,repo,path,session_id,lease_issue_id,expires_at,project_id) VALUES('w1','r','a','s','i1',999,'p1'),('w1','r','b','s','i2',999,'p2')",
  );
  await run(
    db,
    "INSERT INTO coord_receipts(workspace_id,principal_id,operation_id,fingerprint,result_json,project_id) VALUES('w1','u','o1','f','{}','p1'),('w1','u','o2','f','{}','p2')",
  );
  await maintenance.freezeScope({ workspaceId: "w1", projectId: "p1" });
  await assert.rejects(
    run(db, "UPDATE coord_file_claims SET project_id='p2' WHERE workspace_id='w1' AND path='a'"),
    /scope frozen/,
  );
  assert.equal(
    (await maintenance.purgeScope({ workspaceId: "w1", projectId: "p1" })).state,
    "purged",
  );
  assert.equal(await count(db, "coord_sessions"), 1);
  assert.equal(await count(db, "coord_file_claims", "workspace_id='w1' AND path='b'"), 1);
  assert.equal(await count(db, "coord_receipts", "workspace_id='w1' AND operation_id='o2'"), 1);
});
