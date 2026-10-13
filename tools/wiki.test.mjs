import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

let platform;
let mf;
let counter = 0;
const code = (name) => (error) => error.code === name;
const create = (pageId, operationId = `create-${pageId}`, projectId = "p1", slug = pageId) => ({
  pageId,
  operationId,
  projectId,
  slug,
  title: "Start",
  body: "First body",
});
const edit = (pageId, operationId, expectedVersion, title, body = "body") => ({
  pageId,
  operationId,
  expectedVersion,
  title,
  body,
});

before(async () => {
  fs.mkdirSync(".tmp", { recursive: true });
  const bundle = await build({
    entryPoints: ["tools/wiki-test-entry.ts"],
    outfile: ".tmp/test-entry.mjs",
    bundle: true,
    format: "esm",
    platform: "node",
    metafile: true,
  });
  assert(Object.keys(bundle.metafile.inputs).every((file) => !file.startsWith("modules/issues/")));
  platform = await import("../.tmp/test-entry.mjs");
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('test'); } }",
    compatibilityDate: "2026-07-30",
    d1Databases: Array.from({ length: 40 }, (_, i) => `WIKI${i}`),
  });
});
after(async () => {
  await mf?.dispose();
});

async function fixture() {
  const db = await mf.getD1Database(`WIKI${counter++}`);
  await platform.migrate(db, ["wiki"]);
  const rawStore = platform.createModuleStore(db, "wiki");
  const state = { hook: null, denied: new Set(), archived: new Set(), calls: [] };
  const store = {
    owner: "wiki",
    run: (...args) => rawStore.run(...args),
    batch: (calls) => (state.hook ? state.hook(calls) : rawStore.batch(calls)),
  };
  const auth = platform.fakeAccess();
  const issue = (workspaceId, principalId, kind = "human", overrides = {}) =>
    auth.issue({
      id: principalId,
      workspaceId,
      kind,
      role: "member",
      scope: "write",
      active: true,
      ...overrides,
    });
  const projects = {
    async authorizeProject(scope, projectId, permission = "read") {
      state.calls.push([scope.workspaceId, scope.principalId, projectId, permission]);
      await auth.access.authorize(scope, permission);
      if (
        !["p1", "p2"].includes(projectId) ||
        state.archived.has(`${scope.workspaceId}:${projectId}`) ||
        state.denied.has(`${scope.workspaceId}:${scope.principalId}:${projectId}`)
      )
        throw new platform.PlatformError("not_found", "Project absent");
      return {
        id: projectId,
        key: projectId,
        name: projectId,
        version: 1,
        archived: false,
        role: "editor",
      };
    },
  };
  const deps = {
    store,
    projects,
    clock: { now: () => 1800000000 },
    ids: { next: () => crypto.randomUUID() },
    eventConsumer: "test",
  };
  const { api, eventReader } = platform.createWiki(deps);
  return {
    db,
    rawStore,
    state,
    deps,
    api,
    eventReader,
    auth,
    projects,
    human: issue("w1", "human"),
    bot: issue("w1", "bot", "machine"),
    other: issue("w2", "human"),
    issue,
  };
}
async function counts(db) {
  const result = {};
  for (const name of [
    "wiki_pages",
    "wiki_revisions",
    "wiki_receipts",
    "wiki_events",
    "wiki_search",
    "wiki_guards",
  ])
    result[name] = (await db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).first()).n;
  return result;
}

test("rules validate slug, text, versions and literal search terms", async () => {
  const f = await fixture();
  assert.deepEqual(platform.wikiRules.searchTerms("日本語 test"), ["日本語", "test"]);
  assert.equal(platform.wikiRules.searchExpression(['a"b']), '"a""b"');
  assert.equal(platform.wikiRules.searchPattern("a_%"), "%a\\_\\%%");
  for (const slug of ["Bad", "bad_thing", "-bad", "bad-", "a--b", "", "x".repeat(129)])
    await assert.rejects(f.api.createPage(f.human, { ...create("x"), slug }), code("validation"));
  await assert.rejects(
    f.api.createPage(f.human, { ...create("x"), title: "  " }),
    code("validation"),
  );
  await assert.rejects(
    f.api.createPage(f.human, { ...create("x"), body: "x".repeat(100001) }),
    code("validation"),
  );
  await f.api.createPage(f.human, create("x"));
  for (const expectedVersion of [0, -1, 1.5, "1"])
    await assert.rejects(
      f.api.editPage(f.human, edit("x", "bad", expectedVersion, "Title")),
      code("validation"),
    );
  await assert.rejects(
    f.api.listPages(f.human, { projectId: "p1", cursor: 0 }),
    code("validation"),
  );
  await assert.rejects(
    f.api.searchPages(f.human, { projectId: "p1", text: "*" }),
    code("validation"),
  );
});

