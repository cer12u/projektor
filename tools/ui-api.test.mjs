import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { createFetchMock, Miniflare } from "miniflare";

const issuer = "https://ui-test.cloudflareaccess.com";
const audience = "ui-test";
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
let pair, jwk, platform, mf, db, access, alice, bob, unjoined;
async function sign(subject, email = `${subject}@example.test`) {
  const now = Math.floor(Date.now() / 1000);
  const message = `${b64({ alg: "RS256", kid: jwk.kid })}.${b64({ iss: issuer, aud: [audience], sub: subject, email, type: "app", iat: now - 1, exp: now + 3600 })}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    pair.privateKey,
    new TextEncoder().encode(message),
  );
  return `${message}.${Buffer.from(signature).toString("base64url")}`;
}
function createMf(adminEmails = "") {
  const fetchMock = createFetchMock();
  fetchMock
    .get(issuer)
    .intercept({ path: "/cdn-cgi/access/certs" })
    .reply(200, JSON.stringify({ keys: [jwk] }), {
      headers: { "content-type": "application/json" },
    })
    .persist();
  return new Miniflare({
    modules: true,
    scriptPath: ".tmp/ui-api-worker.mjs",
    compatibilityDate: "2026-07-30",
    fetchMock,
    assets: {
      directory: ".tmp/ui-assets",
      binding: "ASSETS",
      routerConfig: { has_user_worker: true },
    },
    d1Databases: ["DB"],
    kvNamespaces: ["KV"],
    r2Buckets: ["R2"],
    ratelimits: { FEEDBACK_LIMIT: { namespace_id: "2003", simple: { limit: 60, period: 60 } } },
    bindings: {
      ACCESS_TEAM_DOMAIN: issuer,
      ACCESS_AUDIENCE: audience,
      INTEGRATIONS_KEY: "ab".repeat(32),
      ...(adminEmails ? { ADMIN_EMAILS: adminEmails } : {}),
    },
  });
}
async function request(
  path,
  {
    method = "GET",
    token = alice,
    workspace,
    host = "localhost",
    body,
    origin = true,
    bearer,
  } = {},
) {
  const headers = {
    ...(bearer ? { authorization: `Bearer ${bearer}` } : { cookie: `CF_Authorization=${token}` }),
    ...(workspace ? { "x-workspace-slug": workspace } : {}),
    ...(body ? { "content-type": "application/json" } : {}),
    ...(origin && method !== "GET" ? { origin: `http://${host}` } : {}),
  };
  const response = await mf.dispatchFetch(`http://${host}${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, response };
}
before(async () => {
  fs.mkdirSync(".tmp/ui-assets/projects/view", { recursive: true });
  for (const path of [
    "index.html",
    "projects/view/index.html",
    "issues/view/index.html",
    "share/view/index.html",
    "feedback/view/index.html",
    "wiki/view/index.html",
  ]) {
    const full = `.tmp/ui-assets/${path}`;
    fs.mkdirSync(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(full, `<html><body>${path}</body></html>`);
  }
  await build({
    entryPoints: ["tools/test-entry.ts"],
    outfile: ".tmp/test-entry.mjs",
    bundle: true,
    format: "esm",
    platform: "node",
  });
  await build({
    entryPoints: ["apps/worker/index.ts"],
    outfile: ".tmp/ui-api-worker.mjs",
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
  });
  platform = await import("../.tmp/test-entry.mjs");
  pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  jwk = {
    ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
    kid: "ui-test",
    alg: "RS256",
    use: "sig",
  };
  mf = createMf();
  db = await mf.getD1Database("DB");
  await platform.migrate(db, [
    "access",
    "projects",
    "issues",
    "wiki",
    "coordination",
    "assets",
    "planning",
    "insights",
    "integrations",
    "lifecycle",
  ]);
  access = platform.createAccess({
    store: platform.createModuleStore(db, "access"),
    kv: platform.createScopedKV(await mf.getKVNamespace("KV"), "access"),
    clock: platform.systemClock,
    ids: platform.randomIds,
    config: { teamDomain: issuer, audience },
    fetchJwks: async () => ({ keys: [jwk] }),
  }).api;
  alice = await sign("alice");
  bob = await sign("bob");
  unjoined = await sign("unjoined");
  const a = await access.authenticate({ kind: "human", assertion: alice });
  const b = await access.authenticate({ kind: "human", assertion: bob });
  for (const w of ["w1", "w2"])
    await access.createWorkspace(a, { workspaceId: w, name: w, operationId: `create-${w}` });
  await access.createWorkspace(b, { workspaceId: "w3", name: "Third", operationId: "create-w3" });
});
after(async () => {
  await mf?.dispose();
});

test("session, workspace resolution, identity profile and isolation", async () => {
  const me = await request("/auth/me");
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.auth, { kind: "human", method: "access", principalKind: "user" });
  assert.equal(me.body.user.email, "alice@example.test");
  assert.equal(me.body.user.name, "alice");
  assert.deepEqual(
    me.body.workspaces.map((w) => w.slug),
    ["w1", "w2"],
  );
  const missingWorkspace = await request("/api/projects");
  assert.equal(missingWorkspace.status, 400);
  assert.deepEqual(missingWorkspace.body, {
    error: "Workspace not specified: missing X-Workspace-Slug header",
  });
  assert.equal((await request("/api/projects", { workspace: "w1" })).status, 200);
  assert.equal((await request("/api/projects", { host: "w1.example.test" })).status, 200);
  assert.equal((await request("/api/projects", { token: bob })).status, 200);
  assert.equal((await request("/api/projects", { token: bob, workspace: "w1" })).status, 403);
  assert.equal(
    (await request("/api/workspaces/w1", { token: bob, host: "w1.example.test" })).status,
    403,
  );
  const ws = await request("/api/workspaces/w1", { workspace: "w1" });
  assert.equal(ws.status, 200);
  assert.deepEqual(Object.keys(ws.body).sort(), [
    "currentUserRole",
    "id",
    "members",
    "name",
    "slug",
  ]);
  assert.equal(ws.body.members[0].email, "alice@example.test");
  assert.equal(ws.body.members[0].joinedAt, 0);
  assert.equal((await request("/api/projects", { token: unjoined, workspace: "w1" })).status, 403);
});

test("foundation endpoints, commands, conflict, and deferred routes", async () => {
  const login = await mf.dispatchFetch(
    "http://localhost/auth/login?redirect_url=%2Fprojects%2Fview%2Fsafe",
    { redirect: "manual" },
  );
  assert.equal(login.status, 302);
  assert.equal(login.headers.get("location"), "http://localhost/projects/view/safe");
  const unsafe = await mf.dispatchFetch(
    "http://localhost/auth/login?redirect_url=%2F%5Cattacker.test",
    { redirect: "manual" },
  );
  assert.equal(unsafe.headers.get("location"), "http://localhost/");
  assert.deepEqual((await request("/api/health")).body, { ok: true });
  assert.deepEqual((await request("/api/config/brand")).body, {
    name: "Projektor",
    mark: "P",
    accent: null,
    onAccent: null,
    logoUrl: null,
  });
  assert.deepEqual((await request("/api/projects", { workspace: "w1" })).body, []);
  const created = await request("/api/projects", {
    method: "POST",
    workspace: "w1",
    body: { name: "Example", key: "EX", description: "Description" },
  });
  assert.equal(created.status, 201);
  assert.deepEqual(Object.keys(created.body).sort(), ["id", "key", "name", "slug"]);
  assert.equal(created.body.slug, "ex");
  const list = await request("/api/projects", { workspace: "w1" });
  assert.equal(list.body.length, 1);
  assert.deepEqual(Object.keys(list.body[0]).sort(), [
    "archived_at",
    "backlog_issue_count",
    "created_at",
    "description",
    "id",
    "key",
    "name",
    "open_issue_count",
    "slug",
    "updated_at",
    "workspace_id",
    "workspace_name",
    "workspace_slug",
  ]);
  assert.equal(list.body[0].open_issue_count, 0);
  const detail = await request(`/api/projects/${created.body.slug}`, { workspace: "w1" });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.id, created.body.id);
  assert.equal(detail.body.agentWipLimit, null);
  assert.equal(detail.body.epicAutoClose, false);
  const patch = await request(`/api/projects/${created.body.id}`, {
    method: "PATCH",
    workspace: "w1",
    body: { description: "Updated" },
  });
  assert.deepEqual(patch.body, { ok: true });
  assert.equal(
    (await request(`/api/projects/${created.body.id}`, { workspace: "w1" })).body.description,
    "Updated",
  );
  const limit = await request(`/api/projects/${created.body.id}`, {
    method: "PATCH",
    workspace: "w1",
    body: { agent_wip_limit: 4 },
  });
  assert.deepEqual(limit.body, { ok: true });
  assert.equal(
    (await request(`/api/projects/${created.body.id}`, { workspace: "w1" })).body.agentWipLimit,
    4,
  );
  assert.equal(
    (await request(`/api/projects/${created.body.id}`, { token: bob, workspace: "w3" })).status,
    404,
  );
  assert.equal(
    (
      await request(`/api/projects/${created.body.id}`, {
        method: "PATCH",
        workspace: "w1",
        body: { epic_auto_close: true },
      })
    ).status,
    501,
  );
  assert.deepEqual((await request("/api/issues", { workspace: "w1" })).body, {
    items: [],
    nextCursor: null,
    total: 0,
  });
  assert.equal(
    (
      await request("/api/projects", {
        method: "POST",
        workspace: "w1",
        origin: false,
        body: { name: "No", key: "NO" },
      })
    ).status,
    403,
  );
  assert.equal((await request("/auth/me", { bearer: "oauth-token" })).status, 403);
});

test("SPA fallback maps original routes to static pages", async () => {
  for (const [route, file] of [
    ["/", "index.html"],
    ["/projects/view/ex", "projects/view/index.html"],
    ["/projects/ex/issues/1/test", "issues/view/index.html"],
    ["/share/abc", "share/view/index.html"],
    ["/feedback/abc", "feedback/view/index.html"],
    ["/wiki/home", "wiki/view/index.html"],
  ]) {
    const response = await mf.dispatchFetch(`http://localhost${route}`);
    assert.equal(response.status, 200, route);
    assert.match(await response.text(), new RegExp(file.replaceAll("/", "\\/")));
  }
});

