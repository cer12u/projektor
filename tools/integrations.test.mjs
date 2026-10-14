import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

let p,
  mf,
  serial = 0;
const denied = (code) => (error) => error?.code === code;
before(async () => {
  fs.mkdirSync(".tmp", { recursive: true });
  const result = await build({
    entryPoints: ["tools/integrations-test-entry.ts"],
    outfile: ".tmp/test-entry.mjs",
    bundle: true,
    format: "esm",
    platform: "node",
    metafile: true,
  });
  assert(
    Object.keys(result.metafile.inputs).every(
      (x) => !/modules\/(issues|wiki|projects|access)\/internal\//.test(x),
    ),
  );
  p = await import("../.tmp/test-entry.mjs");
  mf = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('ok')}}",
    compatibilityDate: "2026-07-30",
    d1Databases: Array.from({ length: 50 }, (_, i) => `INT${i}`),
  });
});
after(async () => mf?.dispose());
async function fixture() {
  const db = await mf.getD1Database(`INT${serial++}`);
  await p.migrate(db, ["integrations"]);
  const fake = p.fakeAccess();
  const scope = (ws = "w1", role = "member", kind = "machine") =>
    fake.issue({ id: role, workspaceId: ws, kind, role, scope: "write", active: true });
  let now = 1000000,
    seq = 0,
    issueCalls = [],
    failAfterIssue = false,
    sendStatus = 200,
    allowed = true,
    failAudit = false;
  const sends = [];
  const raw = p.createModuleStore(db, "integrations");
  const store = {
    ...raw,
    async batch(calls) {
      if (failAfterIssue && calls.some((x) => x.name === "convert")) {
        (failAfterIssue = false), (sendStatus = 200);
        throw Error("crash before integration commit");
      }
      if (failAudit) {
        failAudit = false;
        return raw.batch(
          calls.map((call) =>
            call.name === "event" ? { ...call, values: [null, ...call.values.slice(1)] } : call,
          ),
        );
      }
      return raw.batch(calls);
    },
  };
  const projects = {
    async authorizeProject(s, projectId, mode = "read") {
      await fake.access.authorize(s, mode === "read" ? "read" : "write");
      if (projectId !== "p1") throw new p.PlatformError("not_found", "project");
      return { id: projectId };
    },
  };
  const issued = new Map();
  const dependencies = {
    store,
    access: fake.access,
    projects,
    issues: {
      async authorizeIssue(s, issueId, mode = "read") {
        await fake.access.authorize(s, mode);
        if (issueId !== "i1") throw new p.PlatformError("not_found", "issue");
        return { id: issueId, projectId: "p1" };
      },
      async createIssue(s, input) {
        await projects.authorizeProject(s, input.projectId, "write");
        issueCalls.push(input);
        const key = `${s.workspaceId}:${s.principalId}:${input.operationId}`;
        const fingerprint = JSON.stringify(input);
        const prior = issued.get(key);
        if (prior && prior.fingerprint !== fingerprint)
          throw new p.PlatformError("conflict", "Operation ID reused");
        const result = prior?.result ?? { id: input.issueId, number: issued.size + 1, version: 1 };
        issued.set(key, { fingerprint, result });
        return result;
      },
    },
    wiki: {
      async authorizePage(s, pageId, mode = "read") {
        await fake.access.authorize(s, mode);
        if (pageId !== "page1") throw new p.PlatformError("not_found", "page");
        return { id: pageId, projectId: "p1" };
      },
    },
    clock: { now: () => now },
    ids: { next: () => `x${++seq}` },
    vault: p.createSecretVault("ab".repeat(32)),
    limiter: {
      async allow() {
        return allowed;
      },
    },
    send: async (url, init) => {
      sends.push({ url, init });
      return new Response("", { status: sendStatus });
    },
  };
  const module = p.createIntegrations(dependencies);
  return {
    db,
    raw,
    providers: dependencies,
    issued,
    projects,
    fake,
    ...module,
    scope,
    sends,
    issueCalls,
    setAllowed: (x) => (allowed = x),
    failAudit: () => (failAudit = true),
    setNow: (x) => (now = x),
    setSendStatus: (x) => (sendStatus = x),
    failConvert: () => {
      failAfterIssue = true;
    },
  };
}
async function sign(secret, timestamp, deliveryId, body) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return Buffer.from(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${timestamp}.${deliveryId}.${body}`),
    ),
  ).toString("hex");
}
test("external refs are authorized, tenant isolated and CAS guarded", async () => {
  const f = await fixture(),
    s = f.scope(),
    other = f.scope("w2");
  const input = {
    operationId: "op1",
    refId: "r1",
    target: { kind: "issue", id: "i1" },
    kind: "github_issue",
    url: "https://github.com/o/r/issues/1",
  };
  assert.equal((await f.api.linkExternalRef(s, input)).version, 1);
  assert.equal((await f.api.linkExternalRef(s, input)).id, "r1");
  assert.equal((await f.api.listExternalRefs(other, input.target)).items.length, 0);
  await assert.rejects(
    f.api.unlinkExternalRef(s, { operationId: "op2", refId: "r1", expectedVersion: 0 }),
    denied("conflict"),
  );
  assert.equal(
    (await f.api.unlinkExternalRef(s, { operationId: "op2", refId: "r1", expectedVersion: 1 }))
      .version,
    2,
  );
  assert.equal((await f.api.listExternalRefs(s, input.target)).items.length, 0);
});
test("feedback verifies HMAC, bounds time and deduplicates delivery", async () => {
  const f = await fixture(),
    admin = f.scope("w1", "owner", "human");
  const created = await f.api.registerSource(admin, {
    operationId: "sop",
    sourceId: "s1",
    projectId: "p1",
    name: "Form",
  });
  assert.match(created.secret, /^[a-f0-9]{64}$/);
  assert.equal(
    (
      await f.api.registerSource(admin, {
        operationId: "sop",
        sourceId: "s1",
        projectId: "p1",
        name: "Form",
      })
    ).secret,
    null,
  );
  const body = JSON.stringify({ title: "Bug", body: "Details" }),
    timestamp = 1000000;
  const input = {
    workspaceId: "w1",
    sourceId: "s1",
    timestamp,
    deliveryId: "d1",
    rawBody: body,
    signature: await sign(created.secret, timestamp, "d1", body),
  };
  await assert.rejects(
    f.api.receiveFeedback({ ...input, signature: "0".repeat(64) }),
    denied("forbidden"),
  );
  await assert.rejects(
    f.api.receiveFeedback({ ...input, timestamp: timestamp - 301 }),
    denied("forbidden"),
  );
  await assert.rejects(
    f.api.receiveFeedback({ ...input, deliveryId: "replayed" }),
    denied("forbidden"),
  );
  const first = await f.api.receiveFeedback(input);
  assert.deepEqual(await f.api.receiveFeedback(input), first);
  assert.equal((await f.api.listFeedback(f.scope())).items.length, 1);
  assert.equal((await f.api.listFeedback(f.scope("w2"))).items.length, 0);
});
test("convert retries one deterministic Issues operation after partial failure", async () => {
  const f = await fixture(),
    admin = f.scope("w1", "owner", "human"),
    member = f.scope();
  const src = await f.api.registerSource(admin, {
    operationId: "sop",
    sourceId: "s1",
    projectId: "p1",
    name: "Form",
  });
  const body = JSON.stringify({ title: "Bug", body: "Details" });
  const id = (
    await f.api.receiveFeedback({
      workspaceId: "w1",
      sourceId: "s1",
      timestamp: 1000000,
      deliveryId: "d1",
      rawBody: body,
      signature: await sign(src.secret, 1000000, "d1", body),
    })
  ).id;
  f.failConvert();
  await assert.rejects(
    f.api.convertFeedback(member, { operationId: "cop", feedbackId: id, expectedVersion: 1 }),
  );
  const done = await f.api.convertFeedback(member, {
    operationId: "cop",
    feedbackId: id,
    expectedVersion: 1,
  });
  assert.equal(done.issueId, `int_${id}`);
  assert.equal(f.issued.size, 1);
  assert.deepEqual(
    f.issueCalls.map((x) => x.operationId),
    [`int_convert_${id}`, `int_convert_${id}`],
  );
  assert.equal((await f.api.listFeedback(member)).items[0].issueId, done.issueId);
  await assert.rejects(
    f.api.convertFeedback(member, { operationId: "stale", feedbackId: id, expectedVersion: 1 }),
    denied("conflict"),
  );
});
test("webhook rejects detected SSRF, encrypts secret and retries signed delivery", async () => {
  const f = await fixture(),
    admin = f.scope("w1", "owner", "human");
  await f.api.registerSource(admin, {
    operationId: "sop",
    sourceId: "s1",
    projectId: "p1",
    name: "Form",
  });
  await assert.rejects(
    f.api.registerWebhook(admin, {
      operationId: "bad",
      sourceId: "s1",
      url: "https://127.0.0.1/hook",
      eventTypes: ["issue"],
    }),
    denied("validation"),
  );
  const config = await f.api.registerWebhook(admin, {
    operationId: "wop",
    sourceId: "s1",
    url: "https://example.com/hook",
    eventTypes: ["issue"],
  });
  assert.equal(
    (
      await f.api.registerWebhook(admin, {
        operationId: "wop",
        sourceId: "s1",
        url: "https://example.com/hook",
        eventTypes: ["issue"],
      })
    ).secret,
    null,
  );
  const source = await f.raw.run("source", ["w1", "s1"]);
  assert(!JSON.stringify(source).includes(config.secret));
  const events = await f.db.prepare("SELECT * FROM integrations_events").all();
  assert(!JSON.stringify(events).includes(config.secret));
  const first = await f.api.deliverWebhook(admin, {
    operationId: "d1",
    sourceId: "s1",
    eventType: "issue",
    externalId: "external",
    body: "{}",
  });
  assert.equal(
    (
      await f.api.deliverWebhook(admin, {
        operationId: "d2",
        sourceId: "s1",
        eventType: "issue",
        externalId: "external",
        body: "{}",
      })
    ).id,
    first.id,
  );
  assert.equal(
    (
      await f.api.deliverWebhook(admin, {
        operationId: "d2",
        sourceId: "s1",
        eventType: "issue",
        externalId: "external",
        body: "{}",
      })
    ).id,
    first.id,
  );
  await assert.rejects(
    f.api.deliverWebhook(admin, {
      operationId: "d3",
      sourceId: "s1",
      eventType: "issue",
      externalId: "external",
      body: "changed",
    }),
    denied("conflict"),
  );
  assert.equal(await f.background.drain(), 1);
  assert.equal(f.sends.length, 1);
  assert.equal((await f.api.getDeliveryStatus(admin)).items[0].status, "delivered");
  assert(!JSON.stringify(await f.api.listSources(admin)).includes(config.secret));
});

test("outbound retries use exponential backoff and stop after five attempts", async () => {
  const f = await fixture(),
    admin = f.scope("w1", "owner", "human");
  await f.api.registerSource(admin, {
    operationId: "sop",
    sourceId: "s1",
    projectId: "p1",
    name: "Form",
  });
  await f.api.registerWebhook(admin, {
    operationId: "wop",
    sourceId: "s1",
    url: "https://example.com/hook",
    eventTypes: ["issue"],
  });
  const queued = await f.api.deliverWebhook(admin, {
    operationId: "d1",
    sourceId: "s1",
    eventType: "issue",
    externalId: "event-1",
    body: "{}",
  });
  f.setSendStatus(500);
  let at = 1000000;
  for (const [index, delay] of [30, 60, 120, 240, 480].entries()) {
    f.setNow(at);
    assert.equal(await f.background.drain(), 0);
    const current = (await f.api.getDeliveryStatus(admin)).items.find((x) => x.id === queued.id);
    assert.equal(current.attempts, index + 1);
    assert.equal(current.status, index === 4 ? "failed" : "pending");
    assert.equal(current.nextAttemptAt, at + delay);
    f.setNow(at + delay - 1);
    assert.equal(await f.background.drain(), 0);
    assert.equal(f.sends.length, index + 1, "must not send before nextAttemptAt");
    at += delay;
  }
  assert.equal(await f.background.drain(), 0);
  assert.equal(f.sends.length, 5);
  assert(f.sends.every((x) => x.init.headers["x-projektor-signature"].length === 64));
});

async function source(f, sourceId = "s1", workspaceId = "w1") {
  return f.api.registerSource(f.scope(workspaceId, "owner", "human"), {
    operationId: `register-${sourceId}`,
    sourceId,
    projectId: "p1",
    name: "Form",
  });
}
async function feedbackInput(secret, overrides = {}) {
  const input = {
    workspaceId: "w1",
    sourceId: "s1",
    timestamp: 1000000,
    deliveryId: "d1",
    rawBody: '{ "title": "Bug", "body": "日本語" }',
    ...overrides,
  };
  return {
    ...input,
    signature: await sign(secret, input.timestamp, input.deliveryId, input.rawBody),
  };
}
async function webhook(f) {
  const inbound = await source(f);
  const admin = f.scope("w1", "owner", "human");
  const input = {
    operationId: "hook",
    sourceId: "s1",
    url: "https://example.com/hook",
    eventTypes: ["issue"],
  };
  const outbound = await f.api.registerWebhook(admin, input);
  return { admin, inbound, outbound, input };
}
const deliveryInput = {
  operationId: "send",
  sourceId: "s1",
  eventType: "issue",
  externalId: "event",
  body: "{}",
};
async function snapshot(f) {
  const result = {};
  for (const table of [
    "links",
    "sources",
    "feedback",
    "deliveries",
    "receipts",
    "guards",
    "history",
    "events",
  ])
    result[table] = (await f.db.prepare(`SELECT * FROM integrations_${table}`).all()).results;
  return result;
}

test("12a signatures bind raw bytes, time boundaries and source-local replay identity", async () => {
  const f = await fixture(),
    a = await source(f),
    b = await source(f, "s2"),
    c = await source(f, "s1", "w2");
  const input = await feedbackInput(a.secret);
  await assert.doesNotReject(() => f.api.receiveFeedback(input));
  await assert.rejects(
    f.api.receiveFeedback({ ...input, rawBody: JSON.stringify(JSON.parse(input.rawBody)) }),
    denied("forbidden"),
  );
  for (const offset of [-301, 301])
    await assert.rejects(
      f.api.receiveFeedback(await feedbackInput(a.secret, { timestamp: 1000000 + offset })),
      denied("forbidden"),
    );
  for (const offset of [-300, 300])
    await f.api.receiveFeedback(
      await feedbackInput(a.secret, {
        timestamp: 1000000 + offset,
        deliveryId: `boundary${offset}`,
      }),
    );
  const first = await f.api.receiveFeedback(input);
  assert.deepEqual(await f.api.receiveFeedback(input), first);
  await assert.rejects(
    f.api.receiveFeedback({ ...input, deliveryId: "stolen" }),
    denied("forbidden"),
  );
  const second = await f.api.receiveFeedback(await feedbackInput(b.secret, { sourceId: "s2" }));
  const third = await f.api.receiveFeedback(await feedbackInput(c.secret, { workspaceId: "w2" }));
  assert.equal(new Set([first.id, second.id, third.id]).size, 3);
  assert.equal((await f.api.listFeedback(f.scope())).items.length, 4);
  assert.equal((await f.api.listFeedback(f.scope("w2"))).items.length, 1);
});

test("12a conversion denies viewer and foreign tenant before Issues and preserves retry receipt", async () => {
  const f = await fixture(),
    src = await source(f);
  const { id } = await f.api.receiveFeedback(await feedbackInput(src.secret));
  const input = { operationId: "convert", feedbackId: id, expectedVersion: 1 };
  for (const [scope, code] of [
    [f.scope("w1", "viewer"), "forbidden"],
    [f.scope("w2"), "not_found"],
  ])
    await assert.rejects(f.api.convertFeedback(scope, input), denied(code));
  assert.equal(f.issueCalls.length, 0);
  const done = await f.api.convertFeedback(f.scope(), input);
  assert.deepEqual(await f.api.convertFeedback(f.scope(), input), done);
  assert.equal(f.issueCalls.length, 1);
  await assert.rejects(
    f.api.convertFeedback(f.scope(), { ...input, expectedVersion: 2 }),
    denied("conflict"),
  );
  assert.equal((await f.api.listFeedback(f.scope("w2"))).items.length, 0);
});

test("12a source and webhook secrets appear only in creation responses", async (t) => {
  const logs = [];
  for (const method of ["log", "warn", "error"])
    t.mock.method(console, method, (...args) => logs.push(args));
  const f = await fixture(),
    { admin, inbound, outbound, input } = await webhook(f);
  const repeatedSource = await source(f);
  const repeatedHook = await f.api.registerWebhook(admin, input);
  assert.equal(repeatedSource.secret, null);
  assert.equal(repeatedHook.secret, null);
  await f.api.receiveFeedback(await feedbackInput(inbound.secret));
  await f.api.deliverWebhook(admin, deliveryInput);
  f.setSendStatus(500);
  await f.background.drain();
  const visible = JSON.stringify([
    logs,
    await snapshot(f),
    await f.api.listSources(admin),
    await f.api.getDeliveryStatus(admin),
    await f.api.listFeedback(admin),
    repeatedSource,
    repeatedHook,
  ]);
  for (const secret of [inbound.secret, outbound.secret, "ab".repeat(32)])
    assert(!visible.includes(secret));
  await assert.rejects(
    f.api.receiveFeedback({ ...(await feedbackInput(inbound.secret)), signature: outbound.secret }),
    (error) => {
      assert(!String(error).includes(inbound.secret));
      assert(!String(error).includes(outbound.secret));
      return error.code === "forbidden";
    },
  );
});

test("12a vault separates HMAC and AES keys with HKDF and authenticates ciphertext", async () => {
  const { hkdfSync, createHmac } = await import("node:crypto");
  const master = Buffer.from("ab".repeat(32), "hex"),
    salt = "projektor:integrations:v1";
  const hmacKey = hkdfSync("sha256", master, salt, "inbound-hmac", 32);
  const aesBytes = hkdfSync("sha256", master, salt, "outbound-aes-gcm", 32);
  const vault = p.createSecretVault(master.toString("hex"));
  assert.equal(
    await vault.inboundSecret("w1:s1"),
    createHmac("sha256", Buffer.from(hmacKey)).update("inbound:w1:s1").digest("hex"),
  );
  assert.notEqual(await vault.inboundSecret("w1:s1"), await vault.inboundSecret("w2:s1"));
  const cipher = await vault.seal("sensitive-outbound-secret");
  assert.notEqual(cipher, await vault.seal("sensitive-outbound-secret"));
  assert.equal(await vault.open(cipher), "sensitive-outbound-secret");
  const [iv, body] = cipher.split(".").map((v) => Buffer.from(v, "base64"));
  const aes = await crypto.subtle.importKey("raw", aesBytes, "AES-GCM", false, ["decrypt"]);
  await assert.doesNotReject(async () => {
    assert.equal(
      new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, aes, body)),
      "sensitive-outbound-secret",
    );
  }, "ciphertext must use the independent outbound AES key");
  for (const bytes of [master, hmacKey]) {
    const wrong = await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["decrypt"]);
    await assert.rejects(crypto.subtle.decrypt({ name: "AES-GCM", iv }, wrong, body));
  }
  body[0] ^= 1;
  await assert.rejects(vault.open(`${iv.toString("base64")}.${body.toString("base64")}`));
});

test("12a SSRF and external-reference URL policy rejects unsafe destinations", async () => {
  const f = await fixture();
  await source(f);
  const admin = f.scope("w1", "owner", "human");
  for (const url of [
    "https://127.0.0.1/",
    "https://8.8.8.8/",
    "https://2130706433/",
    "https://[::1]/",
    "https://[2001:4860:4860::8888]/",
    "https://localhost/",
    "https://LOCALHOST./",
    "https://api.internal/",
    "https://x.localhost/",
    "http://example.com/",
    "javascript:alert(1)",
  ])
    await assert.rejects(
      f.api.registerWebhook(admin, {
        operationId: "bad",
        sourceId: "s1",
        url,
        eventTypes: ["issue"],
      }),
      denied("validation"),
    );
  for (const url of [
    "http://example.com/",
    "javascript:alert(1)",
    "ftp://example.com/a",
    "https://user:pass@example.com/",
  ])
    await assert.rejects(
      f.api.linkExternalRef(f.scope(), {
        operationId: "bad",
        refId: "r",
        target: { kind: "issue", id: "i1" },
        kind: "github_issue",
        url,
      }),
      denied("validation"),
    );
});

test("12a outbound rejects unsubscribed events, refuses redirects and never resends delivered items", async () => {
  const f = await fixture(),
    { admin, outbound } = await webhook(f);
  await assert.rejects(
    f.api.deliverWebhook(admin, { ...deliveryInput, eventType: "wiki" }),
    denied("validation"),
  );
  assert.equal((await f.api.getDeliveryStatus(admin)).items.length, 0);
  await f.api.deliverWebhook(admin, deliveryInput);
  for (const [index, status] of [301, 302, 307, 308].entries()) {
    f.setSendStatus(status);
    f.setNow(1000000 + [0, 30, 90, 210][index]);
    assert.equal(await f.background.drain(), 0);
    assert.equal(f.sends[index].init.redirect, "manual");
    assert.equal((await f.api.getDeliveryStatus(admin)).items[0].status, "pending");
  }
  f.setSendStatus(200);
  f.setNow(1000450);
  assert.equal(await f.background.drain(), 1);
  const send = f.sends.at(-1);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(outbound.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  assert.equal(
    send.init.headers["x-projektor-signature"],
    Buffer.from(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`1000450.${send.init.body}`)),
    ).toString("hex"),
  );
  f.setNow(2000000);
  assert.equal(await f.background.drain(), 0);
  assert.equal(f.sends.length, 5);
});

test("12a feedback rate limiter is mandatory before writes", async () => {
  const f = await fixture(),
    src = await source(f);
  f.setAllowed(false);
  await assert.rejects(f.api.receiveFeedback(await feedbackInput(src.secret)), denied("forbidden"));
  assert.equal((await f.api.listFeedback(f.scope())).items.length, 0);
});

test("12a all audited commands roll back business state, receipts and audit on final event failure", async () => {
  const f = await fixture(),
    admin = f.scope("w1", "owner", "human"),
    member = f.scope();
  const ref = {
    operationId: "ref",
    refId: "r1",
    target: { kind: "issue", id: "i1" },
    kind: "github_issue",
    url: "https://example.com/",
  };
  for (const command of [() => source(f), () => f.api.linkExternalRef(member, ref)]) {
    const before = await snapshot(f);
    f.failAudit();
    await assert.rejects(command());
    assert.deepEqual(await snapshot(f), before);
    await command();
  }
  const src = await f.raw.run("source", ["w1", "s1"]);
  assert.equal(src.rows.length, 1);
  const secret = await p.createSecretVault("ab".repeat(32)).inboundSecret("w1:s1");
  const feedback = await f.api.receiveFeedback(await feedbackInput(secret));
  for (const command of [
    () =>
      f.api.registerWebhook(admin, {
        operationId: "hook",
        sourceId: "s1",
        url: "https://example.com/hook",
        eventTypes: ["issue"],
      }),
    () =>
      f.api.unlinkExternalRef(member, { operationId: "unlink", refId: "r1", expectedVersion: 1 }),
    () =>
      f.api.convertFeedback(member, {
        operationId: "convert",
        feedbackId: feedback.id,
        expectedVersion: 1,
      }),
  ]) {
    const before = await snapshot(f);
    f.failAudit();
    await assert.rejects(command());
    assert.deepEqual(await snapshot(f), before);
    await command();
  }
});

test("12a Projects fake obeys the shared public authorization contract", async () => {
  const f = await fixture();
  const { projectAuthorizationContract } = await import("./projects-consumer-contract.mjs");
  await projectAuthorizationContract({
    api: f.projects,
    editor: f.scope(),
    viewer: f.scope("w1", "viewer"),
    projectId: "p1",
  });
});

test("12a dependency fakes satisfy the same authorization and Issues retry contract as real providers", async () => {
  const f = await fixture();
  const { integrationsProviderContract } = await import("./integrations-provider-contract.mjs");
  await integrationsProviderContract({
    ...f.providers,
    editor: f.scope(),
    viewer: f.scope("w1", "viewer"),
    projectId: "p1",
    issueId: "i1",
    pageId: "page1",
  });
});
