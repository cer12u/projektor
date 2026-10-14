import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { stripVTControlCharacters } from "node:util";

// Bounded audit probes: run alone; source/catalog restored even on test failure.
const cases = [];
const patch = (path, before, after) => ({ path, before, after });
const node = (file, pattern) => [
  process.execPath,
  [
    "--test",
    "--test-reporter=tap",
    ...(pattern ? [`--test-name-pattern=${pattern}`] : []),
    `tools/${file}.test.mjs`,
  ],
];
const browser = (pattern) => [
  "pnpm",
  ["exec", "playwright", "test", "-c", "tools/playwright.config.mjs", "--grep", pattern],
];
const add = (id, patches, command) => cases.push({ id, patches, command });
const access = node("access", "07c"),
  coord = node("coordination", "07c");
const web = "apps/web/src/app.tsx",
  gateway = "gateway/public.ts";
function sql(owner, name, before, after, command = owner === "access" ? access : coord) {
  const path = `modules/${owner}/storage/queries.ts`;
  const source = fs.readFileSync(path, "utf8");
  const query = source.match(new RegExp(`  ${name}:\\s*"([^"\\n]+)"`))?.[1];
  assert(query?.includes(before), `SQL target drift: ${name}`);
  return [patch(path, `"${query}"`, `"${query.replace(before, after)}"`), command];
}
function sqlCase(id, owner, name, before, after, command) {
  const [p, c] = sql(owner, name, before, after, command);
  add(id, [p], c);
}
function methodPatch(owner, method, before, after) {
  const path = `modules/${owner}/internal/factory.ts`;
  const source = fs.readFileSync(path, "utf8");
  const start = source.indexOf(`    async ${method}(`);
  const end = source.indexOf("\n    async ", start + 1);
  const block = source.slice(start, end < 0 ? source.length : end);
  assert(start >= 0 && block.includes(before), `Method target drift: ${method}`);
  return patch(path, block, block.replace(before, after));
}
const markdown = "apps/web/src/markdown.ts";
add(
  "markdown-no-sanitizer",
  [
    patch(
      markdown,
      "return DOMPurify.sanitize(marked.parse(source, { async: false }) as string, {\n    USE_PROFILES: { html: true },\n  });",
      "return marked.parse(source, { async: false }) as string;",
    ),
  ],
  browser("project, issue"),
);
for (const [id, option] of [
  ["script", 'ADD_TAGS: ["script"],'],
  ["events", 'ADD_ATTR: ["onerror", "onclick"],'],
  ["javascript-url", "ALLOWED_URI_REGEXP: /.*/,"],
]) {
  add(
    `markdown-${id}`,
    [patch(markdown, "USE_PROFILES: { html: true },", `USE_PROFILES: { html: true }, ${option}`)],
    browser("project, issue"),
  );
}
add(
  "stale-workspace",
  [patch(web, "if (!controller.signal.aborted) setData(value);", "setData(value);")],
  browser("late decoded"),
);
add(
  "retry-new-operation",
  [patch("apps/web/src/state.ts", "if (!this.pending)", "if (true)")],
  node("web-unit", "unknown retries|server unknown|revoke retry"),
);
add(
  "error-clears-input",
  [patch(web, 'if (result) {\n      setKey("");', 'if (true) {\n      setKey("");')],
  browser("validation error keeps"),
);
add(
  "conflict-clears-input",
  [
    patch(
      web,
      'setNewer(await wire.call<Page>(workspace, "wiki.get", { pageId: id }));',
      'setBody(""); setNewer(await wire.call<Page>(workspace, "wiki.get", { pageId: id }));',
    ),
  ],
  browser("project, issue"),
);
add(
  "secret-localstorage",
  [
    patch(
      web,
      "if (result.token) setToken(result.token);",
      'if (result.token) { localStorage.setItem("credential", result.token); setToken(result.token); }',
    ),
  ],
  browser("validation error keeps"),
);
add(
  "secret-after-navigation",
  [
    patch(
      web,
      "function Admin({ workspace }:",
      'let rememberedToken = "";\nfunction Admin({ workspace }:',
    ),
    patch(
      web,
      'const [token, setToken] = useState("");',
      "const [token, setToken] = useState(rememberedToken);",
    ),
    patch(
      web,
      "if (result.token) setToken(result.token);",
      "if (result.token) { rememberedToken = result.token; setToken(result.token); }",
    ),
  ],
  browser("validation error keeps"),
);
add(
  "unpublished-route",
  [
    patch(
      "apps/web/src/wire.ts",
      "const entry = (await this.catalog()).get(name);",
      'const entry = (await this.catalog()).get(name) ?? {method: "POST", path: `/api/w/{workspaceId}/${name.replaceAll(".", "/")}`};',
    ),
  ],
  node("web-unit", "07c"),
);
add(
  "oauth-on-rest",
  [
    patch(
      gateway,
      'if (endpoint === "mcp" && services.oauthOrigin) {',
      "if (services.oauthOrigin) {",
    ),
  ],
  node("gateway-oauth-rules", "audit Gateway guards"),
);
add(
  "me-provisions",
  [
    patch(
      gateway,
      'if (url.pathname === "/api/me" && request.method === "GET") {',
      'if (url.pathname === "/api/me" && request.method === "GET") {\n      await services.access.createWorkspace(await principal(request, services, "rest"), {workspaceId:"auto07c", operationId:"auto07c", name:"auto"});',
    ),
  ],
  node("gateway", "07c"),
);
sqlCase(
  "discovery-credential-confinement",
  "access",
  "discoverWorkspaces",
  "(? IS NULL OR w.workspace_id=?)",
  "(? IS NULL OR ? IS NOT NULL)",
);
sqlCase("members-tenant", "access", "listMembers", "m.workspace_id=?", "? IS NOT NULL");
sqlCase("clients-tenant", "access", "oauthListClients", "w.workspace_id=?", "? IS NOT NULL");
for (const [name, bound] of [
  ["discoverWorkspaces", "w.workspace_id>?"],
  ["listMembers", "m.principal_id>?"],
  ["oauthListClients", "w.client_id>?"],
])
  sqlCase(`${name}-cursor`, "access", name, bound, "? IS NOT NULL");