test("admin bootstrap is once only and does not join other users", async () => {
  const bootstrapMf = createMf("ADMIN@example.test");
  try {
    const bootstrapDb = await bootstrapMf.getD1Database("DB");
    await platform.migrate(bootstrapDb, [
      "access",
      "projects",
      "issues",
      "wiki",
      "coordination",
      "assets",
      "planning",
      "insights",
      "integrations",
      "lifecycle",
    ]);
    const admin = await sign("admin", "admin@example.test");
    const ordinary = await sign("ordinary");
    const call = async (token) => {
      const response = await bootstrapMf.dispatchFetch("http://localhost/auth/me", {
        headers: { cookie: `CF_Authorization=${token}` },
      });
      return { status: response.status, body: await response.json() };
    };
    assert.deepEqual((await call(ordinary)).body.workspaces, []);
    const first = await call(admin);
    assert.equal(first.status, 200);
    assert.deepEqual(
      first.body.workspaces.map((w) => w.id),
      ["projektor"],
    );
    assert.deepEqual(
      (await call(admin)).body.workspaces.map((w) => w.id),
      ["projektor"],
    );
    assert.deepEqual((await call(ordinary)).body.workspaces, []);
    const latch = await bootstrapDb.prepare("SELECT COUNT(*) n FROM access_bootstrap").first();
    assert.equal(latch.n, 1);
  } finally {
    await bootstrapMf.dispose();
  }
});

