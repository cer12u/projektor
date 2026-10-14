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
    d1Databases: Array.from({ length: 20 }, (_, i) => `INT${i}`),
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
    sendStatus = 200;
  const sends = [];
  const raw = p.createModuleStore(db, "integrations");
  const store = {
    ...raw,
    async batch(calls) {
      if (failAfterIssue && calls.some((x) => x.name === "convert")) {
        (failAfterIssue = false), (sendStatus = 200);
        throw Error("crash before integration commit");
      }
      return raw.batch(calls);
    },
  };
  const module = p.createIntegrations({
    store,
    access: fake.access,
    projects: {
      async authorizeProject(s, projectId) {
        await fake.access.authorize(s, "write");
        if (projectId !== "p1") throw new p.PlatformError("not_found", "project");
        return { id: projectId };
      },
    },
    issues: {
      async authorizeIssue(s, issueId) {
        await fake.access.authorize(s, "write");
        if (issueId !== "i1") throw new p.PlatformError("not_found", "issue");
        return { id: issueId };
      },
      async createIssue(_s, input) {
        issueCalls.push(input);
        return { id: input.issueId, number: 1, version: 1 };
      },
    },
    wiki: {
      async authorizePage(s, pageId) {
        await fake.access.authorize(s, "write");
        if (pageId !== "page1") throw new p.PlatformError("not_found", "page");
        return { id: pageId };
      },
    },
    clock: { now: () => now },
    ids: { next: () => `x${++seq}` },
    vault: p.createSecretVault("ab".repeat(32)),
    limiter: {
      async allow() {
        return true;
      },
    },
    send: async (url, init) => {
      sends.push({ url, init });
      return new Response("", { status: sendStatus });
    },
  });
  return {
    db,
    raw,
    ...module,
    scope,
    sends,
    issueCalls,
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
    at += delay;
  }
  assert.equal(await f.background.drain(), 0);
  assert.equal(f.sends.length, 5);
  assert(f.sends.every((x) => x.init.headers["x-projektor-signature"].length === 64));
});