add(
  "oauth-revoke-allowed",
  [patch("modules/access/internal/factory.ts", "      current.clientId ||\n", "")],
  access,
);
add(
  "viewer-revoke-allowed",
  [
    patch(
      "modules/access/internal/factory.ts",
      'async function manager(scope: RequestScope): Promise<RequestScope> {\n    const current = await authorize(scope, "write");',
      'async function manager(scope: RequestScope): Promise<RequestScope> {\n    const current = await authorize(scope, "read");',
    ),
    patch(
      "modules/access/internal/factory.ts",
      '(current.role !== "owner" && current.role !== "admin")',
      "false",
    ),
  ],
  node("access", "07c client revoke rejects viewer"),
);
// Remove the revoke transaction entirely: both access and refresh must be tested
// independently, rather than failing the first assertion and never reaching refresh.
add(
  "revoke-no-effect",
  [
    patch(
      "modules/access/internal/oauth.ts",
      "      return deps.commit(\n        s.workspaceId,\n        s.principalId,\n        input.operationId,\n        fp,\n        { id: input.clientId, version: input.expectedVersion + 1 },",
      "      return { id: input.clientId, version: input.expectedVersion + 1 };\n      return deps.commit(\n        s.workspaceId,\n        s.principalId,\n        input.operationId,\n        fp,\n        { id: input.clientId, version: input.expectedVersion + 1 },",
    ),
  ],
  node("access", "07c revoke invalidates"),
);
sqlCase(
  "revoke-other-client",
  "access",
  "oauthRevokeClientFamilies",
  "client_id=?",
  "? IS NOT NULL",
);
add(
  "oauth-wip-allowed",
  [
    patch(
      "modules/coordination/internal/factory.ts",
      'current.clientId || (current.role !== "owner" && current.role !== "admin")',
      '(current.role !== "owner" && current.role !== "admin")',
    ),
  ],
  coord,
);
add(
  "viewer-wip-allowed",
  [
    patch(
      "modules/coordination/internal/factory.ts",
      'current.clientId || (current.role !== "owner" && current.role !== "admin")',
      "false",
    ),
    patch(
      "modules/coordination/internal/factory.ts",
      'const current = await access.authorize(scope, "write");',
      'const current = await access.authorize(scope, "read");',
    ),
    patch(
      "modules/coordination/internal/factory.ts",
      'await projects.authorizeProject(scope, pid, "manage");',
      'await projects.authorizeProject(scope, pid, "read");',
    ),
  ],
  node("coordination", "project pages expose"),
);
for (const [name, alias, project] of [
  ["projectSessions", "s", "l"],
  ["projectLeases", "l", "l"],
  ["projectClaims", "c", "l"],
  ["projectProgress", "r", "l"],
]) {
  sqlCase(`${name}-tenant`, "coordination", name, `${alias}.workspace_id=?`, "? IS NOT NULL");
  sqlCase(`${name}-project`, "coordination", name, `${project}.project_id=?`, "? IS NOT NULL");
  add(
    `${name}-oversize`,
    [methodPatch("coordination", name, ".slice(0, size)", ".slice(0)")],
    coord,
  );
}
for (const [name, bound] of [
  ["projectSessions", "s.id>?"],
  ["projectLeases", "l.issue_id>?"],
  ["projectClaims", "(c.repo>? OR (c.repo=? AND c.path>?))"],
  ["projectProgress", "(r.reported_at<? OR (r.reported_at=? AND r.issue_id<?))"],
]) {
  const after =
    bound.split("?").length === 2
      ? "? IS NOT NULL"
      : "(? IS NOT NULL AND ? IS NOT NULL AND ? IS NOT NULL)";
  sqlCase(`${name}-cursor`, "coordination", name, bound, after);
}
for (const [name, part, bound] of [
  ["projectClaims", "repo", "c.repo>?"],
  ["projectClaims", "path", "c.path>?"],
  ["projectProgress", "time", "r.reported_at<?"],
  ["projectProgress", "issue", "r.issue_id<?"],
])
  sqlCase(`${name}-cursor-${part}`, "coordination", name, bound, "? IS NOT NULL");