// Ported assertions: d39852ce:apps/api/src/test/issues.test.ts,
// issues-pagination.test.ts, issues-labels.test.ts, comments.test.ts,
// issue-links.test.ts, task-statuses.test.ts and task-types.test.ts.
test("issue UI API contracts, refs, filters, comments, links and workspace isolation", async () => {
  const project = await request("/api/projects", {
    method: "POST",
    workspace: "w1",
    body: { name: "Issues Project", key: "ISS" },
  });
  assert.equal(project.status, 201);
  const projectId = project.body.id;
  const create = (title, extra = {}) =>
    request("/api/issues", {
      method: "POST",
      workspace: "w1",
      body: { projectId, title, ...extra },
    });
  const first = await create("First issue", { priority: "high", labels: ["bug", "urgent"] });
  const second = await create("Second issue", { priority: "low" });
  assert.equal(first.status, 201);
  assert.deepEqual(Object.keys(first.body).sort(), ["id", "number"]);
  assert.equal(second.status, 201);
  const ref = `ISS-${first.body.number}`;
  const byId = await request(`/api/issues/${first.body.id}`, { workspace: "w1" });
  const byRef = await request(`/api/issues/${ref}`, { workspace: "w1" });
  assert.equal(byId.status, 200);
  assert.deepEqual(byRef.body, byId.body);
  assert.equal(byId.body.body, "");
  assert.equal(byId.body.author_kind, "human");
  assert.deepEqual(JSON.parse(byId.body.labels), ["bug", "urgent"]);
  assert.equal(byId.body.url, `/projects/ISS/issues/${first.body.number}/first-issue`);
  assert.deepEqual(
    Object.keys(byId.body).sort(),
    Object.keys({
      id: "",
      workspace_id: "",
      project_id: "",
      number: 0,
      title: "",
      status: "",
      status_id: "",
      status_key: "",
      status_name: "",
      status_category: "",
      priority: "",
      assignee_id: null,
      assignee_name: null,
      labels: "[]",
      parent_id: null,
      type_id: null,
      type_key: null,
      type_name: null,
      sprint_id: null,
      created_by_id: "",
      author_kind: "",
      created_at: 0,
      updated_at: 0,
      completed_at: null,
      due_date: null,
      estimate: null,
      needs_audit: false,
      project_key: "",
      project_name: "",
      customFields: [],
      url: "",
      body: "",
      rollup: {},
      links: [],
      ready_at: null,
      claimed_at: null,
      done_at: null,
      in_review_at: null,
      review_bounce_count: 0,
      dor_ready: false,
      dor_missing: [],
      resolution_history: [],
      resolution_history_has_more: false,
      last_completed_at: null,
      completed_at_source: null,
    }).sort(),
  );
  const list = await request("/api/issues?limit=1", { workspace: "w1" });
  assert.equal(list.status, 200);
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.total, 2);
  assert.ok(list.body.nextCursor);
  assert.equal(Object.hasOwn(list.body.items[0], "body"), false);
  const page2 = await request(
    `/api/issues?limit=1&cursor=${encodeURIComponent(list.body.nextCursor)}`,
    { workspace: "w1" },
  );
  assert.equal(page2.body.total, null);
  assert.equal(page2.body.items.length, 1);
  const filtered = await request(
    "/api/issues?priorities=high&labels=bug,urgent&labelsMode=all&includeBody=1&includeRollups=1",
    { workspace: "w1" },
  );
  assert.equal(filtered.body.total, 1);
  assert.equal(filtered.body.items[0].body, "");
  assert.equal(filtered.body.items[0].rollup.total, 0);
  assert.equal((await request("/api/issues?assignee=me", { workspace: "w1" })).body.total, 0);
  assert.equal((await request("/api/issues?sprintId=x", { workspace: "w1" })).status, 404);
  for (const param of ["cfKey=a", "needsAudit=true"]) {
    assert.equal((await request(`/api/issues?${param}`, { workspace: "w1" })).status, 501);
  }
  const actorId = (await request("/auth/me")).body.user.id;
  const patched = await request(`/api/issues/${ref}`, {
    method: "PATCH",
    workspace: "w1",
    body: {
      title: "Changed issue",
      statusId: "status_in_progress",
      priority: "urgent",
      labels: ["fixed"],
      assigneeId: actorId,
    },
  });
  assert.equal(patched.status, 200);
  const changed = await request(`/api/issues/${first.body.id}`, { workspace: "w1" });
  assert.equal(changed.body.title, "Changed issue");
  assert.equal(changed.body.status_category, "in_progress");
  assert.equal(changed.body.assignee_id, actorId);
  assert.equal((await request("/api/issues?assignee=me", { workspace: "w1" })).body.total, 1);
  assert.equal(
    (await request("/api/issues?statusIds=status_in_progress", { workspace: "w1" })).body.total,
    1,
  );
  assert.equal(
    (await request("/api/issues?category=in_progress", { workspace: "w1" })).body.total,
    1,
  );
  assert.equal(
    (await request("/api/issues?status=in_progress", { workspace: "w1" })).body.total,
    1,
  );
  assert.equal((await request("/api/issues?priorities=urgent", { workspace: "w1" })).body.total, 1);
  assert.equal((await request("/api/issues?completedAfter=1", { workspace: "w1" })).body.total, 0);
  assert.equal((await request("/api/issues?updatedBefore=1", { workspace: "w1" })).body.total, 0);
  assert.equal((await request("/api/issues?updatedAfter=1", { workspace: "w1" })).body.total, 2);
  const child = await request(`/api/issues/${second.body.id}`, {
    method: "PATCH",
    workspace: "w1",
    body: { parentId: first.body.id, typeId: "type_bug" },
  });
  assert.equal(child.status, 200);
  assert.equal((await request(`/api/issues?parentId=${ref}`, { workspace: "w1" })).body.total, 1);
  assert.equal((await request("/api/issues?noParent=true", { workspace: "w1" })).body.total, 1);
  assert.equal((await request("/api/issues?typeId=type_bug", { workspace: "w1" })).body.total, 1);
  assert.equal(
    (await request("/api/issues?excludeTypeIds=type_bug", { workspace: "w1" })).body.total,
    1,
  );
  const comment = await request(`/api/issues/${first.body.id}/comments`, {
    method: "POST",
    workspace: "w1",
    body: { body: "First comment" },
  });
  assert.equal(comment.status, 201);
  const comments = await request(`/api/issues/${ref}/comments`, { workspace: "w1" });
  assert.equal(comments.body[0].body, "First comment");
  assert.equal(comments.body[0].author_name, "alice");
  assert.equal(comments.body[0].author_email, "alice@example.test");
  assert.equal(
    (
      await request(`/api/issues/${first.body.id}/comments/${comment.body.id}`, {
        method: "PATCH",
        workspace: "w1",
        body: { body: "Edited comment" },
      })
    ).status,
    200,
  );
  assert.equal(
    (await request(`/api/issues/${ref}/comments`, { workspace: "w1" })).body[0].body,
    "Edited comment",
  );
  assert.equal(
    (
      await request(`/api/issues/${first.body.id}/comments/${comment.body.id}`, {
        method: "DELETE",
        workspace: "w1",
      })
    ).status,
    200,
  );
  assert.deepEqual((await request(`/api/issues/${ref}/comments`, { workspace: "w1" })).body, []);
  const link = await request(`/api/issues/${first.body.id}/links`, {
    method: "POST",
    workspace: "w1",
    body: { targetIssueId: second.body.id, type: "blocks" },
  });
  assert.equal(link.status, 201);
  const links = await request(`/api/issues/${ref}/links`, { workspace: "w1" });
  assert.equal(links.body[0].type, "blocks");
  assert.equal(links.body[0].linkedIssueId, second.body.id);
  assert.equal(
    (
      await request(`/api/issues/${first.body.id}/links/${link.body.id}`, {
        method: "DELETE",
        workspace: "w1",
      })
    ).status,
    200,
  );
  assert.deepEqual((await request(`/api/issues/${ref}/links`, { workspace: "w1" })).body, []);
  const search = await request("/api/issues/search?q=Changed", { workspace: "w1" });
  assert.equal(search.status, 200);
  assert.equal(search.body[0].id, first.body.id);
  assert.equal(
    (await request("/api/issues/search?q=Changed&labels=fixed", { workspace: "w1" })).body.length,
    1,
  );
  assert.equal(
    (await request("/api/issues/search?q=Changed&labels=missing", { workspace: "w1" })).body.length,
    0,
  );
  const statuses = await request("/api/task-statuses", { workspace: "w1" });
  const types = await request("/api/task-types", { workspace: "w1" });
  assert.equal(statuses.body.find((s) => s.key === "backlog").is_default, true);
  assert.equal(types.body.find((t) => t.key === "task").is_default, true);
  const projects = await request("/api/projects", { workspace: "w1" });
  const count = projects.body.find((p) => p.id === projectId);
  assert.equal(count.open_issue_count, 2);
  assert.equal(count.backlog_issue_count, 1);
  const assignedOnCreate = await create("Assigned at creation", { assigneeId: actorId });
  assert.equal(assignedOnCreate.status, 201);
  assert.equal(
    (await request(`/api/issues/${assignedOnCreate.body.id}`, { workspace: "w1" })).body
      .assignee_id,
    actorId,
  );
  const invalidAssignee = await create("Invalid assignee", { assigneeId: "absent" });
  assert.equal(invalidAssignee.status, 404);
  assert.equal((await request("/api/issues?project=ISS", { workspace: "w1" })).body.total, 3);
  assert.equal((await request("/api/issues", { workspace: "w2" })).body.total, 0);
  assert.equal((await request(`/api/issues/${ref}`, { workspace: "w2" })).status, 404);
  assert.equal((await request(`/api/issues/${ref}`, { token: bob, workspace: "w3" })).status, 404);
  assert.equal(
    (
      await request(`/api/issues/${first.body.id}`, {
        method: "PATCH",
        token: bob,
        workspace: "w3",
        body: { title: "Denied" },
      })
    ).status,
    404,
  );
  const owner = await access.authenticate({ kind: "human", assertion: alice });
  const ownerScope = await access.requireMembership(owner, "w1", "viewer-setup", "write");
  await access.inviteMember(ownerScope, {
    issuer,
    subject: "bob",
    role: "viewer",
    expectedVersion: 0,
    operationId: "viewer-bob-w1",
  });
  assert.equal((await request("/api/issues", { token: bob, workspace: "w1" })).status, 200);
  assert.equal(
    (
      await request("/api/issues", {
        token: bob,
        workspace: "w1",
        method: "POST",
        body: { projectId, title: "Denied" },
      })
    ).status,
    403,
  );
});

