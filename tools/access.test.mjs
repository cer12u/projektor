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
    d1Databases: Array.from({ length: 20 }, (_, i) => `DB${i}`),
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
