import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

let platform;
let mf;
let keys;
let index = 0;
const issuer = "https://unit.cloudflareaccess.com";
const audience = "projektor-test";
const b64 = (value) =>
  Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
const code = (expected) => (error) => error.code === expected;
before(async () => {
  fs.mkdirSync(".tmp", { recursive: true });
  await build({
    entryPoints: ["tools/test-entry.ts"],
    outfile: ".tmp/test-entry.mjs",
    bundle: true,
    format: "esm",
    platform: "node",
  });
  platform = await import("../.tmp/test-entry.mjs");
  keys = await Promise.all(
    [0, 1].map(async (i) => {
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
      return {
        privateKey: pair.privateKey,
        jwk: {
          ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
          kid: `key-${i}`,
          alg: "RS256",
          use: "sig",
        },
      };
    }),
  );
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('test'); } }",
    compatibilityDate: "2026-07-30",
    d1Databases: Array.from({ length: 64 }, (_, i) => `DB${i}`),
    kvNamespaces: ["KV"],
  });
});
after(async () => {
  await mf?.dispose();
});
async function fixture() {
  const db = await mf.getD1Database(`DB${index++}`);
  await platform.migrate(db, ["access"]);
  const store = platform.createModuleStore(db, "access");
  const kv = platform.createScopedKV(await mf.getKVNamespace("KV"), "access");
  await kv.delete(`access:jwks:${issuer}`);
  await kv.delete(`access:jwks-refresh:${issuer}`);
  const state = {
    now: 1800000000,
    fetches: 0,
    published: [keys[0].jwk],
    hook: null,
    readHook: null,
  };
  const config = { teamDomain: issuer, audience };
  const deps = {
    store: {
      owner: "access",
      run: async (...args) => {
        const result = await store.run(...args);
        return state.readHook ? state.readHook(args, result) : result;
      },
      batch: (calls) => (state.hook ? state.hook(calls) : store.batch(calls)),
    },
    kv,
    clock: { now: () => state.now },
    ids: { next: () => crypto.randomUUID() },
    config,
    oauth: { issuer: "https://projektor.test", resource: "https://projektor.test/mcp" },
    fetchJwks: async (url) => {
      assert.equal(url, `${issuer}/cdn-cgi/access/certs`);
      state.fetches++;
      if (state.published === null) throw new Error("offline");
      return { keys: state.published };
    },
    enableBootstrap: true,
    eventConsumer: "test-consumer",
  };
  const created = platform.createAccess(deps);
  const sign = async (subject = "alice", overrides = {}, keyIndex = 0, header = {}) => {
    const encoded = `${b64({ alg: "RS256", kid: keys[keyIndex].jwk.kid, ...header })}.${b64({ iss: issuer, aud: [audience], sub: subject, email: `${subject}@example.test`, type: "app", iat: state.now - 1, exp: state.now + 3600, ...overrides })}`;
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keys[keyIndex].privateKey,
      new TextEncoder().encode(encoded),
    );
    return `${encoded}.${Buffer.from(signature).toString("base64url")}`;
  };
  const human = async (subject = "alice", api = created.api) =>
    api.authenticate({ kind: "human", assertion: await sign(subject) });
  const owner = async (w = "w1", subject = "alice") => {
    const principal = await human(subject);
    await created.api.createWorkspace(principal, {
      workspaceId: w,
      name: w,
      operationId: `create-${w}`,
    });
    return { principal, scope: await created.api.requireMembership(principal, w, "test") };
  };
  return { ...created, deps, state, db, store, kv, sign, human, owner };
}
const invite = (
  subject,
  role = "member",
  operationId = `invite-${subject}`,
  expectedVersion = 0,
) => ({ issuer, subject, role, operationId, expectedVersion });
const machineInput = { principalId: "bot", role: "member", operationId: "provision" };
const secret = "a1".repeat(32);
async function machine(f, scope, mode = "write", id = "key") {
  const p = await f.api.provisionMachine(scope, {
    ...machineInput,
    operationId: `provision-${id}`,
    principalId: `bot-${id}`,
  });
  const input = {
    principalId: p.id,
    credentialId: id,
    secret: id === "key" ? secret : "c3".repeat(32),
    scope: mode,
    expiresAt: f.state.now + 100,
    operationId: `issue-${id}`,
  };
  await f.api.issueCredential(scope, input);
  const bearer = `pt1.${scope.workspaceId}.${id}.${input.secret}`;
  const principal = await f.api.authenticate({ kind: "machine", bearer });
  return {
    id: p.id,
    input,
    bearer,
    principal,
    scope: await f.api.requireMembership(principal, scope.workspaceId, "machine"),
  };
}
test("rules: identifiers, roles, versions and issuer-separated identities without DB", async () => {
  const r = platform.accessRules;
  for (const bad of ["", "a.b", "../w"]) assert.throws(() => r.identifier(bad), code("validation"));
  for (const bad of [-1, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER])
    assert.throws(() => r.version(bad), code("validation"));
  assert.throws(() => r.role("superuser"), code("validation"));
  assert.throws(() => r.permission("admin"), code("validation"));
  for (const args of [
    ["member", undefined, "member"],
    ["admin", "owner", "member"],
    ["admin", "member", "admin"],
  ])
    assert.throws(() => r.manage(...args), code("forbidden"));
  r.manage("owner", "owner", "admin");
  r.manage("admin", "member", "viewer");
  assert.notEqual(await r.humanId(issuer, "same"), await r.humanId("other", "same"));
});
test("human JWT: RS256, trusted issuer/audience/times/human claims; JWKS cache, rotation and no provisioning", async () => {
  const f = await fixture();
  const valid = await f.sign();
  const p = await f.api.authenticate({ kind: "human", assertion: valid });
  assert.deepEqual(await f.api.listWorkspaces(p), []);
  for (const table of [
    "access_principals",
    "access_workspaces",
    "access_memberships",
    "access_receipts",
    "access_events",
  ])
    assert.equal((await f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n, 0);
  assert.equal(f.state.fetches, 1);
  await f.human();
  assert.equal(f.state.fetches, 1);
  for (const override of [
    { iss: "https://evil.test" },
    { aud: ["wrong"] },
    { exp: f.state.now },
    { exp: "tomorrow" },
    { iat: f.state.now + 1 },
    { nbf: f.state.now + 1 },
    { sub: "" },
    { email: "" },
    { type: "service" },
    { common_name: "service-token" },
    { service_token_id: "machine" },
  ])
    await assert.rejects(
      f.api.authenticate({ kind: "human", assertion: await f.sign("alice", override) }),
      code("forbidden"),
    );
  for (const header of [{ alg: "none" }, { alg: "HS256" }, { crit: ["extra"] }])
    await assert.rejects(
      f.api.authenticate({ kind: "human", assertion: await f.sign("alice", {}, 0, header) }),
      code("forbidden"),
    );
  const pieces = valid.split(".");
  pieces[1] = b64({ sub: "intruder" });
  await assert.rejects(
    f.api.authenticate({ kind: "human", assertion: pieces.join(".") }),
    code("forbidden"),
  );
  const wrongSignature = await f.sign("alice", {}, 1, { kid: keys[0].jwk.kid });
  await assert.rejects(
    f.api.authenticate({ kind: "human", assertion: wrongSignature }),
    code("forbidden"),
  );
  for (const assertion of ["garbage", "e30.e30.AA", "x".repeat(17000)])
    await assert.rejects(f.api.authenticate({ kind: "human", assertion }), code("forbidden"));
  f.state.published = [keys[1].jwk];
  await assert.rejects(
    f.api.authenticate({ kind: "human", assertion: await f.sign("bob", {}, 1) }),
    code("forbidden"),
  );
  assert.equal(f.state.fetches, 1);
  f.state.now += 31;
  await f.api.authenticate({ kind: "human", assertion: await f.sign("bob", {}, 1) });
  assert.equal(f.state.fetches, 2);
  await assert.rejects(
    f.api.authenticate({
      kind: "human",
      assertion: await f.sign("alice", {}, 0, { kid: "missing" }),
    }),
    code("forbidden"),
  );
  f.state.now += 301;
  f.state.published = null;
  await assert.rejects(
    f.api.authenticate({ kind: "human", assertion: await f.sign("bob", {}, 1) }),
    code("forbidden"),
  );
  await assert.rejects(f.kv.put("other:jwks", "bad"), /prefix/);
});
test("bootstrap: explicit one-time installation latch, concurrent attempts, retry, forged capabilities", async () => {
  const f = await fixture();
  const alice = await f.human();
  const bob = await f.human("bob");
  const input = { workspaceId: "w1", name: "first", operationId: "bootstrap" };
  await assert.rejects(f.api.bootstrap({}, alice, input), code("forbidden"));
  const results = await Promise.allSettled([
    f.api.bootstrap(f.operator, alice, input),
    f.api.bootstrap(f.operator, bob, { ...input, workspaceId: "w2" }),
  ]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  const winner = results[0].status === "fulfilled" ? alice : bob;
  const workspaceId = winner === alice ? "w1" : "w2";
  assert.deepEqual(await f.api.bootstrap(f.operator, winner, { ...input, workspaceId }), {
    id: workspaceId,
    version: 1,
  });
  await assert.rejects(
    f.api.bootstrap(f.operator, winner, { ...input, workspaceId, name: "changed" }),
    code("conflict"),
  );
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM access_workspaces").first()).n, 1);
  const restarted = platform.createAccess({ ...f.deps, enableBootstrap: false });
  await assert.rejects(restarted.api.bootstrap(f.operator, winner, input), code("forbidden"));
});
test("public provider contract: live scope provenance, roles, two tenants, no machine elevation, last owner", async () => {
  const f = await fixture();
  const { principal, scope } = await f.owner();
  const other = await f.owner("w2", "bob");
  await platform.membershipContract(f.api, principal, "w1");
  await platform.accessConsumerContract(f.api, scope);
  await assert.rejects(f.api.requireMembership({}, "w1", "forged"), code("forbidden"));
  await assert.rejects(f.api.authorize({ ...scope, workspaceId: "w2" }), code("forbidden"));
  await assert.rejects(f.api.authorize(Object.create(scope)), code("forbidden"));
  await assert.rejects(platform.createAccess(f.deps).api.authorize(scope), code("forbidden"));
  await assert.rejects(f.api.requireMembership(principal, "w2", "cross"), code("forbidden"));
  const charlie = await f.api.inviteMember(scope, invite("charlie", "admin"));
  const charlieAuth = await f.human("charlie");
  const admin = await f.api.requireMembership(charlieAuth, "w1", "admin");
  await assert.rejects(f.api.inviteMember(admin, invite("dana", "owner")), code("forbidden"));
  await assert.rejects(
    f.api.changeRole(admin, {
      principalId: scope.principalId,
      role: "viewer",
      expectedVersion: 1,
      operationId: "takeover",
    }),
    code("forbidden"),
  );
  await f.api.inviteMember(admin, invite("dana", "viewer"));
  const viewer = await f.api.requireMembership(await f.human("dana"), "w1", "viewer");
  await assert.rejects(f.api.authorize(viewer, "write"), code("forbidden"));
  await assert.rejects(f.api.provisionMachine(viewer, machineInput), code("forbidden"));
  await assert.rejects(f.api.getPrincipalSummary(other.scope, charlie.id), code("not_found"));
  await assert.rejects(
    f.api.removeMember(scope, {
      principalId: scope.principalId,
      expectedVersion: 1,
      operationId: "last-owner",
    }),
    code("conflict"),
  );
  assert.equal(await f.api.readOperation(scope, "last-owner"), null);
  await f.api.changeRole(scope, {
    principalId: charlie.id,
    role: "member",
    expectedVersion: 1,
    operationId: "demote",
  });
  await assert.rejects(f.api.provisionMachine(admin, machineInput), code("forbidden"));
  await f.api.removeMember(scope, {
    principalId: charlie.id,
    expectedVersion: 2,
    operationId: "remove",
  });
  await assert.rejects(f.api.authorize(admin), code("forbidden"));
  await f.api.inviteMember(scope, invite("charlie", "member", "restore", 3));
  assert.equal((await f.api.getMembership(scope, charlie.id)).version, 4);
});
test("machine credentials: hash-only storage, read/write ceiling, confinement, revocation/expiry and interactive management", async () => {
  const f = await fixture();
  const { scope } = await f.owner();
  const other = await f.owner("w2");
  const read = await machine(f, scope, "read", "read");
  const write = await machine(f, scope);
  await assert.rejects(f.api.authorize(read.scope, "write"), code("forbidden"));
  await f.api.authorize(write.scope, "write");
  await assert.rejects(f.api.requireMembership(write.principal, "w2", "cross"), code("forbidden"));
  assert.deepEqual(
    (await f.api.listWorkspaces(write.principal)).map((w) => w.id),
    ["w1"],
  );
  await assert.rejects(
    f.api.authenticate({ kind: "machine", bearer: write.bearer.replace(".w1.", ".w2.") }),
    code("forbidden"),
  );
  await assert.rejects(
    f.api.authenticate({ kind: "machine", bearer: `pt1.w1.key.${"b2".repeat(32)}` }),
    code("forbidden"),
  );
  await assert.rejects(
    f.api.provisionMachine(write.scope, { ...machineInput, operationId: "self" }),
    code("forbidden"),
  );
  await assert.rejects(
    f.api.issueCredential(write.scope, { ...write.input, operationId: "self-issue" }),
    code("forbidden"),
  );
  await assert.rejects(
    f.api.changeRole(scope, {
      principalId: write.id,
      role: "admin",
      expectedVersion: 1,
      operationId: "machine-admin",
    }),
    code("forbidden"),
  );
  await assert.rejects(f.api.getCredential(other.scope, "key"), code("not_found"));
  await assert.rejects(
    f.api.issueCredential(other.scope, { ...write.input, operationId: "cross" }),
    code("not_found"),
  );
  for (const table of ["access_credentials", "access_receipts", "access_events"])
    assert(
      !JSON.stringify((await f.db.prepare(`SELECT * FROM ${table}`).all()).results).includes(
        secret,
      ),
    );
  const record = await f.db
    .prepare("SELECT token_hash FROM access_credentials WHERE workspace_id='w1' AND id='key'")
    .first();
  assert.equal(record.token_hash, await platform.accessRules.hash(secret));
  assert.deepEqual(await f.api.issueCredential(scope, write.input), { id: "key", version: 1 });
  await f.api.revokeCredential(scope, {
    credentialId: "key",
    expectedVersion: 1,
    operationId: "revoke",
  });
  await assert.rejects(f.api.authorize(write.scope), code("forbidden"));
  await assert.rejects(
    f.api.authenticate({ kind: "machine", bearer: write.bearer }),
    code("forbidden"),
  );
  f.state.now += 100;
  await assert.rejects(f.api.authorize(read.scope), code("forbidden"));
  await assert.rejects(
    f.api.authenticate({ kind: "machine", bearer: read.bearer }),
    code("forbidden"),
  );
  f.state.now += 3600;
  await assert.rejects(f.api.authorize(scope), code("forbidden"));
});
test("machine removal revokes credentials atomically; role downgrade limits existing scopes", async () => {
  const f = await fixture();
  const { scope } = await f.owner();
  const bot = await machine(f, scope);
  await f.api.changeRole(scope, {
    principalId: bot.id,
    role: "viewer",
    expectedVersion: 1,
    operationId: "lower",
  });
  await assert.rejects(f.api.authorize(bot.scope, "write"), code("forbidden"));
  await f.api.removeMember(scope, {
    principalId: bot.id,
    expectedVersion: 2,
    operationId: "remove-bot",
  });
  assert.equal((await f.api.getCredential(scope, "key")).revoked, true);
  await assert.rejects(
    f.api.authenticate({ kind: "machine", bearer: bot.bearer }),
    code("forbidden"),
  );
});
test("CAS, concurrent idempotent retry, input fingerprint, receipt isolation and ordered versioned outbox", async () => {
  const f = await fixture();
  const { scope } = await f.owner();
  const other = await f.owner("w2");
  const input = invite("charlie");
  const outputs = await Promise.all([
    f.api.inviteMember(scope, input),
    f.api.inviteMember(scope, { ...input }),
  ]);
  assert.deepEqual(outputs[0], outputs[1]);
  const id = outputs[0].id;
  await assert.rejects(f.api.inviteMember(scope, { ...input, role: "viewer" }), code("conflict"));
  const races = await Promise.allSettled([
    f.api.changeRole(scope, {
      principalId: id,
      role: "viewer",
      expectedVersion: 1,
      operationId: "race1",
    }),
    f.api.changeRole(scope, {
      principalId: id,
      role: "admin",
      expectedVersion: 1,
      operationId: "race2",
    }),
  ]);
  assert.equal(races.filter((r) => r.status === "fulfilled").length, 1);
  const receipts = await Promise.all([
    f.api.readOperation(scope, "race1"),
    f.api.readOperation(scope, "race2"),
  ]);
  assert.equal(receipts.filter(Boolean).length, 1);
  assert.equal(await f.api.readOperation(other.scope, input.operationId), null);
  const charlie = await f.api.requireMembership(await f.human("charlie"), "w1", "charlie");
  assert.equal(await f.api.readOperation(charlie, input.operationId), null);
  const events = await f.api.readEvents(f.eventReader, "w1", 0, 100);
  assert.deepEqual(
    events.map((e) => e.cursor),
    [1, 2, 3],
  );
  assert(
    events.every((e) => e.source === "access" && e.schemaVersion === 1 && e.workspaceId === "w1"),
  );
  assert.equal(events[2].aggregateVersion, 2);
  assert.deepEqual(await f.api.readEvents(f.eventReader, "w1", 2, 1), [events[2]]);
  await assert.rejects(f.api.readEvents({}, "w1", 0, 1), code("forbidden"));
  await assert.rejects(
    platform
      .createAccess({ ...f.deps, eventConsumer: undefined })
      .api.readEvents(f.eventReader, "w1", 0, 1),
    code("forbidden"),
  );
  await assert.rejects(f.api.readEvents(f.eventReader, "w1", 0, 101), code("validation"));
  assert.equal((await f.store.run("workspace", ["w2"])).rows[0].archived, 0);
});
test("atomic rollback includes principal, membership, receipt and outbox; response loss and restart recover durable results", async () => {
  const f = await fixture();
  const { scope } = await f.owner();
  const beforeEvents = await f.api.readEvents(f.eventReader, "w1", 0, 100);
  f.state.hook = (calls) =>
    f.store.batch([...calls, { name: "createWorkspace", values: ["w1", "duplicate"] }]);
  await assert.rejects(f.api.inviteMember(scope, invite("rollback")), code("conflict"));
  assert.equal(
    (await f.store.run("principal", [await platform.accessRules.humanId(issuer, "rollback")])).rows
      .length,
    0,
  );
  assert.equal(await f.api.readOperation(scope, "invite-rollback"), null);
  assert.deepEqual(await f.api.readEvents(f.eventReader, "w1", 0, 100), beforeEvents);
  f.state.hook = async (calls) => {
    await f.store.batch(calls);
    throw new Error("lost commit response");
  };
  const expected = await f.api.inviteMember(scope, invite("recovered"));
  f.state.hook = null;
  const restarted = platform.createAccess(f.deps).api;
  const p = await f.human("alice", restarted);
  const newScope = await restarted.requireMembership(p, "w1", "restart");
  assert.deepEqual(await restarted.readOperation(newScope, "invite-recovered"), expected);
  assert.deepEqual(await restarted.inviteMember(newScope, invite("recovered")), expected);
  f.state.hook = async () => {
    throw new Error("unavailable");
  };
  await assert.rejects(f.api.inviteMember(scope, invite("unknown")), code("unknown"));
  assert.equal(await f.api.readOperation(scope, "invite-unknown"), null);
  f.state.hook = null;
  await f.api.inviteMember(scope, invite("unknown"));
});
test("Q1 admission race: admitted command may commit after demotion; new command and revoked receipt read are rejected", async () => {
  const f = await fixture();
  const { scope } = await f.owner();
  const admin = await f.api.inviteMember(scope, invite("admin", "admin"));
  const adminScope = await f.api.requireMembership(await f.human("admin"), "w1", "admin");
  let entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  f.state.hook = async (calls) => {
    f.state.hook = null;
    entered();
    await held;
    return f.store.batch(calls);
  };
  const inflight = f.api.provisionMachine(adminScope, machineInput);
  await ready;
  await f.api.changeRole(scope, {
    principalId: admin.id,
    role: "member",
    expectedVersion: 1,
    operationId: "demote-inflight",
  });
  release();
  const applied = await inflight;
  assert.equal(applied.version, 1);
  await assert.rejects(
    f.api.provisionMachine(adminScope, { ...machineInput, operationId: "after" }),
    code("forbidden"),
  );
  assert.deepEqual(await f.api.readOperation(adminScope, "provision"), applied);
  await f.api.removeMember(scope, {
    principalId: admin.id,
    expectedVersion: 2,
    operationId: "remove-admin",
  });
  await assert.rejects(f.api.readOperation(adminScope, "provision"), code("forbidden"));
});
test("concurrent last-owner changes leave an owner; archive immediately denies live admission and replay", async () => {
  const f = await fixture();
  const { scope } = await f.owner();
  const bob = await f.api.inviteMember(scope, invite("bob", "owner"));
  const races = await Promise.allSettled([
    f.api.changeRole(scope, {
      principalId: scope.principalId,
      role: "member",
      expectedVersion: 1,
      operationId: "lower-alice",
    }),
    f.api.changeRole(scope, {
      principalId: bob.id,
      role: "member",
      expectedVersion: 1,
      operationId: "lower-bob",
    }),
  ]);
  assert.equal(races.filter((r) => r.status === "fulfilled").length, 1);
  const owners = (
    await f.db
      .prepare(
        "SELECT principal_id FROM access_memberships WHERE workspace_id='w1' AND role='owner' AND active=1",
      )
      .all()
  ).results;
  assert.equal(owners.length, 1);
  const principal = await f.human(owners[0].principal_id === bob.id ? "bob" : "alice");
  const active = await f.api.requireMembership(principal, "w1", "archive");
  await assert.rejects(
    f.api.archiveWorkspace(active, { expectedVersion: 2, operationId: "stale-archive" }),
    code("conflict"),
  );
  await f.api.archiveWorkspace(active, { expectedVersion: 1, operationId: "archive" });
  await assert.rejects(f.api.authorize(scope), code("forbidden"));
  await assert.rejects(f.api.readOperation(active, "archive"), code("forbidden"));
  assert.deepEqual(await f.api.listWorkspaces(principal), []);
  assert.equal(
    (await f.api.readEvents(f.eventReader, "w1", 0, 100)).at(-1).type,
    "WorkspaceArchived",
  );
});

test("admin cannot race a target promotion using a guessed future version", async () => {
  const f = await fixture();
  const { scope } = await f.owner();
  await f.api.inviteMember(scope, invite("admin", "admin"));
  const target = await f.api.inviteMember(scope, invite("target", "member"));
  const admin = await f.api.requireMembership(await f.human("admin"), "w1", "admin");
  let entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  f.state.readHook = async ([name, values], result) => {
    if (name === "membership" && values[1] === target.id) {
      f.state.readHook = null;
      entered();
      await held;
    }
    return result;
  };
  const attack = f.api.changeRole(admin, {
    principalId: target.id,
    role: "viewer",
    expectedVersion: 2,
    operationId: "race-promotion",
  });
  await ready;
  await f.api.changeRole(scope, {
    principalId: target.id,
    role: "owner",
    expectedVersion: 1,
    operationId: "promote-target",
  });
  release();
  await assert.rejects(attack, code("conflict"));
  assert.equal((await f.api.getMembership(scope, target.id)).role, "owner");
  assert.equal(await f.api.readOperation(admin, "race-promotion"), null);
});

test("public commands reject malformed runtime input before writing", async () => {
  const f = await fixture();
  const { principal, scope } = await f.owner();
  for (const input of [null, undefined, [], "bad"]) {
    await assert.rejects(f.api.authenticate(input), code("forbidden"));
    await assert.rejects(f.api.createWorkspace(principal, input), code("validation"));
    for (const name of [
      "inviteMember",
      "changeRole",
      "removeMember",
      "provisionMachine",
      "issueCredential",
      "revokeCredential",
      "archiveWorkspace",
    ]) {
      await assert.rejects(f.api[name](scope, input), code("validation"));
    }
  }
  assert.equal((await f.api.readEvents(f.eventReader, "w1", 0, 100)).length, 1);
});

const resource = "https://projektor.test/mcp";
const oauthInput = {
  client_name: "Test MCP",
  redirect_uris: ["https://client.test/cb", "http://127.0.0.1/callback", "http://[::1]/callback"],
  token_endpoint_auth_method: "none",
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  scope: "read write",
};
const verifier = "a".repeat(43);
async function authorization(f, owner, client, overrides = {}, op = crypto.randomUUID()) {
  const request = {
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    response_type: "code",
    code_challenge: await platform.oauthRules.challenge(verifier),
    code_challenge_method: "S256",
    resource,
    scope: "read write",
    state: "state + &=雪",
    ...overrides,
  };
  const consent = await f.api.getOAuthConsent(owner.principal, request, owner.scope);
  const input = { operationId: op, codeSecret: platform.oauthRules.randomSecret() };
  const response = await f.api.approveOAuthConsent(owner.scope, consent, input);
  const exchange = {
    grant_type: "authorization_code",
    client_id: client.client_id,
    resource,
    code: response.code,
    redirect_uri: request.redirect_uri,
    code_verifier: verifier,
  };
  return { request, consent, input, response, exchange };
}
const refreshInput = (client, tokens, extra = {}) => ({
  grant_type: "refresh_token",
  client_id: client.client_id,
  resource,
  refresh_token: tokens.refresh_token,
  ...extra,
});
const oauthLogin = (f, tokens, extra = {}) =>
  f.api.authenticate({ kind: "oauth", bearer: tokens.access_token, resource, ...extra });
async function oauthFixture() {
  const f = await fixture();
  const owner = await f.owner();
  const client = await f.api.registerOAuthClient(oauthInput);
  return { ...f, ownerIdentity: owner, client };
}

test("current principal, member/client pages and revocation stay workspace scoped", async () => {
  const f = await oauthFixture();
  const other = await f.owner("w2", "bob");
  const empty = await f.human("unjoined");
  assert.deepEqual((await f.api.me(empty)).workspaces, []);
  assert.deepEqual(
    (await f.api.me(f.ownerIdentity.principal)).workspaces.map((w) => w.id),
    ["w1"],
  );
  await f.api.inviteMember(f.ownerIdentity.scope, invite("charlie"));
  const first = await f.api.listMembers(f.ownerIdentity.scope, "", 1);
  assert.equal(first.items.length, 1);
  assert.equal(
    (await f.api.listMembers(f.ownerIdentity.scope, first.nextCursor, 1)).items.length,
    1,
  );
  assert.deepEqual(
    (await f.api.listMembers(other.scope)).items.map((m) => m.displayName),
    ["bob"],
  );
  const auth = await authorization(f, f.ownerIdentity, f.client);
  const tokens = await f.api.exchangeOAuthToken(auth.exchange);
  const oauth = await oauthLogin(f, tokens);
  assert.equal((await f.api.me(oauth)).principal.kind, "oauth");
  assert.deepEqual(
    (await f.api.me(oauth)).workspaces.map((w) => w.id),
    ["w1"],
  );
  const listed = await f.api.listOAuthClients(f.ownerIdentity.scope);
  assert.equal(listed.items[0].clientId, f.client.client_id);
  assert.deepEqual((await f.api.listOAuthClients(other.scope)).items, []);
  const viewerMember = await f.api.inviteMember(f.ownerIdentity.scope, invite("viewer", "viewer"));
  const viewer = await f.api.requireMembership(await f.human("viewer"), "w1", "viewer");
  assert.equal(viewerMember.version, 1);
  await assert.rejects(f.api.listOAuthClients(viewer), code("forbidden"));
  await assert.rejects(
    f.api.revokeOAuthClient(viewer, {
      clientId: f.client.client_id,
      expectedVersion: 1,
      operationId: "no",
    }),
    code("forbidden"),
  );
  const client2 = await f.api.registerOAuthClient({ ...oauthInput, client_name: "Other" });
  const auth2 = await authorization(f, f.ownerIdentity, client2);
  const tokens2 = await f.api.exchangeOAuthToken(auth2.exchange);
  const command = { clientId: f.client.client_id, expectedVersion: 1, operationId: "revoke-page" };
  const result = await f.api.revokeOAuthClient(f.ownerIdentity.scope, command);
  assert.deepEqual(await f.api.revokeOAuthClient(f.ownerIdentity.scope, command), result);
  await assert.rejects(oauthLogin(f, tokens), code("forbidden"));
  await assert.rejects(
    f.api.exchangeOAuthToken(refreshInput(f.client, tokens)),
    code("invalid_grant"),
  );
  await oauthLogin(f, tokens2);
});

test("OAuth rules: HTTPS/exact redirects, IP loopback port exception, registration limits and S256", async () => {
  const r = platform.oauthRules;
  for (const uri of [
    "http://client.test/cb",
    "http://localhost/cb",
    "https://*.test/cb",
    "https://client.test/#x",
    "https://u:p@client.test/cb",
    "javascript:alert(1)",
    "https://client.test\\evil",
    "https://client.test/ cb",
  ])
    assert.throws(() => r.redirectUri(uri), code("invalid_redirect_uri"));
  assert.equal(r.redirectMatches("http://127.0.0.1/cb", "http://127.0.0.1:43891/cb"), true);
  assert.equal(r.redirectMatches("http://[::1]/cb", "http://[::1]:43891/cb"), true);
  assert.equal(r.redirectMatches("https://client.test/cb", "https://client.test:444/cb"), false);
  assert.equal(r.redirectMatches("http://127.0.0.1/cb", "http://127.0.0.1:123/other"), false);
  for (const input of [
    null,
    {},
    { ...oauthInput, redirect_uris: [] },
    { ...oauthInput, redirect_uris: Array(11).fill("https://a.test") },
    { ...oauthInput, client_name: "a".repeat(129) },
    { ...oauthInput, token_endpoint_auth_method: "client_secret_basic" },
    { ...oauthInput, grant_types: ["client_credentials"] },
    { ...oauthInput, response_types: ["token"] },
  ])
    assert.throws(
      () => r.registration(input),
      (e) => ["invalid_request", "invalid_client_metadata"].includes(e.code),
    );
  assert.throws(() => r.scopes("read admin"), code("invalid_scope"));
  assert.equal(
    await r.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

test("JWKS attacker kids: concurrent misses, restart and failed fetches obey issuer cooldown", async () => {
  const f = await fixture();
  await f.human();
  const attack = await Promise.all(
    Array.from({ length: 8 }, (_, i) => f.sign("alice", {}, 0, { kid: `attack-${i}` })),
  );
  for (const assertion of attack)
    await assert.rejects(f.api.authenticate({ kind: "human", assertion }), code("forbidden"));
  assert.equal(f.state.fetches, 1);
  f.state.now += 31;
  await Promise.all(
    attack.map((assertion) =>
      assert.rejects(f.api.authenticate({ kind: "human", assertion }), code("forbidden")),
    ),
  );
  assert.equal(f.state.fetches, 2);
  const restarted = platform.createAccess(f.deps).api;
  await assert.rejects(
    restarted.authenticate({ kind: "human", assertion: attack[0] }),
    code("forbidden"),
  );
  assert.equal(f.state.fetches, 3); // Cold restart fetches trusted keys, never KV keys.
  await f.human("alice", restarted);
  await assert.rejects(
    restarted.authenticate({ kind: "human", assertion: attack[1] }),
    code("forbidden"),
  );
  assert.equal(f.state.fetches, 3);
  await f.human(); // Known keys remain usable while the cooldown is active.
  f.state.now += 31;
  f.state.published = null;
  await assert.rejects(
    f.api.authenticate({ kind: "human", assertion: attack[0] }),
    code("forbidden"),
  );
  await assert.rejects(
    f.api.authenticate({ kind: "human", assertion: attack[1] }),
    code("forbidden"),
  );
  assert.equal(f.state.fetches, 4);
});

test("OAuth metadata, public DCR quota, no confidential secrets and authorization validation", async () => {
  const f = await oauthFixture();
  for (const bad of [
    "https://projektor.test/mcp#",
    "https://projektor.test/mcp?",
    "http://projektor.test/mcp",
  ]) {
    assert.throws(
      () => platform.createAccess({ ...f.deps, oauth: { ...f.deps.oauth, resource: bad } }),
      code("validation"),
    );
  }
  const metadata = f.api.getAuthorizationServerMetadata();
  assert.equal(metadata.issuer, "https://projektor.test");
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ["none"]);
  assert.deepEqual(f.api.getProtectedResourceMetadata(), {
    resource,
    authorization_servers: [metadata.issuer],
    scopes_supported: ["read", "write"],
    bearer_methods_supported: ["header"],
  });
  assert.equal(f.client.client_secret, undefined);
  const auth = await authorization(f, f.ownerIdentity, f.client, {
    redirect_uri: "http://127.0.0.1:19345/callback",
  });
  assert.equal(auth.response.state, auth.request.state);
  assert.equal(auth.response.iss, metadata.issuer);
  for (const [overrides, expected] of [
    [{ response_type: "token" }, "unsupported_response_type"],
    [{ code_challenge_method: "plain" }, "invalid_request"],
    [{ code_challenge: "bad" }, "invalid_request"],
    [{ resource: "https://other.test/mcp" }, "invalid_target"],
    [{ resource: undefined }, "invalid_target"],
    [{ redirect_uri: "https://evil.test/cb" }, "invalid_redirect_uri"],
    [{ scope: "admin" }, "invalid_scope"],
    [{ client_id: "missing" }, "invalid_client"],
    [{ state: "x".repeat(2049) }, "invalid_request"],
  ])
    await assert.rejects(
      f.api.getOAuthConsent(
        f.ownerIdentity.principal,
        { ...auth.request, ...overrides },
        f.ownerIdentity.scope,
      ),
      code(expected),
    );
  await assert.rejects(
    f.api.getOAuthConsent(
      f.ownerIdentity.principal,
      { ...auth.request, scope: "admin" },
      f.ownerIdentity.scope,
    ),
    (e) =>
      e.code === "invalid_scope" &&
      e.authorizationRedirect.redirect_uri === auth.request.redirect_uri &&
      e.authorizationRedirect.state === auth.request.state,
  );
  await assert.rejects(
    f.api.getOAuthConsent(
      f.ownerIdentity.principal,
      {
        ...auth.request,
        redirect_uri: "https://evil.test/cb",
      },
      f.ownerIdentity.scope,
    ),
    (e) => e.code === "invalid_redirect_uri" && e.authorizationRedirect === undefined,
  );
  for (let i = 1; i < 99; i++) await f.api.registerOAuthClient(oauthInput);
  const race = await Promise.allSettled([
    f.api.registerOAuthClient(oauthInput),
    f.api.registerOAuthClient(oauthInput),
  ]);
  assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(race.find((r) => r.status === "rejected").reason.code, "temporarily_unavailable");
  f.state.now += 3601;
  await f.api.registerOAuthClient(oauthInput);
});

test("OAuth public API: same human, client attribution, workspace confinement, scope ceiling and interactive-only management", async () => {
  const f = await oauthFixture();
  const other = await f.owner("w2");
  const auth = await authorization(f, f.ownerIdentity, f.client, { scope: "read" });
  const tokens = await f.api.exchangeOAuthToken(auth.exchange);
  const principal = await oauthLogin(f, tokens);
  const scope = await f.api.requireMembership(principal, "w1", "oauth");
  assert.equal(scope.principalId, f.ownerIdentity.scope.principalId);
  assert.equal(scope.kind, "human");
  assert.equal(scope.clientId, f.client.client_id);
  assert.deepEqual(
    (await f.api.listWorkspaces(principal)).map((w) => w.id),
    ["w1"],
  );
  await platform.membershipContract(f.api, principal, "w1");
  await assert.rejects(f.api.requireMembership(principal, "w2", "cross"), code("forbidden"));
  await assert.rejects(f.api.authorize(scope, "write"), code("forbidden"));
  await assert.rejects(
    oauthLogin(f, tokens, { resource: "https://wrong.test/mcp" }),
    code("forbidden"),
  );
  await assert.rejects(
    oauthLogin(f, { access_token: tokens.access_token.replace(".w1.", ".w2.") }),
    code("forbidden"),
  );
  await assert.rejects(
    f.api.authenticate({ kind: "machine", bearer: tokens.access_token }),
    code("forbidden"),
  );
  await assert.rejects(
    f.api.createWorkspace(principal, {
      workspaceId: "escape",
      name: "escape",
      operationId: "escape",
    }),
    code("forbidden"),
  );
  await assert.rejects(f.api.getOAuthConsent(principal, auth.request, scope), code("forbidden"));
  await assert.rejects(f.api.provisionMachine(scope, machineInput), code("forbidden"));
  await assert.rejects(f.api.getOAuthClient(other.scope, f.client.client_id), code("not_found"));
  const bot = await machine(f, f.ownerIdentity.scope);
  await assert.rejects(
    f.api.getOAuthConsent(bot.principal, auth.request, bot.scope),
    code("forbidden"),
  );
  const writeAuth = await authorization(f, f.ownerIdentity, f.client);
  const writeTokens = await f.api.exchangeOAuthToken(writeAuth.exchange);
  const writer = await oauthLogin(f, writeTokens);
  const writable = await f.api.requireMembership(writer, "w1", "write", "write");
  await assert.rejects(f.api.provisionMachine(writable, machineInput), code("forbidden"));
  const restarted = platform.createAccess(f.deps).api;
  const restartedPrincipal = await restarted.authenticate({
    kind: "oauth",
    bearer: tokens.access_token,
    resource,
  });
  assert.equal(
    (await restarted.requireMembership(restartedPrincipal, "w1", "restart")).principalId,
    scope.principalId,
  );
});

test("OAuth consent: principal/provenance, explicit workspace, idempotent operation, conflict and hash-only persistence", async () => {
  const f = await oauthFixture();
  const other = await f.owner("w2", "bob");
  const sameHumanElsewhere = await f.owner("w3");
  const auth = await authorization(f, f.ownerIdentity, f.client);
  assert.deepEqual(
    await f.api.approveOAuthConsent(f.ownerIdentity.scope, auth.consent, auth.input),
    auth.response,
  );
  assert.equal(
    (await f.api.readOperation(f.ownerIdentity.scope, auth.input.operationId)).version,
    1,
  );
  assert.equal(await f.api.readOperation(other.scope, auth.input.operationId), null);
  await assert.rejects(
    f.api.approveOAuthConsent(f.ownerIdentity.scope, auth.consent, {
      ...auth.input,
      codeSecret: "b".repeat(64),
    }),
    code("conflict"),
  );
  await assert.rejects(
    f.api.approveOAuthConsent(other.scope, auth.consent, auth.input),
    code("access_denied"),
  );
  await assert.rejects(
    f.api.approveOAuthConsent(sameHumanElsewhere.scope, auth.consent, auth.input),
    code("access_denied"),
  );
  await assert.rejects(
    f.api.getOAuthConsent(f.ownerIdentity.principal, auth.request, other.scope),
    code("access_denied"),
  );
  await assert.rejects(
    f.api.approveOAuthConsent(f.ownerIdentity.scope, { ...auth.consent }, auth.input),
    code("access_denied"),
  );
  const tokens = await f.api.exchangeOAuthToken(auth.exchange);
  const raw = JSON.stringify(
    await Promise.all(
      [
        "access_oauth_codes",
        "access_oauth_tokens",
        "access_oauth_families",
        "access_events",
        "access_receipts",
      ].map((table) => f.db.prepare(`SELECT * FROM ${table}`).all()),
    ),
  );
  for (const value of [
    auth.input.codeSecret,
    auth.response.code,
    tokens.access_token,
    tokens.refresh_token,
    verifier,
  ])
    assert.equal(raw.includes(value), false);
  assert.equal((await f.db.prepare("SELECT count(*) n FROM access_oauth_tokens").first()).n, 2);
  assert.equal(
    (await f.api.readEvents(f.eventReader, "w1", 0, 100)).filter(
      (e) => e.type === "OAuthConsentGranted",
    ).length,
    1,
  );
});

test("OAuth code security: bad PKCE, redirect, client and resource do not consume; code replay revokes issued family", async () => {
  const f = await oauthFixture();
  const auth = await authorization(f, f.ownerIdentity, f.client);
  const foreign = await f.api.registerOAuthClient(oauthInput);
  for (const overrides of [
    { code_verifier: "b".repeat(43) },
    { code_verifier: "short" },
    { redirect_uri: "https://client.test/other" },
    { client_id: foreign.client_id },
    { code: auth.response.code.replace(".w1.", ".w2.") },
  ])
    await assert.rejects(
      f.api.exchangeOAuthToken({ ...auth.exchange, ...overrides }),
      code("invalid_grant"),
    );
  await assert.rejects(
    f.api.exchangeOAuthToken({ ...auth.exchange, resource: "https://foreign.test/mcp" }),
    code("invalid_target"),
  );
  const tokens = await f.api.exchangeOAuthToken(auth.exchange);
  await oauthLogin(f, tokens);
  await assert.rejects(f.api.exchangeOAuthToken(auth.exchange), code("invalid_grant"));
  await assert.rejects(oauthLogin(f, tokens), code("forbidden"));
  await assert.rejects(
    f.api.exchangeOAuthToken(refreshInput(f.client, tokens)),
    code("invalid_grant"),
  );
  const expired = await authorization(f, f.ownerIdentity, f.client);
  f.state.now += 121;
  await assert.rejects(f.api.exchangeOAuthToken(expired.exchange), code("invalid_grant"));
});

test("OAuth refresh: rotation, narrowing, no escalation, foreign client, expiry, reuse revokes whole family", async () => {
  const f = await oauthFixture();
  const auth = await authorization(f, f.ownerIdentity, f.client);
  const first = await f.api.exchangeOAuthToken(auth.exchange);
  const foreign = await f.api.registerOAuthClient(oauthInput);
  await assert.rejects(
    f.api.exchangeOAuthToken(refreshInput(foreign, first)),
    code("invalid_grant"),
  );
  await assert.rejects(
    f.api.exchangeOAuthToken(refreshInput(f.client, first, { resource: "https://wrong.test" })),
    code("invalid_target"),
  );
  const second = await f.api.exchangeOAuthToken(refreshInput(f.client, first, { scope: "read" }));
  assert.notEqual(first.refresh_token, second.refresh_token);
  assert.equal(second.scope, "read");
  await assert.rejects(
    f.api.exchangeOAuthToken(refreshInput(f.client, second, { scope: "read write" })),
    code("invalid_scope"),
  );
  const third = await f.api.exchangeOAuthToken(refreshInput(f.client, second));
  const held = await f.api.requireMembership(await oauthLogin(f, third), "w1", "held");
  await assert.rejects(
    f.api.exchangeOAuthToken(refreshInput(f.client, first)),
    code("invalid_grant"),
  );
  await assert.rejects(f.api.authorize(held), code("forbidden"));
  await assert.rejects(oauthLogin(f, third), code("forbidden"));
  await assert.rejects(
    f.api.exchangeOAuthToken(refreshInput(f.client, third)),
    code("invalid_grant"),
  );
  const expAuth = await authorization(f, f.ownerIdentity, f.client);
  const exp = await f.api.exchangeOAuthToken(expAuth.exchange);
  f.state.now += 301;
  await assert.rejects(oauthLogin(f, exp), code("forbidden"));
  f.state.now += 604800;
  await assert.rejects(
    f.api.exchangeOAuthToken(refreshInput(f.client, exp)),
    code("invalid_grant"),
  );
});

test("OAuth RFC7009: hints advisory, unknown/foreign indistinguishable, repeated revoke safe, both token types retire family", async () => {
  const f = await oauthFixture();
  const foreign = await f.api.registerOAuthClient(oauthInput);
  for (const hint of ["access_token", "refresh_token", "unknown"]) {
    const auth = await authorization(f, f.ownerIdentity, f.client);
    const tokens = await f.api.exchangeOAuthToken(auth.exchange);
    const input = {
      client_id: f.client.client_id,
      token: hint === "refresh_token" ? tokens.refresh_token : tokens.access_token,
      token_type_hint: hint,
    };
    await f.api.revokeOAuthToken({ ...input, client_id: foreign.client_id });
    await oauthLogin(f, tokens);
    await f.api.revokeOAuthToken({ ...input, token: "unknown" });
    await f.api.revokeOAuthToken(input);
    await f.api.revokeOAuthToken(input);
    await assert.rejects(oauthLogin(f, tokens), code("forbidden"));
    await assert.rejects(
      f.api.exchangeOAuthToken(refreshInput(f.client, tokens)),
      code("invalid_grant"),
    );
  }
});

test("OAuth live admission: membership removal/reinvite, archive, client revocation/CAS and two-workspace client bindings", async () => {
  const f = await oauthFixture();
  const other = await f.owner("w2");
  const member = await f.api.inviteMember(f.ownerIdentity.scope, invite("bob"));
  const principal = await f.human("bob");
  const bob = { principal, scope: await f.api.requireMembership(principal, "w1", "bob") };
  const auth = await authorization(f, bob, f.client);
  const pending = await authorization(f, bob, f.client);
  const tokens = await f.api.exchangeOAuthToken(auth.exchange);
  const held = await f.api.requireMembership(await oauthLogin(f, tokens), "w1", "held");
  await f.api.removeMember(f.ownerIdentity.scope, {
    principalId: member.id,
    expectedVersion: 1,
    operationId: "remove-oauth",
  });
  await assert.rejects(f.api.authorize(held), code("forbidden"));
  await f.api.inviteMember(f.ownerIdentity.scope, invite("bob", "member", "restore", 2));
  await assert.rejects(oauthLogin(f, tokens), code("forbidden"));
  await assert.rejects(f.api.exchangeOAuthToken(pending.exchange), code("invalid_grant"));
  const a1 = await authorization(f, f.ownerIdentity, f.client);
  const a2 = await authorization(f, other, f.client);
  const t1 = await f.api.exchangeOAuthToken(a1.exchange);
  const t2 = await f.api.exchangeOAuthToken(a2.exchange);
  const revoke = { clientId: f.client.client_id, expectedVersion: 1, operationId: "revoke-client" };
  await assert.rejects(
    f.api.revokeOAuthClient(f.ownerIdentity.scope, {
      ...revoke,
      expectedVersion: 0,
      operationId: "stale",
    }),
    code("conflict"),
  );
  assert.equal(await f.api.readOperation(f.ownerIdentity.scope, "stale"), null);
  const result = await f.api.revokeOAuthClient(f.ownerIdentity.scope, revoke);
  assert.deepEqual(await f.api.revokeOAuthClient(f.ownerIdentity.scope, revoke), result);
  assert.equal(
    (await f.api.getOAuthClient(f.ownerIdentity.scope, f.client.client_id)).revoked,
    true,
  );
  await assert.rejects(oauthLogin(f, t1), code("forbidden"));
  await assert.rejects(f.api.exchangeOAuthToken(refreshInput(f.client, t1)), code("invalid_grant"));
  await oauthLogin(f, t2);
  await f.api.archiveWorkspace(other.scope, { expectedVersion: 1, operationId: "archive" });
  await assert.rejects(oauthLogin(f, t2), code("forbidden"));
});

test("OAuth D1 atomicity: consent receipt/history rollback, retry recovery, token partial failure and concurrent refresh/code consumption", async () => {
  const f = await oauthFixture();
  const auth = await authorization(f, f.ownerIdentity, f.client);
  const consent = await f.api.getOAuthConsent(
    f.ownerIdentity.principal,
    auth.request,
    f.ownerIdentity.scope,
  );
  const input = { operationId: "rollback-consent", codeSecret: platform.oauthRules.randomSecret() };
  f.state.hook = (calls) =>
    f.store.batch(
      calls.map((c) => (c.name === "event" ? { ...c, values: [null, ...c.values.slice(1)] } : c)),
    );
  await assert.rejects(f.api.approveOAuthConsent(f.ownerIdentity.scope, consent, input));
  assert.equal(await f.api.readOperation(f.ownerIdentity.scope, input.operationId), null);
  assert.equal((await f.db.prepare("SELECT count(*) n FROM access_oauth_codes").first()).n, 1);
  f.state.hook = async (calls) => {
    await f.store.batch(calls);
    throw new Error("lost response");
  };
  const recovered = await f.api.approveOAuthConsent(f.ownerIdentity.scope, consent, input);
  assert.equal(recovered.code, `pc1.w1.${input.codeSecret}`);
  f.state.hook = (calls) =>
    f.store.batch(
      calls.map((c) =>
        c.name === "oauthIssueToken" && c.values[3] === "refresh"
          ? { ...c, values: [...c.values.slice(0, 3), "invalid", ...c.values.slice(4)] }
          : c,
      ),
    );
  await assert.rejects(f.api.exchangeOAuthToken(auth.exchange), code("invalid_grant"));
  assert.equal((await f.db.prepare("SELECT count(*) n FROM access_oauth_families").first()).n, 0);
  assert.equal(
    (
      await f.db
        .prepare("SELECT used FROM access_oauth_codes WHERE code_hash=?")
        .bind(await platform.accessRules.hash(auth.response.code))
        .first()
    ).used,
    0,
  );
  f.state.hook = null;
  const tokens = await f.api.exchangeOAuthToken(auth.exchange);
  const race = await Promise.allSettled([
    f.api.exchangeOAuthToken(refreshInput(f.client, tokens)),
    f.api.exchangeOAuthToken(refreshInput(f.client, tokens)),
  ]);
  assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
  const winner = race.find((r) => r.status === "fulfilled").value;
  await assert.rejects(oauthLogin(f, winner), code("forbidden"));
  const codeAuth = await authorization(f, f.ownerIdentity, f.client);
  const codeRace = await Promise.allSettled([
    f.api.exchangeOAuthToken(codeAuth.exchange),
    f.api.exchangeOAuthToken(codeAuth.exchange),
  ]);
  assert.equal(codeRace.filter((r) => r.status === "fulfilled").length, 1);
  await assert.rejects(
    oauthLogin(f, codeRace.find((r) => r.status === "fulfilled").value),
    code("forbidden"),
  );
});

test("OAuth limits: public-client defaults, viewer consent ceiling, expired consent, role downgrade and absolute family expiry", async () => {
  const f = await oauthFixture();
  const minimal = await f.api.registerOAuthClient({ redirect_uris: ["https://client.test/cb"] });
  assert.equal(minimal.scope, "read write");
  const a = await authorization(f, f.ownerIdentity, minimal);
  assert.equal((await f.api.exchangeOAuthToken(a.exchange)).refresh_token, undefined);
  const member = await f.api.inviteMember(f.ownerIdentity.scope, invite("viewer", "viewer"));
  const principal = await f.human("viewer");
  const viewer = { principal, scope: await f.api.requireMembership(principal, "w1", "viewer") };
  const explicitlyRead = await authorization(f, viewer, f.client, { scope: "read" });
  assert.equal(explicitlyRead.consent.scope, "read");
  const narrowed = await authorization(f, viewer, f.client);
  assert.equal(narrowed.consent.requestedScope, "read write");
  assert.equal(narrowed.consent.scope, "read");
  const readToken = await f.api.exchangeOAuthToken(narrowed.exchange);
  assert.equal(readToken.scope, "read");
  const readPrincipal = await oauthLogin(f, readToken);
  const readScope = await f.api.requireMembership(readPrincipal, "w1", "viewer-oauth");
  await assert.rejects(f.api.authorize(readScope, "write"), code("forbidden"));
  await f.api.changeRole(f.ownerIdentity.scope, {
    principalId: member.id,
    role: "member",
    expectedVersion: 1,
    operationId: "promote",
  });
  await assert.rejects(oauthLogin(f, readToken), code("forbidden"));
  const pendingViewer = await f.api.getOAuthConsent(principal, narrowed.request, viewer.scope);
  assert.equal(pendingViewer.scope, "read write");
  await f.api.changeRole(f.ownerIdentity.scope, {
    principalId: member.id,
    role: "viewer",
    expectedVersion: 2,
    operationId: "demote",
  });
  const afterDemotion = await f.api.approveOAuthConsent(viewer.scope, pendingViewer, {
    operationId: "demoted-consent",
    codeSecret: platform.oauthRules.randomSecret(),
  });
  assert.equal(
    (await f.api.exchangeOAuthToken({ ...narrowed.exchange, code: afterDemotion.code })).scope,
    "read",
  );
  const auth = await authorization(f, f.ownerIdentity, f.client);
  const pending = await f.api.getOAuthConsent(
    f.ownerIdentity.principal,
    auth.request,
    f.ownerIdentity.scope,
  );
  let tokens = await f.api.exchangeOAuthToken(auth.exchange);
  f.state.now += 601;
  await assert.rejects(
    f.api.approveOAuthConsent(f.ownerIdentity.scope, pending, {
      operationId: "expired-consent",
      codeSecret: platform.oauthRules.randomSecret(),
    }),
    code("access_denied"),
  );
  for (let i = 0; i < 4; i++) {
    f.state.now += 6 * 86400;
    tokens = await f.api.exchangeOAuthToken(refreshInput(f.client, tokens));
  }
  f.state.now += 6 * 86400;
  await assert.rejects(
    f.api.exchangeOAuthToken(refreshInput(f.client, tokens)),
    code("invalid_grant"),
  );
});

test("OAuth refresh rollback and lost responses: no partial rotation, no secret recovery, expired-code replay still retires family", async () => {
  const f = await oauthFixture();
  const auth = await authorization(f, f.ownerIdentity, f.client);
  const first = await f.api.exchangeOAuthToken(auth.exchange);
  f.state.hook = (calls) =>
    f.store.batch(
      calls.map((c) =>
        c.name === "oauthIssueToken" && c.values[3] === "refresh"
          ? { ...c, values: [...c.values.slice(0, 3), "invalid", ...c.values.slice(4)] }
          : c,
      ),
    );
  await assert.rejects(
    f.api.exchangeOAuthToken(refreshInput(f.client, first)),
    code("invalid_grant"),
  );
  await oauthLogin(f, first);
  f.state.hook = null;
  const second = await f.api.exchangeOAuthToken(refreshInput(f.client, first));
  f.state.hook = async (calls) => {
    await f.store.batch(calls);
    throw new Error("lost token response");
  };
  await assert.rejects(f.api.exchangeOAuthToken(refreshInput(f.client, second)));
  f.state.hook = null;
  await assert.rejects(oauthLogin(f, second), code("forbidden"));
  assert.equal(
    (await f.db.prepare("SELECT revoked FROM access_oauth_families").first()).revoked,
    1,
  );
  const next = await authorization(f, f.ownerIdentity, f.client);
  const tokens = await f.api.exchangeOAuthToken(next.exchange);
  f.state.now += 121;
  await assert.rejects(f.api.exchangeOAuthToken(next.exchange), code("invalid_grant"));
  await assert.rejects(oauthLogin(f, tokens), code("forbidden"));
});

test("audit JWKS: poisoned KV cannot introduce a signing key, including after restart", async () => {
  const f = await fixture();
  await f.kv.put(
    `access:jwks:${issuer}`,
    JSON.stringify({
      expiresAt: f.state.now + 300,
      jwks: { keys: [keys[1].jwk] },
    }),
  );
  const forged = await f.sign("alice", {}, 1);
  await assert.rejects(f.api.authenticate({ kind: "human", assertion: forged }), code("forbidden"));
  await f.human();
  const restarted = platform.createAccess(f.deps).api;
  await assert.rejects(
    restarted.authenticate({ kind: "human", assertion: forged }),
    code("forbidden"),
  );
});

test("audit confinement: machine membership in a second workspace cannot expand its token", async () => {
  const f = await fixture();
  const { scope } = await f.owner();
  await f.owner("w2");
  const bot = await machine(f, scope);
  // Defense-in-depth fixture: even an imported/legacy extra membership is not authority.
  await f.store.run("addMember", ["w2", bot.id, "member", 0]);
  await assert.rejects(f.api.requireMembership(bot.principal, "w2", "cross"), code("forbidden"));
  assert.deepEqual(
    (await f.api.listWorkspaces(bot.principal)).map((w) => w.id),
    ["w1"],
  );
});

test("audit DCR: total cap is atomic across registrations and cannot reset with the hourly window", async () => {
  const f = await fixture();
  await f.db
    .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<9999)
    INSERT INTO access_oauth_clients(id,name,redirect_uris,scope,refresh_allowed,created_at)
    SELECT 'seed-'||i,'seed','["https://client.test/cb"]','read',0,0 FROM n`)
    .run();
  const race = await Promise.allSettled([
    f.api.registerOAuthClient(oauthInput),
    f.api.registerOAuthClient(oauthInput),
  ]);
  assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(race.find((r) => r.status === "rejected").reason.code, "temporarily_unavailable");
  f.state.now += 3601;
  await assert.rejects(f.api.registerOAuthClient(oauthInput), code("temporarily_unavailable"));
  assert.equal(
    (await f.db.prepare("SELECT COUNT(*) n FROM access_oauth_clients").first()).n,
    10000,
  );
});

test("audit errors: foreign and absent identities, workspaces and credentials have identical public errors", async () => {
  const f = await fixture();
  const owner = await f.owner();
  const other = await f.owner("w2", "bob");
  const bot = await machine(f, owner.scope);
  const errorOf = async (call) => {
    try {
      await call();
    } catch (e) {
      return { code: e.code, message: e.message };
    }
    assert.fail("Expected rejection");
  };
  for (const [left, right] of [
    [
      () => f.api.requireMembership(owner.principal, "w2", "foreign"),
      () => f.api.requireMembership(owner.principal, "absent", "foreign"),
    ],
    [
      () => f.api.getPrincipalSummary(owner.scope, other.scope.principalId),
      () => f.api.getPrincipalSummary(owner.scope, "absent"),
    ],
    [
      () => f.api.getMembership(owner.scope, other.scope.principalId),
      () => f.api.getMembership(owner.scope, "absent"),
    ],
    [
      () => f.api.getCredential(other.scope, "key"),
      () => f.api.getCredential(other.scope, "absent"),
    ],
    [
      () =>
        f.api.authenticate({
          kind: "machine",
          bearer: bot.bearer.replace(secret, "b2".repeat(32)),
        }),
      () =>
        f.api.authenticate({ kind: "machine", bearer: bot.bearer.replace(".key.", ".absent.") }),
    ],
  ])
    assert.deepEqual(await errorOf(left), await errorOf(right));
  const client = await f.api.registerOAuthClient(oauthInput);
  const auth = await authorization(f, owner, client);
  const tokens = await f.api.exchangeOAuthToken(auth.exchange);
  await f.api.revokeOAuthToken({ client_id: client.client_id, token: tokens.access_token });
  assert.deepEqual(
    await errorOf(() => oauthLogin(f, tokens)),
    await errorOf(() => oauthLogin(f, { access_token: `pa1.w1.${"b".repeat(64)}` })),
  );
  assert.deepEqual(
    await errorOf(() => f.api.getOAuthClient(other.scope, client.client_id)),
    await errorOf(() => f.api.getOAuthClient(other.scope, "absent")),
  );
});

async function accessSnapshot(f) {
  const snapshot = {};
  for (const table of [
    "principals",
    "workspaces",
    "memberships",
    "credentials",
    "receipts",
    "events",
    "guards",
    "bootstrap",
    "oauth_clients",
    "oauth_workspace_clients",
    "oauth_codes",
    "oauth_families",
    "oauth_tokens",
  ])
    snapshot[table] = (
      await f.db.prepare(`SELECT * FROM access_${table} ORDER BY rowid`).all()
    ).results;
  return snapshot;
}
for (const command of [
  "bootstrap",
  "createWorkspace",
  "inviteMember",
  "changeRole",
  "removeMember",
  "provisionMachine",
  "issueCredential",
  "revokeCredential",
  "archiveWorkspace",
  "revokeOAuthClient",
]) {
  test(`audit ${command}: complete rollback, CAS, fingerprint and durable lost-response recovery`, async () => {
    const f = await fixture();
    const owner = await f.owner();
    let input = { operationId: "audited" };
    let expected;
    let type;
    if (command === "bootstrap" || command === "createWorkspace") {
      input = { ...input, workspaceId: "new", name: "New workspace" };
      expected = { id: "new", version: 1 };
      type = "WorkspaceCreated";
    } else if (["inviteMember", "changeRole", "removeMember"].includes(command)) {
      if (command === "inviteMember") {
        input = invite("target", "member", "audited");
        expected = { id: await platform.accessRules.humanId(issuer, "target"), version: 1 };
      } else {
        const member =
          command === "removeMember"
            ? await machine(f, owner.scope)
            : await f.api.inviteMember(owner.scope, invite("target"));
        input = {
          ...input,
          principalId: member.id,
          expectedVersion: 1,
          ...(command === "changeRole" ? { role: "viewer" } : {}),
        };
        expected = { id: member.id, version: 2 };
      }
      type = "MembershipChanged";
    } else if (command === "provisionMachine") {
      input = { ...machineInput, ...input };
      expected = {
        id: `m_${await platform.accessRules.hash(JSON.stringify(["w1", "bot"]))}`,
        version: 1,
      };
      type = "MachineProvisioned";
    } else if (["issueCredential", "revokeCredential"].includes(command)) {
      const bot = await machine(f, owner.scope);
      input =
        command === "issueCredential"
          ? { ...bot.input, ...input, credentialId: "new-key", secret: "b2".repeat(32) }
          : { ...input, credentialId: "key", expectedVersion: 1 };
      expected = { id: input.credentialId, version: command === "issueCredential" ? 1 : 2 };
      type = command === "issueCredential" ? "CredentialIssued" : "CredentialRevoked";
    } else if (command === "revokeOAuthClient") {
      const client = await f.api.registerOAuthClient(oauthInput);
      await authorization(f, owner, client);
      input = { ...input, clientId: client.client_id, expectedVersion: 1 };
      expected = { id: client.client_id, version: 2 };
      type = "OAuthClientRevoked";
    } else {
      input = { ...input, expectedVersion: 1 };
      expected = { id: "w1", version: 2 };
      type = "WorkspaceArchived";
    }
    const invoke = (api, principal, scope, value, operator = f.operator) =>
      command === "bootstrap"
        ? api.bootstrap(operator, principal, value)
        : command === "createWorkspace"
          ? api.createWorkspace(principal, value)
          : api[command](scope, value);
    const run = (value = input) => invoke(f.api, owner.principal, owner.scope, value);
    const before = await accessSnapshot(f);
    if ("expectedVersion" in input) {
      await assert.rejects(
        run({ ...input, expectedVersion: 999, operationId: "stale" }),
        code("conflict"),
      );
      assert.deepEqual(await accessSnapshot(f), before);
    }
    f.state.hook = (calls) =>
      f.store.batch(
        calls.map((c) => (c.name === "event" ? { ...c, values: [null, ...c.values.slice(1)] } : c)),
      );
    await assert.rejects(run(), code("unknown"));
    assert.deepEqual(await accessSnapshot(f), before);
    f.state.hook = async (calls) => {
      await f.store.batch(calls);
      throw new Error("lost commit response");
    };
    assert.deepEqual(await run(), expected);
    f.state.hook = null;
    const after = await accessSnapshot(f);
    assert.equal(after.receipts.length, before.receipts.length + 1);
    assert.equal(after.events.length, before.events.length + 1);
    assert.equal(after.events.at(-1).type, type);
    assert.equal(after.events.at(-1).aggregate_id, expected.id);
    assert.equal(after.events.at(-1).aggregate_version, expected.version);
    assert.equal(after.events.at(-1).actor_id, owner.scope.principalId);
    assert.equal(after.guards.length, 0);
    if (command === "archiveWorkspace") {
      await assert.rejects(run(), code("forbidden"));
      await assert.rejects(f.api.readOperation(owner.scope, "audited"), code("forbidden"));
    } else {
      assert.deepEqual(await run(), expected);
      const changed = { ...input };
      if ("expectedVersion" in changed) changed.expectedVersion++;
      else if ("name" in changed) changed.name = "different";
      else if ("expiresAt" in changed) changed.expiresAt++;
      else changed.role = "viewer";
      await assert.rejects(run(changed), code("conflict"));
      const restarted = platform.createAccess(f.deps);
      const principal = await f.human("alice", restarted.api);
      const scope = await restarted.api.requireMembership(
        principal,
        input.workspaceId ?? "w1",
        "restart",
      );
      assert.deepEqual(await restarted.api.readOperation(scope, "audited"), expected);
      assert.deepEqual(
        await invoke(restarted.api, principal, scope, input, restarted.operator),
        expected,
      );
    }
    assert.deepEqual(await accessSnapshot(f), after);
  });
}

test("audit provenance: copied, inherited, foreign-factory scopes cannot authorize", async () => {
  const f = await fixture();
  const { scope } = await f.owner();
  for (const forged of [{ ...scope }, Object.create(scope)])
    await assert.rejects(f.api.authorize(forged), code("forbidden"));
  await assert.rejects(platform.createAccess(f.deps).api.authorize(scope), code("forbidden"));
});

test("audit management matrix: every manager entry rejects viewer, member, machine, OAuth and copied scopes", async () => {
  const f = await oauthFixture();
  const owner = f.ownerIdentity;
  const bot = await machine(f, owner.scope);
  const auth = await authorization(f, owner, f.client);
  const oauthScope = await f.api.requireMembership(
    await oauthLogin(f, await f.api.exchangeOAuthToken(auth.exchange)),
    "w1",
    "oauth",
  );
  const denied = [bot.scope, oauthScope, { ...owner.scope }];
  for (const s of denied) {
    await assert.rejects(f.api.issueOAuthForm(s, "a1".repeat(32)), code("forbidden"));
    await assert.rejects(f.api.consumeOAuthForm(s, "a1".repeat(32)), code("forbidden"));
  }
  for (const role of ["viewer", "member"]) {
    await f.api.inviteMember(owner.scope, invite(role, role));
    denied.push(await f.api.requireMembership(await f.human(role), "w1", role));
  }
  const calls = [
    (s) => f.api.inviteMember(s, invite("new")),
    (s) =>
      f.api.changeRole(s, {
        principalId: bot.id,
        role: "viewer",
        expectedVersion: 1,
        operationId: "role",
      }),
    (s) =>
      f.api.removeMember(s, { principalId: bot.id, expectedVersion: 1, operationId: "remove" }),
    (s) => f.api.provisionMachine(s, { ...machineInput, principalId: "another" }),
    (s) =>
      f.api.issueCredential(s, { ...bot.input, credentialId: "another", operationId: "another" }),
    (s) =>
      f.api.revokeCredential(s, { credentialId: "key", expectedVersion: 1, operationId: "revoke" }),
    (s) => f.api.archiveWorkspace(s, { expectedVersion: 1, operationId: "archive" }),
    (s) => f.api.getCredential(s, "key"),
    (s) => f.api.getOAuthClient(s, f.client.client_id),
    (s) =>
      f.api.revokeOAuthClient(s, {
        clientId: f.client.client_id,
        expectedVersion: 1,
        operationId: "revoke-client",
      }),
  ];
  const before = await accessSnapshot(f);
  for (const scope of denied)
    for (const call of calls) await assert.rejects(call(scope), code("forbidden"));
  assert.deepEqual(await accessSnapshot(f), before);
  const foreign = platform.createAccess(f.deps);
  await assert.rejects(f.api.readEvents(foreign.eventReader, "w1", 0, 10), code("forbidden"));
});

test("OAuth forms: Access-only D1 nonce consumption is tenant/subject bound, durable, expiring and capped", async () => {
  const f = await fixture();
  const { scope } = await f.owner();
  const other = await f.owner("w2");
  await f.api.inviteMember(scope, invite("bob"));
  const bob = await f.api.requireMembership(await f.human("bob"), "w1", "bob");
  const hash = "a1".repeat(32);
  await f.api.issueOAuthForm(scope, hash);
  await assert.rejects(f.api.consumeOAuthForm(other.scope, hash), code("invalid_request"));
  await assert.rejects(f.api.consumeOAuthForm(bob, hash), code("invalid_request"));
  const restarted = platform.createAccess(f.deps).api;
  const fresh = await restarted.requireMembership(
    await f.human("alice", restarted),
    "w1",
    "restart",
  );
  const consumed = await Promise.allSettled([
    f.api.consumeOAuthForm(scope, hash),
    restarted.consumeOAuthForm(fresh, hash),
  ]);
  assert.equal(consumed.filter((x) => x.status === "fulfilled").length, 1);
  await assert.rejects(restarted.consumeOAuthForm(fresh, hash), code("invalid_request"));
  for (let n = 0; n < 16; n++) await f.api.issueOAuthForm(scope, n.toString(16).padStart(64, "0"));
  await assert.rejects(f.api.issueOAuthForm(scope, hash), code("temporarily_unavailable"));
  f.state.now += 601;
  await assert.rejects(f.api.consumeOAuthForm(scope, "0".repeat(64)), code("invalid_request"));
  await f.api.issueOAuthForm(scope, hash);
  await f.api.consumeOAuthForm(scope, hash);
  await assert.rejects(f.api.issueOAuthForm({ ...scope }, hash), code("forbidden"));
  assert.deepEqual(
    (await f.store.run("oauthConsumeForm", ["w2", hash, scope.principalId, f.state.now])).rows,
    [],
  );
});

test("07c discovery and member/client keysets cannot expand credential authority", async () => {
  const f = await oauthFixture();
  const owner = f.ownerIdentity;
  await f.owner("w2");
  await f.owner("w3");
  const stranger = await f.human("unjoined");
  const before = await f.db.prepare("SELECT COUNT(*) AS n FROM access_memberships").first();
  assert.deepEqual((await f.api.me(stranger)).workspaces, []);
  assert.deepEqual(
    await f.db.prepare("SELECT COUNT(*) AS n FROM access_memberships").first(),
    before,
  );
  const bot = await machine(f, owner.scope);
  await f.store.run("addMember", ["w2", bot.id, "member", 0]);
  const tokens = await f.api.exchangeOAuthToken((await authorization(f, owner, f.client)).exchange);
  const oauth = await oauthLogin(f, tokens);
  const oauthScope = await f.api.requireMembership(oauth, "w1", "audit", "write");
  for (const actor of [bot.principal, oauth]) {
    assert.deepEqual(
      (await f.api.me(actor)).workspaces.map((w) => w.id),
      ["w1"],
    );
    assert.deepEqual((await f.api.me(actor, "w1", 1)).workspaces, []);
  }
  await f.api.inviteMember(owner.scope, invite("charlie"));
  const foreign = await f.owner("w4", "foreign-only");
  const second = await f.api.registerOAuthClient({ ...oauthInput, client_name: "Second" });
  const secondTokens = await f.api.exchangeOAuthToken(
    (await authorization(f, owner, second)).exchange,
  );
  await authorization(f, foreign, second);
  const cases = [
    [
      async (c) => {
        const p = await f.api.me(owner.principal, c, 1);
        return { items: p.workspaces, nextCursor: p.nextCursor };
      },
      ["w1", "w2", "w3"],
      (x) => x.id,
    ],
    [(c) => f.api.listMembers(owner.scope, c, 1), [], (x) => x.principalId],
    [
      (c) => f.api.listOAuthClients(owner.scope, c, 1),
      [f.client.client_id, second.client_id].sort(),
      (x) => x.clientId,
    ],
  ];
  // Expected membership identities come from explicit provider commands, not the query under test.
  const charlie = await f.api.requireMembership(await f.human("charlie"), "w1", "audit");
  cases[1][1] = [owner.scope.principalId, bot.id, charlie.principalId].sort();
  for (const [read, expected, key] of cases) {
    let cursor;
    const seen = [];
    for (let i = 0; i < expected.length; i++) {
      const page = await read(cursor);
      assert.equal(page.items.length, 1);
      seen.push(key(page.items[0]));
      assert.equal(page.nextCursor === null, i === expected.length - 1);
      cursor = page.nextCursor;
    }
    assert.deepEqual(seen, expected);
  }
  assert.deepEqual(
    (await f.api.listMembers(foreign.scope)).items.map((x) => x.principalId),
    [foreign.scope.principalId],
  );
  for (const scope of [oauthScope, bot.scope]) {
    await assert.rejects(f.api.listOAuthClients(scope), code("forbidden"));
    await assert.rejects(
      f.api.revokeOAuthClient(scope, {
        operationId: "denied",
        clientId: f.client.client_id,
        expectedVersion: 1,
      }),
      code("forbidden"),
    );
  }
  const command = { operationId: "revoke-07c", clientId: f.client.client_id, expectedVersion: 1 };
  const result = await f.api.revokeOAuthClient(owner.scope, command);
  assert.deepEqual(await f.api.revokeOAuthClient(owner.scope, command), result);
  await assert.rejects(
    f.api.revokeOAuthClient(owner.scope, { ...command, operationId: "stale-07c" }),
    code("conflict"),
  );
  await assert.rejects(oauthLogin(f, tokens), code("forbidden"));
  await assert.rejects(
    f.api.exchangeOAuthToken(refreshInput(f.client, tokens)),
    code("invalid_grant"),
  );
  await assert.doesNotReject(() => oauthLogin(f, secondTokens));
  await assert.doesNotReject(async () =>
    oauthLogin(f, await f.api.exchangeOAuthToken(refreshInput(second, secondTokens))),
  );
  assert.equal((await f.api.getOAuthClient(foreign.scope, second.client_id)).revoked, false);
});

test("07c OAuth discovery remains confined when its human owns two workspaces", async () => {
  const f = await oauthFixture();
  await f.owner("w2");
  const tokens = await f.api.exchangeOAuthToken(
    (await authorization(f, f.ownerIdentity, f.client)).exchange,
  );
  const principal = await oauthLogin(f, tokens);
  assert.deepEqual(
    (await f.api.me(principal)).workspaces.map((w) => w.id),
    ["w1"],
  );
  const scope = await f.api.requireMembership(principal, "w1", "me");
  assert.deepEqual(
    (await f.api.meForScope(scope)).workspaces.map((w) => w.id),
    ["w1"],
  );
});

for (const tokenKind of ["access", "refresh"]) {
  test(`07c revoke invalidates ${tokenKind} token independently`, async () => {
    const f = await oauthFixture();
    const tokens = await f.api.exchangeOAuthToken(
      (await authorization(f, f.ownerIdentity, f.client)).exchange,
    );
    await f.api.revokeOAuthClient(f.ownerIdentity.scope, {
      operationId: "revoke",
      clientId: f.client.client_id,
      expectedVersion: 1,
    });
    if (tokenKind === "access") await assert.rejects(oauthLogin(f, tokens), code("forbidden"));
    else
      await assert.rejects(
        f.api.exchangeOAuthToken(refreshInput(f.client, tokens)),
        code("invalid_grant"),
      );
  });
}

test("07c client revoke rejects viewer before effects", async () => {
  const f = await oauthFixture();
  await authorization(f, f.ownerIdentity, f.client);
  await f.api.inviteMember(f.ownerIdentity.scope, invite("viewer", "viewer"));
  const scope = await f.api.requireMembership(await f.human("viewer"), "w1", "viewer");
  await assert.rejects(
    f.api.revokeOAuthClient(scope, {
      operationId: "viewer-revoke",
      clientId: f.client.client_id,
      expectedVersion: 1,
    }),
    code("forbidden"),
  );
  assert.equal(
    (await f.api.getOAuthClient(f.ownerIdentity.scope, f.client.client_id)).revoked,
    false,
  );
});

test("07c client revoke rejects OAuth-derived owner before effects", async () => {
  const f = await oauthFixture();
  const tokens = await f.api.exchangeOAuthToken(
    (await authorization(f, f.ownerIdentity, f.client)).exchange,
  );
  const scope = await f.api.requireMembership(await oauthLogin(f, tokens), "w1", "oauth", "write");
  await assert.rejects(
    f.api.revokeOAuthClient(scope, {
      operationId: "oauth-revoke",
      clientId: f.client.client_id,
      expectedVersion: 1,
    }),
    code("forbidden"),
  );
  assert.equal(
    (await f.api.getOAuthClient(f.ownerIdentity.scope, f.client.client_id)).revoked,
    false,
  );
});

test("11a background discovery pages active workspaces without membership or first read", async () => {
  const f = await fixture();
  for (const w of ["w3", "w1", "w2"]) await f.owner(w);
  const human = await f.human();
  await f.api.archiveWorkspace(await f.api.requireMembership(human, "w2", "archive"), {
    operationId: "archive",
    expectedVersion: 1,
  });
  assert.equal("listActiveWorkspaceIds" in f.api, false);
  const first = await f.background.listActiveWorkspaceIds(undefined, 1);
  assert.deepEqual(first, { workspaceIds: ["w1"], nextCursor: "w1" });
  assert.deepEqual(await f.background.listActiveWorkspaceIds(first.nextCursor, 1), {
    workspaceIds: ["w3"],
    nextCursor: null,
  });
  for (const limit of [0, 101, 1.5])
    await assert.rejects(f.background.listActiveWorkspaceIds(undefined, limit), code("validation"));
});

test("verified email refreshes the profile cache and member display names", async () => {
  const f = await fixture();
  const { principal, scope } = await f.owner("w1", "profile");
  const first = await f.api.me(principal);
  assert.equal(first.principal.email, "profile@example.test");
  assert.equal(first.principal.displayName, "profile");
  let member = (await f.api.listMembers(scope)).items[0];
  assert.equal(member.email, "profile@example.test");
  assert.equal(member.displayName, "profile");
  const changed = await f.api.authenticate({
    kind: "human",
    assertion: await f.sign("profile", { email: "renamed@example.test" }),
  });
  await f.api.me(changed);
  member = (await f.api.listMembers(scope)).items[0];
  assert.equal(member.email, "renamed@example.test");
  assert.equal(member.displayName, "renamed");
  const w2 = await f.owner("w2", "second");
  await f.api.me(w2.principal);
  assert.equal((await f.api.listMembers(w2.scope)).items[0].email, "second@example.test");
  assert.equal((await f.api.listMembers(scope)).items.length, 1);
});

test("profile migration leaves existing global principals nullable", async () => {
  const db = await mf.getD1Database(`DB${index++}`);
  const apply = async (file) => {
    const sql = fs.readFileSync(`modules/access/storage/migrations/${file}`, "utf8");
    for (const statement of sql.split(/;\s*\n/))
      if (statement.trim()) await db.prepare(statement).run();
  };
  for (const file of [
    "0001_access.sql",
    "0002_oauth.sql",
    "0003_oauth_forms.sql",
    "0004_maintenance.sql",
  ])
    await apply(file);
  await db
    .prepare(
      "INSERT INTO access_principals(id,kind,issuer,subject) VALUES('old','human','issuer','subject')",
    )
    .run();
  await apply("0005_profile.sql");
  assert.deepEqual(
    await db.prepare("SELECT email,display_name FROM access_principals WHERE id='old'").first(),
    { email: null, display_name: null },
  );
});
