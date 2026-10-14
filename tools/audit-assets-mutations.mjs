import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { stripVTControlCharacters } from "node:util";

// Run alone: node tools/audit-assets-mutations.mjs [case-id ...] [--original].
// Only assertion failures count. SQL is regenerated; all files restore in finally.
const factory = "modules/assets/internal/factory.ts";
const adapter = "platform/adapters.ts";
const gateway = "gateway/public.ts";
const cases = [];
const patch = (path, before, after) => ({ path, before, after });
function method(name, before, after) {
  const source = fs.readFileSync(factory, "utf8");
  const start = source.indexOf(`    async ${name}(`);
  const end = source.indexOf("\n    async ", start + 1);
  const block = source.slice(start, end < 0 ? source.length : end);
  assert(start >= 0 && block.includes(before), `Method drift: ${name}`);
  return patch(factory, block, block.replace(before, after));
}
function add(id, patches, pattern, file = "assets", originalPattern = undefined) {
  cases.push({ id, patches, pattern, file, originalPattern });
}
for (const name of ["get", "open", "put", "delete"]) {
  const args = name === "put" ? "key: string, value: ArrayBuffer" : "key: string";
  add(
    `r2-${name}-prefix`,
    [patch(adapter, `async ${name}(${args}) {\n      check(key);`, `async ${name}(${args}) {`)],
    "09a R2",
  );
}
add(
  "r2-prefix",
  [patch(adapter, "    checkKey(prefix, key);\n    if (workspaceId", "    if (workspaceId")],
  "09a R2",
);
for (const [id, chars] of [
  ["dot", "."],
  ["slash", "\\/"],
])
  add(
    `r2-${id}`,
    [
      patch(
        adapter,
        "!/^[A-Za-z0-9_-]{1,128}$/.test(key.slice(prefix?.length ?? 0))",
        `!/^[A-Za-z0-9_${chars}-]{1,128}$/.test(key.slice(prefix?.length ?? 0))`,
      ),
    ],
    "09a R2",
  );
add(
  "complete-size",
  [method("completeUpload", '        object.byteLength !== number(r, "size") ||\n', "")],
  "09a complete independently rejects size",
);
add(
  "complete-hash",
  [method("completeUpload", '(await hash(object)) !== string(r, "sha256")', "false")],
  "09a complete independently rejects sha256",
);
add(
  "complete-missing",
  [
    method(
      "completeUpload",
      '!object ||\n        object.byteLength !== number(r, "size") ||\n        (await hash(object)) !== string(r, "sha256")',
      'object && (object.byteLength !== number(r, "size") ||\n        (await hash(object)) !== string(r, "sha256"))',
    ),
  ],
  "09a complete independently rejects missing",
);
const noAdmission = () =>
  method(
    "downloadAsset",
    "const r = await blob(scope, assetId);",
    'const r = (await one("blob", [w(scope), assetId]))!;',
  );
const noTarget = () => patch(factory, "let visible = false;", "let visible = true;");
add(
  "download-unlinked",
  [
    method("downloadAsset", 'if (r.state !== "ready") fail("not_found", "Asset unavailable");', ""),
    noTarget(),
  ],
  "unlink schedules GC",
);
add("download-project", [noAdmission(), noTarget()], "archive or membership revoke");
add("download-membership", [noAdmission(), noTarget()], "09a download after membership revoke");
add("download-other-project", [noAdmission(), noTarget()], "09a download checks");
add(
  "download-stream-permission",
  [noTarget()],
  "09a issued download URL",
  "gateway",
  "Assets binary REST",
);
add(
  "download-attachment",
  [patch(gateway, '"content-disposition": `attachment;', '"content-disposition": `inline;')],
  "09a HTML and SVG",
  "gateway",
  "Assets binary REST",
);
add(
  "download-nosniff",
  [patch(gateway, '          "x-content-type-options": "nosniff",\n', "")],
  "09a HTML and SVG",
  "gateway",
  "Assets binary REST",
);
add(
  "retry-input",
  [patch(factory, 'if (string(r, "fingerprint") !== fp)', "if (false)")],
  "09a .* retry binds",
);
add(
  "retry-duplicate-blob",
  [
    method(
      "beginUpload",
      "if (saved) return saved;",
      `if (saved) {
        await store.run("begin", [w(scope), assetId + "duplicate", projectId, input.size, input.contentType, input.filename, input.sha256, clock.now()]);
        return saved;
      }`,
    ),
  ],
  "09a beginUpload retry binds",
);
for (const name of ["linkAsset", "unlinkAsset"]) {
  add(
    `${name}-cas`,
    [
      method(
        name,
        "values: [w(scope), assetId, expected]",
        'values: [w(scope), assetId, number(r, "version")]',
      ),
    ],
    `09a ${name} stale CAS`,
  );
  add(
    `${name}-guard`,
    [
      method(
        name,
        '...guarded(scope, { name: "bump", values: [w(scope), assetId, expected] }),',
        '{ name: "bump", values: [w(scope), assetId, expected] },',
      ),
    ],
    `09a ${name} stale CAS`,
  );
}
for (const name of ["beginUpload", "unlinkAsset"])
  add(
    `${name}-gc-job`,
    [
      method(
        name,
        name === "beginUpload"
          ? '{ name: "gcAdd", values: [w(scope), assetId, clock.now() + EXPIRY] },'
          : '{ name: "gcAdd", values: [w(scope), assetId, clock.now()] },',
        "",
      ),
    ],
    `09a ${name} cannot change metadata`,
  );