for (const [name, alias] of [
  ["projectSessions", "s"],
  ["projectSessions", "l"],
  ["projectLeases", "s"],
  ["projectLeases", "l"],
  ["projectClaims", "c"],
  ["projectClaims", "l"],
])
  sqlCase(
    `${name}-expiry-${alias}`,
    "coordination",
    name,
    `${alias}.expires_at>?`,
    "? IS NOT NULL",
  );
for (const method of ["current", "listMembers"]) {
  if (method === "current")
    add(
      "discovery-oversize",
      [
        patch(
          "modules/access/internal/factory.ts",
          "workspaces: rows.slice(0, limit)",
          "workspaces: rows.slice(0)",
        ),
      ],
      access,
    );
  else
    add(
      "members-oversize",
      [methodPatch("access", method, "rows.slice(0, limit)", "rows.slice(0)")],
      access,
    );
}
add(
  "clients-oversize",
  [
    patch(
      "modules/access/internal/oauth.ts",
      "const items: OAuthClientItem[] = rows.slice(0, limit)",
      "const items: OAuthClientItem[] = rows.slice(0)",
    ),
  ],
  access,
);
add(
  "smoke-zero-missing",
  [patch("tools/cloudflare-smoke.mjs", "process.exit(78);", "process.exit(0);")],
  node("smoke", "missing either"),
);
add(
  "smoke-log-token",
  [
    patch(
      "tools/cloudflare-smoke.mjs",
      "const token = process.env.CLOUDFLARE_API_TOKEN;",
      "const token = process.env.CLOUDFLARE_API_TOKEN; console.log(token);",
    ),
  ],
  node("smoke", "successful orchestration"),
);
// Mutate checked artifacts and update checksums: a hash mismatch is not a kill.
for (const [id, file, text] of [
  ["dist-test-route", "worker.js", 'globalThis.auditRoute="/__test/other";'],
  [
    "dist-test-assertion",
    "assets/app.js",
    'globalThis.auditIssuer="https://web-test.cloudflareaccess.com";',
  ],
]) {
  add(id, [], [process.execPath, ["tools/artifact.mjs"]]);
  Object.assign(cases.at(-1), { artifact: { file, text } });
}

const baseline = process.argv.includes("--original");
const group = process.argv.find((x) => x.startsWith("--group="))?.split("=")[1];
const requested = process.argv
  .slice(2)
  .filter((x) => !x.startsWith("--group=") && x !== "--original");