test("C7 issue due date and story points API shapes and filters", async () => {
  const project = await request("/api/projects", {
    method: "POST",
    workspace: "w1",
    body: { name: "Due C7", key: "DUEC7" },
  });
  assert.equal(project.status, 201);
  const first = await request("/api/issues", {
    method: "POST",
    workspace: "w1",
    body: {
      projectId: project.body.id,
      title: "Due soon",
      dueDate: "2026-10-10",
      customFields: { story_points: "5" },
    },
  });
  assert.equal(first.status, 201);
  const ref = `DUEC7-${first.body.number}`;
  const detail = await request(`/api/issues/${ref}`, { workspace: "w1" });
  assert.equal(detail.body.due_date, "2026-10-10");
  assert.equal(detail.body.estimate, 5);
  assert.deepEqual(detail.body.customFields, [{ key: "story_points", value: "5" }]);
  assert.equal(
    (
      await request(`/api/issues?project=${project.body.id}&overdue=true&today=2026-10-11`, {
        workspace: "w1",
      })
    ).body.total,
    1,
  );
  assert.equal(
    (
      await request(`/api/issues?project=${project.body.id}&dueAfter=2026-10-11`, {
        workspace: "w1",
      })
    ).body.total,
    0,
  );
  assert.equal(
    (
      await request(`/api/issues?project=${project.body.id}&hasDueDate=true&sort=due_date`, {
        workspace: "w1",
      })
    ).body.items[0].id,
    first.body.id,
  );
  const invalid = await request(`/api/issues/${ref}`, {
    method: "PATCH",
    workspace: "w1",
    body: { customFields: { story_points: "bad" } },
  });
  assert.equal(invalid.status, 400);
  const clear = await request(`/api/issues/${ref}`, {
    method: "PATCH",
    workspace: "w1",
    body: { customFields: { story_points: null }, due_date: null },
  });
  assert.equal(clear.status, 200);
  const cleared = await request(`/api/issues/${ref}`, { workspace: "w1" });
  assert.equal(cleared.body.estimate, null);
  assert.equal(cleared.body.due_date, null);
  assert.equal((await request(`/api/issues/${ref}`, { workspace: "w2" })).status, 404);
});