test("create, edit, archive preserve Markdown revisions, attribution and immutable events", async () => {
  const f = await fixture();
  const bot = f.issue("w1", "bot", "machine", { clientId: "client-one" });
  assert.deepEqual(
    await f.api.createPage(bot, {
      ...create("page"),
      body: "# Markdown\n<script>literal</script>",
    }),
    { id: "page", version: 1 },
  );
  assert.equal(
    (await f.api.getPage(bot, { projectId: "p1", slug: "page" })).body,
    "# Markdown\n<script>literal</script>",
  );
  await f.api.editPage(bot, edit("page", "edit-page", 1, "Second", "日本語 English"));
  assert.deepEqual(
    (await f.api.listRevisions(bot, "page")).revisions.map((r) => r.version),
    [2, 1],
  );
  assert.equal(
    (await f.api.getRevision(bot, "page", 1)).body,
    "# Markdown\n<script>literal</script>",
  );
  assert.equal((await f.api.getRevision(bot, "page", 2)).clientId, "client-one");
  assert.equal((await f.api.getRevision(bot, "page", 2)).actorKind, "machine");
  assert.deepEqual(
    (await f.api.readEvents(f.eventReader, "w1", 0, 10)).map((e) => [
      e.type,
      e.aggregateVersion,
      e.payload.clientId,
    ]),
    [
      ["PageCreated", 1, "client-one"],
      ["PageChanged", 2, "client-one"],
    ],
  );
  await f.api.archivePage(bot, { pageId: "page", expectedVersion: 2, operationId: "archive-page" });
  assert.equal((await f.api.getRevision(bot, "page", 3)).action, "archive");
  await assert.rejects(f.api.getPage(bot, { pageId: "page" }), code("not_found"));
  await assert.rejects(f.api.editPage(bot, edit("page", "late", 3, "Late")), code("not_found"));
  assert.deepEqual(await f.api.readOperation(bot, "archive-page"), { id: "page", version: 3 });
  assert.equal((await f.api.searchPages(bot, { projectId: "p1", text: "日本語" })).length, 0);
});

test("concurrent edits retain exactly one revision per version and report current version", async () => {
  const f = await fixture();
  await f.api.createPage(f.human, create("race"));
  const settled = await Promise.allSettled([
    f.api.editPage(f.human, edit("race", "left", 1, "Left")),
    f.api.editPage(f.human, edit("race", "right", 1, "Right")),
  ]);
  assert.equal(settled.filter((r) => r.status === "fulfilled").length, 1);
  const loser = settled.find((r) => r.status === "rejected");
  assert.equal(loser.reason.code, "conflict");
  assert.match(loser.reason.message, /current version 2/);
  assert.deepEqual(
    (await f.api.listRevisions(f.human, "race")).revisions.map((r) => r.version),
    [2, 1],
  );
  assert.equal((await f.api.readEvents(f.eventReader, "w1", 0, 10)).length, 2);
  assert.equal(await f.api.readOperation(f.human, loser === settled[0] ? "left" : "right"), null);
});

test("stale CAS cannot mint a receipt when the expected revision is absent", async () => {
  const f = await fixture();
  await f.api.createPage(f.human, create("guarded"));
  await f.db
    .prepare("UPDATE wiki_pages SET version=2 WHERE workspace_id=? AND id=?")
    .bind("w1", "guarded")
    .run();
  const before = await counts(f.db);
  await assert.rejects(
    f.api.editPage(f.human, edit("guarded", "stale", 1, "Must not apply")),
    code("conflict"),
  );
  assert.deepEqual(await counts(f.db), before);
  assert.equal((await f.api.getPage(f.human, { pageId: "guarded" })).title, "Start");
  assert.equal(await f.api.readOperation(f.human, "stale"), null);
});