const selected = cases.filter(
  (x) =>
    (!requested.length || requested.includes(x.id)) &&
    (!group ||
      (group === "browser"
        ? x.command[0] === "pnpm"
        : group === "artifact"
          ? !!x.artifact
          : x.command[0] !== "pnpm" && !x.artifact)),
);
assert(
  selected.length && requested.every((id) => cases.some((x) => x.id === id)),
  "Unknown mutation",
);
if (baseline) {
  assert(
    requested.length &&
      selected.every((p) =>
        ["unpublished-route", "projectProgress-cursor", "projectClaims-cursor"].includes(p.id),
      ),
    "Select supported original-suite probes explicitly",
  );
  for (const p of selected) {
    p.originalFile = p.command[1].at(-1);
    p.command =
      p.id === "unpublished-route"
        ? node("web-unit")
        : node("coordination", "project pages expose");
  }
}
fs.mkdirSync(".tmp", { recursive: true });
fs.mkdirSync("reports", { recursive: true });
const lock = ".tmp/web-contract-mutation.lock",
  fd = fs.openSync(lock, "wx");
const results = [],
  healthyCommands = new Set();
const run = ([bin, args]) =>
  spawnSync(bin, args, {
    encoding: "utf8",
    timeout: 240000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: "0" },
  });
const catalog = "platform/generated/catalogs.ts";
try {
  for (const probe of selected) {
    const files = [
      catalog,
      ...(probe.originalFile ? [probe.originalFile] : []),
      ...probe.patches.map((p) => p.path),
      ...(probe.artifact ? [`dist/${probe.artifact.file}`, "dist/artifact.json"] : []),
    ];
    const originals = new Map(files.map((p) => [p, fs.readFileSync(p, "utf8")]));
    try {
      if (probe.originalFile) {
        const old = run(["git", ["show", `5a5f94a:${probe.originalFile}`]]);
        assert.equal(old.status, 0, "Cannot read original test");
        fs.writeFileSync(probe.originalFile, old.stdout);
      }
      const key = JSON.stringify(probe.command);
      if (!healthyCommands.has(key)) {
        const healthy = run(probe.command);
        fs.writeFileSync(
          `reports/07c-${baseline ? "original-" : ""}${probe.id}-healthy.log`,
          healthy.stdout + healthy.stderr,
        );
        assert.equal(healthy.status, 0, `Healthy regression failed: ${probe.id} (see reports)`);
        assert.match(healthy.stdout, /# pass [1-9]|[1-9]\d* passed|Artifact checksums/);
        healthyCommands.add(key);
      }
      for (const p of probe.patches) {
        const source = fs.readFileSync(p.path, "utf8");
        assert.equal(source.split(p.before).length, 2, `Target drift: ${probe.id}`);
        fs.writeFileSync(p.path, source.replace(p.before, p.after));
      }
      if (probe.patches.some((p) => p.path.endsWith("queries.ts"))) {
        const generated = run([process.execPath, ["tools/generate.mjs"]]);
        assert.equal(generated.status, 0, `Generation failed: ${probe.id}`);
      }
      if (probe.artifact) {
        const { createHash } = await import("node:crypto");
        const file = `dist/${probe.artifact.file}`;
        fs.appendFileSync(file, `\n${probe.artifact.text}\n`);
        const artifact = JSON.parse(fs.readFileSync("dist/artifact.json", "utf8"));
        artifact.files[probe.artifact.file] = createHash("sha256")
          .update(fs.readFileSync(file))
          .digest("hex");
        fs.writeFileSync("dist/artifact.json", JSON.stringify(artifact));
      }
      const result = run(probe.command),
        output = stripVTControlCharacters(result.stdout + result.stderr);
      fs.writeFileSync(`reports/07c-${baseline ? "original-" : ""}${probe.id}.log`, output);
      const status =
        result.status === 0
          ? "survived"
          : result.status === 1 && /ERR_ASSERTION|Error: expect\(/.test(output)
            ? "killed"
            : "invalid";
      results.push({ id: probe.id, status });
      console.log(`${probe.id}: ${status}`);
    } finally {
      for (const [p, source] of originals) fs.writeFileSync(p, source);
    }
  }
} finally {
  fs.closeSync(fd);
  fs.unlinkSync(lock);
  fs.writeFileSync(
    `reports/web-contract-${baseline ? "original" : (group ?? "all")}-mutations.json`,
    `${JSON.stringify(results, null, 2)}\n`,
  );
}
if (results.some((x) => x.status === "invalid" || (!baseline && x.status !== "killed")))
  process.exitCode = 1;