test("concurrent issue PATCH translates the stale CAS to HTTP 409", async () => {
  let reads = 0;
  let release;
  const bothRead = new Promise((resolve) => {
    release = resolve;
  });
  let version = 1;
  const issue = { id: "issue1", version: 1, projectId: "p1" };
  const principal = {};
  const scope = { workspaceId: "w1", principalId: "alice", role: "owner", kind: "human" };
  const services = {
    access: {
      me: async () => ({ workspaces: [{ id: "w1", name: "w1", role: "owner" }], nextCursor: null }),
      requireMembership: async () => scope,
    },
    issues: {
      getIssue: async () => {
        reads += 1;
        if (reads === 2) release();
        await bothRead;
        return issue;
      },
      updateIssue: async (_scope, input) => {
        if (input.expectedVersion !== version)
          throw new platform.PlatformError("conflict", "Stale version");
        version += 1;
        return { id: "issue1", version };
      },
      listTaskStatuses: async () => [],
    },
  };
  const authenticate = async () => principal;
  const patch = (title) =>
    platform.handleUi(
      new Request("http://localhost/api/issues/issue1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      }),
      services,
      authenticate,
      `race-${title}`,
    );
  const responses = await Promise.all([patch("first"), patch("second")]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  assert.deepEqual(await responses.find((response) => response.status === 409).json(), {
    error: "Conflict",
  });
});

test("sprints and files UI API preserve shapes and isolate workspaces", async () => {
  const project = await request("/api/projects", {
    method: "POST",
    workspace: "w1",
    body: { name: "Sprint Files", key: "SPF" },
  });
  assert.equal(project.status, 201);
  const projectId = project.body.id;
  const issue = await request("/api/issues", {
    method: "POST",
    workspace: "w1",
    body: { projectId, title: "Attachment issue" },
  });
  assert.equal(issue.status, 201);
  const created = await request("/api/sprints", {
    method: "POST",
    workspace: "w1",
    body: { projectId, name: "October", goal: "Deliver", startDate: 100, endDate: 200 },
  });
  assert.equal(created.status, 201);
  const id = created.body.id;
  const list = await request(`/api/sprints?projectId=${projectId}`, { workspace: "w1" });
  assert.equal(list.body.items[0].goal, "Deliver");
  assert.equal(list.body.items[0].status, "planned");
  assert.equal((await request(`/api/sprints/${id}`, { workspace: "w2" })).status, 404);
  assert.equal(
    (
      await request(`/api/sprints/${id}`, {
        method: "PATCH",
        workspace: "w1",
        body: { status: "active" },
      })
    ).status,
    200,
  );
  const assigned = await request(`/api/issues/${issue.body.id}`, {
    method: "PATCH",
    workspace: "w1",
    body: { sprintId: id },
  });
  assert.equal(assigned.status, 200);
  assert.equal(
    (await request(`/api/issues/${issue.body.id}`, { workspace: "w1" })).body.sprint_id,
    id,
  );
  const bySprint = await request(`/api/issues?sprintId=${id}`, { workspace: "w1" });
  assert.equal(bySprint.body.items[0].id, issue.body.id);
  assert.equal(bySprint.body.items[0].sprint_id, id);
  assert.equal(
    (await request(`/api/issues?sprintId=${id}&priority=high`, { workspace: "w1" })).status,
    501,
  );
  const link = await request("/api/files/links", {
    method: "POST",
    workspace: "w1",
    body: {
      kind: "url",
      entityType: "issue",
      entityId: issue.body.id,
      url: "https://example.test/doc",
      label: "Docs",
    },
  });
  assert.equal(link.status, 201);
  assert.equal(
    (await request(`/api/files?issueId=${issue.body.id}`, { workspace: "w1" })).body[0].kind,
    "url",
  );
  const redirect = await mf.dispatchFetch(`http://localhost/api/files/${link.body.id}`, {
    headers: { cookie: `CF_Authorization=${alice}`, "x-workspace-slug": "w1" },
    redirect: "manual",
  });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), "https://example.test/doc");
  assert.equal((await request(`/api/files/${link.body.id}`, { workspace: "w2" })).status, 404);
  const upload = async (size) => {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(size)], "data.txt", { type: "text/plain" }));
    form.set("entityType", "issue");
    form.set("entityId", issue.body.id);
    const payload = new Request("http://localhost/api/files", { method: "POST", body: form });
    return mf.dispatchFetch("http://localhost/api/files", {
      method: "POST",
      headers: {
        cookie: `CF_Authorization=${alice}`,
        "x-workspace-slug": "w1",
        origin: "http://localhost",
        "content-type": payload.headers.get("content-type"),
      },
      body: await payload.arrayBuffer(),
    });
  };
  assert.equal((await upload(10 * 1024 * 1024 + 1)).status, 400);
  const uploaded = await upload(3);
  assert.equal(uploaded.status, 201, await uploaded.clone().text());
  const file = await uploaded.json();
  assert.equal(
    (await request(`/api/files?issueId=${issue.body.id}`, { workspace: "w1" })).body.length,
    2,
  );
  const download = await mf.dispatchFetch(`http://localhost/api/files/${file.id}`, {
    headers: { cookie: `CF_Authorization=${alice}`, "x-workspace-slug": "w1" },
  });
  assert.equal(download.status, 200);
  assert.equal((await download.arrayBuffer()).byteLength, 3);
  assert.equal(
    (await request(`/api/files/${file.id}`, { method: "DELETE", workspace: "w1" })).status,
    204,
  );
  assert.equal(
    (await request(`/api/files?issueId=${issue.body.id}`, { workspace: "w1" })).body.length,
    1,
  );
});