add(
  "gc-still-linked",
  [method("drainGc", 'if (current?.state === "ready")', "if (false)")],
  "09a GC preserves",
);
add(
  "gc-job-early-remove",
  [
    method(
      "drainGc",
      "await bucketFor(ws).delete(key(ws, assetId));",
      'await store.run("gcRemove", [ws, assetId]);\n        await bucketFor(ws).delete(key(ws, assetId));',
    ),
  ],
  "09a GC preserves",
);
add(
  "gc-not-idempotent",
  [
    method(
      "drainGc",
      "await bucketFor(ws).delete(key(ws, assetId));",
      'if (!(await bucketFor(ws).get(key(ws, assetId)))) fail("conflict", "Already deleted");\n        await bucketFor(ws).delete(key(ws, assetId));',
    ),
  ],
  "09a GC preserves",
);
add(
  "gc-pending-leak",
  [
    method(
      "drainGc",
      'await store.run("retire", [ws, assetId, ws, assetId]);',
      'if (r.state === "pending") continue;\n        await store.run("retire", [ws, assetId, ws, assetId]);',
    ),
  ],
  "unfinished upload expires",
);
add(
  "gc-pending-completion-race",
  [
    method(
      "drainGc",
      'await store.run("retire", [ws, assetId, ws, assetId]);',
      'if (r.state === "ready") await store.run("retire", [ws, assetId, ws, assetId]);',
    ),
  ],
  "09a expired pending",
);
add(
  "scheduled-no-gc",
  [patch("apps/worker/index.ts", "await services.assets.drainGc();", "")],
  "09a Worker scheduled GC",
  "gateway",
  "Assets binary REST",
);
for (const [id, op] of [
  ["exclusive", ">= MAX_SIZE"],
  ["extra-byte", "> MAX_SIZE + 1"],
])
  add(
    `size-${id}`,
    [method("beginUpload", "input.size > MAX_SIZE", `input.size ${op}`)],
    "09a begin size boundary",
  );
add(
  "put-size-exclusive",
  [method("putUpload", "body.byteLength > MAX_SIZE", "body.byteLength >= MAX_SIZE")],
  "09a begin size boundary",
);
add(
  "gateway-size-exclusive",
  [patch(gateway, "declared > 10 * 1024 * 1024", "declared >= 10 * 1024 * 1024")],
  "09a binary PUT",
  "gateway",
);
add(
  "gateway-body-size-exclusive",
  [patch(gateway, "body.byteLength > 10 * 1024 * 1024", "body.byteLength >= 10 * 1024 * 1024")],
  "09a binary PUT",
  "gateway",
);
add(
  "mcp-raw-bytes",
  [
    patch(
      "gateway/catalog.ts",
      "await s.assets.getMetadata(c, assetId);",
      "const download = await s.assets.downloadAsset(c, assetId);\n    return { bytes: Array.from(new Uint8Array((await download.body.read())!)) };",
    ),
  ],
  "09a HTML and SVG",
  "gateway",
  "Assets binary REST",
);
// Remove Assets write requirements together: the transport and owner layers are
// redundant defenses, so bypassing only one is not an observable authorization bug.
const writes = ["beginUpload", "completeUpload", "linkAsset", "unlinkAsset"];
const permissionPatches = writes.map((name) =>
  method(name, 'await access.authorize(scope, "write");', 'await access.authorize(scope, "read");'),
);
const catalog = fs.readFileSync("gateway/catalog.ts", "utf8");
const assetStart = catalog.indexOf('  "assets.begin":');
const assetEnd = catalog.indexOf('  "assets.get":', assetStart);
const writeCatalog = catalog.slice(assetStart, assetEnd);
assert(assetStart >= 0 && assetEnd > assetStart);
add(
  "mcp-write-scope",
  [
    patch("gateway/catalog.ts", writeCatalog, writeCatalog.replaceAll("    true,", "    false,")),
    ...permissionPatches,
    patch(
      factory,
      'await projects.authorizeProject(scope, projectId, "write");',
      'await projects.authorizeProject(scope, projectId, "read");',
    ),
  ],
  "09a read-scoped machine",
  "gateway",
  "Assets binary REST",
);
add(
  "oauth-write-scope",
  [
    patch("gateway/catalog.ts", writeCatalog, writeCatalog.replaceAll("    true,", "    false,")),
    ...permissionPatches,
    patch(
      factory,
      'await projects.authorizeProject(scope, projectId, "write");',
      'await projects.authorizeProject(scope, projectId, "read");',
    ),
  ],
  "09a OAuth viewer",
  "gateway-oauth",
);