test("same operation retries and response loss recover without duplicate side effects", async () => {
  const f = await fixture();
  const original = await f.api.createPage(f.human, create("retry"));
  assert.deepEqual(await f.api.createPage(f.human, create("retry")), original);
  await assert.rejects(
    f.api.createPage(f.human, { ...create("retry"), body: "different" }),
    code("conflict"),
  );
  await f.api.editPage(f.human, edit("retry", "edit-retry", 1, "Edited"));
  const before = await counts(f.db);
  assert.deepEqual(await f.api.editPage(f.human, edit("retry", "edit-retry", 1, "Edited")), {
    id: "retry",
    version: 2,
  });
  assert.deepEqual(await counts(f.db), before);
  f.state.hook = async (calls) => {
    f.state.hook = null;
    await f.rawStore.batch(calls);
    throw new Error("response lost");
  };
  assert.deepEqual(
    await f.api.archivePage(f.human, { pageId: "retry", expectedVersion: 2, operationId: "lost" }),
    { id: "retry", version: 3 },
  );
  assert.deepEqual(await f.api.readOperation(f.human, "lost"), { id: "retry", version: 3 });
  const restarted = platform.createWiki({ ...f.deps, store: f.rawStore }).api;
  assert.deepEqual(
    await restarted.archivePage(f.human, {
      pageId: "retry",
      expectedVersion: 2,
      operationId: "lost",
    }),
    { id: "retry", version: 3 },
  );
  assert.equal((await counts(f.db)).wiki_revisions, 3);
});

test("failed final event rolls back page, FTS, revision, receipt and guard for every command", async () => {
  const f = await fixture();
  for (const [action, call] of [
    ["create", () => f.api.createPage(f.human, create("failed"))],
    ["edit", () => f.api.editPage(f.human, edit("stable", "bad-edit", 1, "Changed", "日本語"))],
    [
      "archive",
      () =>
        f.api.archivePage(f.human, {
          pageId: "stable",
          expectedVersion: 1,
          operationId: "bad-archive",
        }),
    ],
  ]) {
    if (action === "edit") await f.api.createPage(f.human, create("stable"));
    const before = await counts(f.db);
    f.state.hook = (calls) =>
      f.rawStore.batch([
        ...calls,
        {
          name: "event",
          values: [
            "w1",
            "w1",
            crypto.randomUUID(),
            "bad",
            1,
            "not-an-event",
            1,
            "human",
            "human",
            null,
          ],
        },
      ]);
    await assert.rejects(call(), code("conflict"));
    f.state.hook = null;
    assert.deepEqual(await counts(f.db), before, action);
  }
  assert.equal((await f.api.getPage(f.human, { pageId: "stable" })).title, "Start");
  assert.equal((await f.api.searchPages(f.human, { projectId: "p1", text: "日本語" })).length, 0);
});

test("two workspaces, project predicates, live admission and receipt visibility", async () => {
  const f = await fixture();
  await f.api.createPage(f.human, { ...create("same", "w1-create"), title: "ONE" });
  await f.api.createPage(f.other, { ...create("same", "w2-create"), title: "TWO" });
  await f.api.createPage(f.human, {
    ...create("another", "p2-create", "p2", "same"),
    title: "OTHER PROJECT",
  });
  assert.equal((await f.api.getPage(f.human, { pageId: "same" })).title, "ONE");
  assert.equal((await f.api.getPage(f.other, { pageId: "same" })).title, "TWO");
  assert.equal((await f.api.getPage(f.human, { projectId: "p2", slug: "same" })).id, "another");
  assert.equal((await f.api.listPages(f.human, { projectId: "p1" })).pages.length, 1);
  assert.equal((await f.api.searchPages(f.human, { projectId: "p1", text: "TWO" })).length, 0);
  assert.equal((await f.api.readEvents(f.eventReader, "w2", 0, 10)).length, 1);
  assert.equal(await f.api.readOperation(f.other, "w1-create"), null);
  f.state.denied.add("w1:human:p1");
  await assert.rejects(f.api.getPage(f.human, { pageId: "same" }), code("not_found"));
  await assert.rejects(f.api.getRevision(f.human, "same", 1), code("not_found"));
  await assert.rejects(f.api.listPages(f.human, { projectId: "p1" }), code("not_found"));
  await assert.rejects(
    f.api.searchPages(f.human, { projectId: "p1", text: "ONE" }),
    code("not_found"),
  );
  await assert.rejects(f.api.readOperation(f.human, "w1-create"), code("not_found"));
  await assert.rejects(
    f.api.editPage(f.human, edit("same", "denied", 1, "DENIED")),
    code("not_found"),
  );
  f.state.denied.delete("w1:human:p1");
  const readOnly = f.issue("w1", "reader", "human", { scope: "read" });
  await assert.rejects(f.api.createPage(readOnly, create("read-only")), code("forbidden"));
  await assert.rejects(
    f.api.editPage(readOnly, edit("same", "read-edit", 1, "No")),
    code("forbidden"),
  );
  f.state.archived.add("w1:p1");
  await assert.rejects(f.api.getPage(f.human, { pageId: "same" }), code("not_found"));
});