test("wiki core UI API shapes, conflicts, workspace authorization and tenant isolation", async () => {
  const created = await request("/api/wiki", {
    method: "POST",
    workspace: "w1",
    body: { title: "Home", slug: "home", content: "Alpha body" },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.projectId, null);
  assert.equal((await request("/api/wiki?", { workspace: "w1" })).body[0].slug, "home");
  const detail = await request("/api/wiki/home", { workspace: "w1" });
  assert.equal(detail.body.content, "Alpha body");
  assert.equal(detail.body.parent_id, null);
  assert.equal(detail.body.type, null);
  assert.deepEqual(detail.body.tags, []);
  assert.equal((await request("/api/wiki/home", { workspace: "w2" })).status, 404);
  const principal = await access.authenticate({ kind: "human", assertion: alice });
  const owner = await access.requireMembership(principal, "w1", "wiki-viewer-setup", "write");
  const wikiViewer = await sign("wiki-viewer");
  await access.inviteMember(owner, {
    issuer,
    subject: "wiki-viewer",
    role: "viewer",
    expectedVersion: 0,
    operationId: "wiki-viewer",
  });
  assert.equal(
    (await request("/api/wiki/home", { token: wikiViewer, workspace: "w1" })).status,
    200,
  );
  assert.equal(
    (
      await request("/api/wiki", {
        token: wikiViewer,
        workspace: "w1",
        method: "POST",
        body: { title: "Denied" },
      })
    ).status,
    403,
  );
  const project = await request("/api/projects", {
    method: "POST",
    workspace: "w1",
    body: { name: "Wiki Project", key: "WIKIP" },
  });
  const projectPage = await request("/api/wiki", {
    method: "POST",
    workspace: "w1",
    body: { title: "Project page", slug: "project-page", projectId: project.body.id },
  });
  assert.equal(projectPage.status, 201);
  assert.equal(
    (await request("/api/wiki/project-page", { token: wikiViewer, workspace: "w1" })).status,
    404,
  );
  assert.equal(
    (await request("/api/wiki", { token: wikiViewer, workspace: "w1" })).body.some(
      (item) => item.slug === "project-page",
    ),
    false,
  );
  assert.equal(
    (await request("/api/wiki/search?q=Alpha", { workspace: "w1" })).body[0].id,
    created.body.id,
  );
  const edited = await request("/api/wiki/home", {
    method: "PUT",
    workspace: "w1",
    body: { title: "Home revised", content: "Beta body", baseRevisionId: detail.body.revisionId },
  });
  assert.equal(edited.status, 200);
  const stale = await request("/api/wiki/home", {
    method: "PUT",
    workspace: "w1",
    body: { title: "Stale", baseRevisionId: detail.body.revisionId },
  });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body, { error: "Conflict" });
  const revisions = await request("/api/wiki/home/revisions", { workspace: "w1" });
  assert.equal(revisions.body[0].title, "Home revised");
  assert.equal(
    (await request(`/api/wiki/home/revisions/${revisions.body[0].id}`, { workspace: "w1" })).body
      .content,
    "Beta body",
  );
  assert.equal((await request("/api/wiki/tree", { workspace: "w1" })).status, 501);
  assert.equal(
    (await request("/api/wiki/home", { method: "DELETE", workspace: "w1" })).status,
    200,
  );
  assert.equal((await request("/api/wiki/home", { workspace: "w1" })).status, 404);
});