add(
  "web-retry-new-id",
  [
    patch(
      "apps/web/src/app.tsx",
      "operationId: current.completeId,",
      "operationId: crypto.randomUUID(),",
    ),
  ],
  "09a attachment",
  "browser",
);

const original = process.argv.includes("--original");
const ids = process.argv.slice(2).filter((x) => x !== "--original");
const selected = cases.filter((c) => !ids.length || ids.includes(c.id));
assert(selected.length && ids.every((id) => cases.some((c) => c.id === id)), "Unknown case");
fs.mkdirSync(".tmp", { recursive: true });
fs.mkdirSync("reports", { recursive: true });
const lock = ".tmp/assets-mutation.lock",
  fd = fs.openSync(lock, "wx");
const reportPath = `reports/assets-${original ? "original-" : ""}mutations.json`;
const previous = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : [];
const results = [],
  healthyCommands = new Set();
const run = (bin, args) =>
  spawnSync(bin, args, { encoding: "utf8", timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
try {
  for (const c of selected) {
    const testFile =
      c.file === "browser" ? "tools/web-e2e/core.spec.mjs" : `tools/${c.file}.test.mjs`;
    assert(!original || c.file !== "browser", "Original browser probe is unsupported");
    const files = [
      ...new Set([testFile, "platform/generated/catalogs.ts", ...c.patches.map((p) => p.path)]),
    ];
    const saved = new Map(files.map((p) => [p, fs.readFileSync(p, "utf8")]));
    try {
      if (original) {
        const old = run("git", ["show", `e74f4cb:${testFile}`]);
        assert.equal(old.status, 0);
        fs.writeFileSync(testFile, old.stdout);
      }
      const args = [
        "--test",
        "--test-reporter=tap",
        ...(original && c.file === "assets"
          ? []
          : [
              `--test-name-pattern=${original ? (c.originalPattern ?? "SDK discovery") : c.pattern}`,
            ]),
        testFile,
      ];
      const command =
        c.file === "browser"
          ? [
              "pnpm",
              [
                "exec",
                "playwright",
                "test",
                "-c",
                "tools/playwright.config.mjs",
                "--grep",
                c.pattern,
              ],
            ]
          : [process.execPath, args];
      const commandKey = JSON.stringify(command);
      if (!healthyCommands.has(commandKey)) {
        const healthy = run(...command);
        fs.writeFileSync(`reports/09a-${c.id}-healthy.log`, healthy.stdout + healthy.stderr);
        assert.equal(healthy.status, 0, `Healthy regression failed: ${c.id}; see reports`);
        assert.match(healthy.stdout, /# pass [1-9]|[1-9]\d* passed/);
        healthyCommands.add(commandKey);
      }
      for (const p of c.patches) {
        const text = fs.readFileSync(p.path, "utf8");
        assert.equal(text.split(p.before).length, 2, `Target drift: ${c.id}`);
        fs.writeFileSync(p.path, text.replace(p.before, p.after));
      }
      if (c.patches.some((p) => p.path.endsWith("queries.ts"))) {
        const generation = run(process.execPath, ["tools/generate.mjs"]);
        assert.equal(generation.status, 0, `Generation failed: ${c.id}`);
      }
      const result = run(...command),
        output = stripVTControlCharacters(result.stdout + result.stderr);
      fs.writeFileSync(`reports/09a-${original ? "original-" : ""}${c.id}.log`, output);
      const status =
        result.status === 0
          ? "survived"
          : result.status === 1 &&
              /ERR_ASSERTION|Error: expect\(/.test(output) &&
              /not ok|failed/.test(output)
            ? "killed"
            : "invalid";
      results.push({ id: c.id, status, regression: original ? c.originalPattern : c.pattern });
      console.log(`${c.id}: ${status}`);
    } finally {
      for (const [p, text] of saved) fs.writeFileSync(p, text);
    }
  }
} finally {
  fs.closeSync(fd);
  fs.unlinkSync(lock);
  fs.writeFileSync(
    reportPath,
    `${JSON.stringify([...previous.filter((r) => !selected.some((c) => c.id === r.id)), ...results], null, 2)}\n`,
  );
}
if (results.some((r) => r.status !== "killed")) process.exitCode = 1;