test("Q1 admitted write may commit after project revoke; a new admission is rejected", async () => {
  const f = await fixture();
  await f.api.createPage(f.human, create("admitted"));
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  f.state.hook = async (calls) => {
    entered();
    await barrier;
    return f.rawStore.batch(calls);
  };
  const pending = f.api.editPage(f.human, edit("admitted", "inflight", 1, "Committed"));
  await started;
  f.state.denied.add("w1:human:p1");
  release();
  await assert.rejects(pending, code("not_found"));
  f.state.hook = null;
  assert.equal(
    (
      await f.db
        .prepare("SELECT title FROM wiki_pages WHERE workspace_id=? AND id=?")
        .bind("w1", "admitted")
        .first()
    ).title,
    "Committed",
  );
  await assert.rejects(
    f.api.editPage(f.human, edit("admitted", "after-revoke", 2, "Denied")),
    code("not_found"),
  );
  f.state.denied.delete("w1:human:p1");
  assert.deepEqual(await f.api.readOperation(f.human, "inflight"), { id: "admitted", version: 2 });
});

test("Japanese, English, mixed and short literal search stays in one project", async () => {
  const f = await fixture();
  await f.api.createPage(f.human, {
    ...create("one"),
    title: "日本語 Handbook",
    body: "設計 document 100%_safe",
  });
  await f.api.createPage(f.human, {
    ...create("two"),
    title: "English Guide",
    body: "日本の docs",
  });
  await f.api.createPage(f.human, {
    ...create("other", "other-create", "p2"),
    title: "日本語 Handbook",
  });
  for (const [term, expected] of [
    ["日本語", ["one"]],
    ["Handbook", ["one"]],
    ["日本語 Handbook", ["one"]],
    ["日", ["one", "two"]],
    ["日本", ["one", "two"]],
    ["100%_safe", ["one"]],
    ["日 Handbook", ["one"]],
  ]) {
    const found = await f.api.searchPages(f.human, { projectId: "p1", text: term });
    assert.deepEqual(found.map((p) => p.id).sort(), expected.sort(), term);
  }
  await f.api.editPage(f.human, edit("one", "replace", 1, "Changed", "fresh words"));
  assert.equal((await f.api.searchPages(f.human, { projectId: "p1", text: "Handbook" })).length, 0);
  assert.deepEqual(
    (await f.api.searchPages(f.human, { projectId: "p1", text: "fresh" })).map((p) => p.id),
    ["one"],
  );
});

test("case-insensitive slug uniqueness, keyset lists, revision paging and event reader capability", async () => {
  const f = await fixture();
  await f.api.createPage(f.human, create("alpha"));
  await f.api.createPage(f.human, create("beta"));
  await f.api.createPage(f.human, create("gamma"));
  await assert.rejects(
    f.db
      .prepare(
        "INSERT INTO wiki_pages(workspace_id,id,project_id,slug,title,body,version) VALUES(?,?,?,?,?,?,1)",
      )
      .bind("w1", "dup", "p1", "ALPHA", "x", "")
      .run(),
    /UNIQUE/i,
  );
  const first = await f.api.listPages(f.human, { projectId: "p1", limit: 1 });
  assert.deepEqual(
    first.pages.map((p) => p.slug),
    ["alpha"],
  );
  const second = await f.api.listPages(f.human, {
    projectId: "p1",
    cursor: first.nextCursor,
    limit: 1,
  });
  assert.deepEqual(
    second.pages.map((p) => p.slug),
    ["beta"],
  );
  assert.equal(
    (await f.api.listPages(f.human, { projectId: "p1", cursor: "gamma", limit: 1 })).nextCursor,
    null,
  );
  await f.api.editPage(f.human, edit("alpha", "e1", 1, "Version 2"));
  await f.api.editPage(f.human, edit("alpha", "e2", 2, "Version 3"));
  const revisions = await f.api.listRevisions(f.human, "alpha", undefined, 1);
  assert.deepEqual(
    revisions.revisions.map((r) => r.version),
    [3],
  );
  assert.deepEqual(
    (await f.api.listRevisions(f.human, "alpha", revisions.nextCursor, 1)).revisions.map(
      (r) => r.version,
    ),
    [2],
  );
  await assert.rejects(f.api.readEvents({}, "w1", 0, 10), code("forbidden"));
  const events = await f.api.readEvents(f.eventReader, "w1", 0, 2);
  assert.deepEqual(
    events.map((e) => e.cursor),
    [1, 2],
  );
  assert.equal((await f.api.readEvents(f.eventReader, "w1", 2, 10)).length, 3);
});