test("settings token and feedback core preserve UI shapes and workspace isolation", async () => {
  const token = await request("/api/workspaces/w1/tokens", {
    workspace: "w1",
    method: "POST",
    body: { name: "Agent", scopes: ["read", "write"] },
  });
  assert.equal(token.status, 201);
  assert.match(token.body.token, /^pt1\.w1\.[^.]+\.[0-9a-f]{64}$/);
  const listed = await request("/api/workspaces/w1/tokens", { workspace: "w1" });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.find((item) => item.id === token.body.id).name, "Agent");
  assert.equal(JSON.stringify(listed.body).includes(token.body.token), false);
  assert.equal(
    (await request("/api/workspaces/w2/tokens", { workspace: "w2" })).body.some(
      (item) => item.id === token.body.id,
    ),
    false,
  );
  assert.equal((await request("/api/workspaces/w2/tokens", { workspace: "w1" })).status, 403);
  assert.equal(
    (
      await request("/api/workspaces/w1/tokens", {
        workspace: "w1",
        method: "POST",
        bearer: token.body.token,
        body: { name: "Bad" },
      })
    ).status,
    403,
  );
  const mcpBearer = await mf.dispatchFetch("http://localhost/mcp/w1", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token.body.token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      origin: "http://localhost",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(mcpBearer.status, 200);
  const mcp = await request("/api/workspaces/w1/mcp-info", { workspace: "w1" });
  assert.equal(mcp.body.mcpUrl, "http://localhost/mcp/w1");
  assert.equal(
    mcp.body.mcpAddCommandTemplate,
    'claude mcp add --transport http --header "Authorization: Bearer {{TOKEN}}" --header "X-Workspace-Slug: w1" -- projektor "http://localhost/mcp/w1"',
  );
  assert.equal(
    (
      await request(`/api/workspaces/w1/tokens/${token.body.id}`, {
        workspace: "w1",
        method: "DELETE",
      })
    ).status,
    200,
  );
  assert.equal(
    (await request("/api/workspaces/w1/tokens", { workspace: "w1", bearer: token.body.token }))
      .status,
    403,
  );
  await db
    .prepare(
      "INSERT INTO access_oauth_clients(id,name,redirect_uris,scope,refresh_allowed,created_at) VALUES(?,?,?,?,?,?)",
    )
    .bind("ui-client", "UI client", "[]", "read", 0, 1)
    .run();
  await db
    .prepare("INSERT INTO access_oauth_workspace_clients(workspace_id,client_id) VALUES(?,?)")
    .bind("w1", "ui-client")
    .run();
  const connectors = await request("/api/workspaces/w1/connectors", { workspace: "w1" });
  assert.equal(connectors.body.find((item) => item.clientId === "ui-client").client, "UI client");
  assert.equal(
    (await request("/api/workspaces/w2/connectors", { workspace: "w2" })).body.length,
    0,
  );
  assert.equal(
    (
      await request("/api/workspaces/w1/connectors/ui-client", {
        workspace: "w1",
        method: "DELETE",
      })
    ).status,
    200,
  );
  assert.equal(
    (await request("/api/workspaces/w1/connectors", { workspace: "w1" })).body.length,
    0,
  );

  const project = await request("/api/projects", {
    workspace: "w1",
    method: "POST",
    body: { name: "Feedback Core", key: "FCORE" },
  });
  assert.equal(project.status, 201);
  const source = await request(`/api/projects/${project.body.id}/feedback-sources`, {
    workspace: "w1",
    method: "POST",
    body: { name: "Widget" },
  });
  assert.equal(source.status, 201);
  assert.match(source.body.token, /^[0-9a-f]{64}$/);
  const sources = await request(`/api/projects/${project.body.id}/feedback-sources`, {
    workspace: "w1",
  });
  assert.equal(sources.body.find((s) => s.id === source.body.id).name, "Widget");
  assert.equal(
    (await request(`/api/feedback-sources/${source.body.id}`, { workspace: "w1" })).body.projectId,
    project.body.id,
  );
  assert.equal(
    (await request(`/api/feedback-sources/${source.body.id}`, { workspace: "w2" })).status,
    404,
  );
  const payload = JSON.stringify({ title: "Reported issue", body: "Feedback body" });
  const timestamp = Math.floor(Date.now() / 1000),
    delivery = crypto.randomUUID();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(source.body.token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = Buffer.from(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${timestamp}.${delivery}.${payload}`),
    ),
  ).toString("hex");
  const incoming = await mf.dispatchFetch(
    `http://localhost/integrations/feedback/w1/${source.body.id}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-projektor-timestamp": String(timestamp),
        "x-projektor-delivery-id": delivery,
        "x-projektor-signature": signature,
      },
      body: payload,
    },
  );
  assert.equal(incoming.status, 200);
  const feedback = await request(`/api/projects/${project.body.id}/feedback`, { workspace: "w1" });
  assert.equal(feedback.status, 200);
  const row = feedback.body.find((item) => item.body === "Feedback body");
  assert.equal(row.sourceName, "Widget");
  assert.equal(
    (await request(`/api/projects/${project.body.id}/feedback`, { workspace: "w2" })).status,
    404,
  );
  const converted = await request(
    `/api/projects/${project.body.id}/feedback/${row.id}/convert-to-issue`,
    { workspace: "w1", method: "POST" },
  );
  assert.equal(converted.status, 201);
  assert.equal(typeof converted.body.number, "number");
  assert.equal(
    (await request(`/api/projects/${project.body.id}/feedback/summary`, { workspace: "w1" }))
      .status,
    501,
  );
});

test("C5 flow metrics UI API shape, window validation, viewer access and workspace isolation", async () => {
  const project = await request("/api/projects", {
    method: "POST",
    workspace: "w1",
    body: { name: "Flow", key: "FLOW" },
  });
  assert.equal(project.status, 201);
  const id = project.body.id;
  const a = await request("/api/issues", {
    method: "POST",
    workspace: "w1",
    body: { projectId: id, title: "Flow done" },
  });
  const b = await request("/api/issues", {
    method: "POST",
    workspace: "w1",
    body: { projectId: id, title: "Flow active" },
  });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  for (const [issueId, statuses] of [
    [a.body.id, ["status_todo", "status_in_progress", "status_done"]],
    [b.body.id, ["status_in_progress"]],
  ])
    for (const statusId of statuses)
      assert.equal(
        (
          await request(`/api/issues/${issueId}`, {
            method: "PATCH",
            workspace: "w1",
            body: { statusId },
          })
        ).status,
        200,
      );
  const active = await request(`/api/issues/${b.body.id}`, { workspace: "w1" });
  assert.equal(typeof active.body.ready_at, "number");
  assert.equal(typeof active.body.claimed_at, "number");
  const beforeReopen = await request(`/api/issues/${a.body.id}`, { workspace: "w1" });
  assert.equal(typeof beforeReopen.body.done_at, "number");
  assert.equal(beforeReopen.body.done_at, beforeReopen.body.completed_at);
  assert.equal(
    (
      await request(`/api/issues/${a.body.id}`, {
        method: "PATCH",
        workspace: "w1",
        body: { statusId: "status_todo" },
      })
    ).status,
    200,
  );
  const reopened = await request(`/api/issues/${a.body.id}`, { workspace: "w1" });
  assert.equal(reopened.body.completed_at, null);
  assert.equal(reopened.body.done_at, beforeReopen.body.done_at);
  const path = `/api/projects/${id}/flow-metrics`;
  const metrics = await request(path, { workspace: "w1" });
  assert.equal(metrics.status, 200);
  assert.deepEqual(
    Object.keys(metrics.body).sort(),
    [
      "agingWip",
      "arrivalVsCompletionOverTime",
      "autonomyRatio",
      "bugShareOverTime",
      "bugTypeTracked",
      "cfdOverTime",
      "cycleTime",
      "factoryHealth",
      "flowEfficiency",
      "humanInterventions",
      "leadTime",
      "leadTimeExcluded",
      "reviewLatency",
      "reviewLatencyOverTime",
      "throughputOverTime",
      "timeInProgress",
      "wipOverTime",
    ].sort(),
  );
  assert.equal(metrics.body.leadTime.count, 1);
  assert.equal(metrics.body.cycleTime.count, 1);
  assert.equal(
    metrics.body.agingWip.some((x) => x.id === b.body.id),
    true,
  );
  assert.equal(metrics.body.factoryHealth.gateRejections, 0);
  assert.equal((await request(`${path}?since=0&granularity=day`, { workspace: "w1" })).status, 400);
  assert.equal((await request(`${path}?granularity=month`, { workspace: "w1" })).status, 400);
  assert.equal((await request(path, { workspace: "w2" })).status, 404);
  assert.equal(
    (await request("/api/projects/missing/flow-metrics", { workspace: "w1" })).status,
    404,
  );
  const owner = await access.authenticate({ kind: "human", assertion: alice });
  const ownerScope = await access.requireMembership(owner, "w1", "flow-viewer", "write");
  const viewer = await sign("flow-viewer");
  await access.inviteMember(ownerScope, {
    issuer,
    subject: "flow-viewer",
    role: "viewer",
    expectedVersion: 0,
    operationId: "flow-viewer",
  });
  const viewerPrincipal = await access.authenticate({ kind: "human", assertion: viewer });
  const projects = platform.createProjects({
    store: platform.createModuleStore(db, "projects"),
    access,
    clock: platform.systemClock,
    ids: platform.randomIds,
    eventConsumer: "insights",
  }).api;
  await projects.grantProjectRole(ownerScope, {
    projectId: id,
    principalId: (await access.me(viewerPrincipal)).principal.id,
    role: "viewer",
    expectedVersion: 1,
    operationId: "flow-project-viewer",
  });
  assert.equal((await request(path, { token: viewer, workspace: "w1" })).status, 200);
});
