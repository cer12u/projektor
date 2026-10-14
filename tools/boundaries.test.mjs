import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

// Each case starts from the healthy source tree and changes exactly one rule.
// The expected rule must fail: a stale generated catalog is not a valid substitute.
const a = "modules/_fixture_a";
const b = "modules/_fixture_b";
const write = (root, file, text) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};
const append = (root, file, text) => fs.appendFileSync(path.join(root, file), text);
const manifest = (root, mutate) => {
  const file = path.join(root, "architecture/modules.json");
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  mutate(value.owners);
  fs.writeFileSync(file, JSON.stringify(value));
};
const query = (root, sql) =>
  write(
    root,
    `${a}/storage/queries.ts`,
    `export const queries = { bad: ${JSON.stringify(sql)} } as const;`,
  );
const ddl = (root, sql, object) => {
  append(root, `${a}/storage/migrations/0001.sql`, sql);
  if (object)
    manifest(root, (owners) =>
      owners.find((o) => o.id === "fixture_a").storage.objects.push(object),
    );
};
const cases = [
  [
    "union hides storage",
    "public-type",
    (r) => append(r, `${a}/public.ts`, 'export type Hidden = "none" | { nested: D1Database };'),
  ],
  [
    "union hides SQL literal",
    "public-type",
    (r) =>
      append(r, `${a}/public.ts`, 'export type Hidden = "safe" | "SELECT * FROM fixture_a_items";'),
  ],
  [
    "union hides callback",
    "public-type",
    (r) =>
      append(
        r,
        `${a}/public.ts`,
        'export type Hidden = { kind: "safe" } | { kind: "bad"; commit(fn: () => void): void };',
      ),
  ],
  [
    "barrel leaks SQL catalog",
    "public-type",
    (r) => append(r, `${a}/public.ts`, 'export { queries } from "./storage/queries";'),
  ],
  [
    "package export private import",
    "import",
    (r) => {
      const f = path.join(r, "package.json");
      const p = JSON.parse(fs.readFileSync(f, "utf8"));
      p.exports = { "./private": "./modules/_fixture_b/internal/factory.ts" };
      fs.writeFileSync(f, JSON.stringify(p));
      write(r, `${a}/internal/bad.ts`, 'export { createFixture } from "projektor/private";');
    },
  ],
  [
    "SQL file outside migrations",
    "sql-static",
    (r) => write(r, `${a}/internal/rogue.sql`, "SELECT * FROM fixture_b_items;"),
  ],
  [
    "indexed eval access",
    "capability",
    (r) => write(r, `${a}/internal/bad.ts`, 'globalThis["eval"]("1");'),
  ],
  [
    "private import",
    "import",
    (r) =>
      write(
        r,
        `${a}/internal/bad.ts`,
        `import { createFixture } from "../../_fixture_b/internal/factory"; export { createFixture };`,
      ),
  ],
  [
    "alias private import",
    "import",
    (r) =>
      write(
        r,
        `${a}/internal/bad.ts`,
        `import type { queries } from "@modules/_fixture_b/storage/queries"; export type Q = typeof queries;`,
      ),
  ],
  [
    "undeclared public dependency",
    "import",
    (r) =>
      append(
        r,
        `${a}/public.ts`,
        `export type { FixtureSnapshot as Other } from "../_fixture_b/public";`,
      ),
  ],
  [
    "type-only owner cycle",
    "import",
    (r) => {
      manifest(r, (owners) => {
        owners.find((o) => o.id === "fixture_a").dependencies.push("fixture_b");
        owners.find((o) => o.id === "fixture_b").dependencies.push("fixture_a");
      });
      append(
        r,
        `${a}/public.ts`,
        `export type { FixtureSnapshot as Other } from "../_fixture_b/public";`,
      );
      append(
        r,
        `${b}/public.ts`,
        `export type { FixtureSnapshot as Other } from "../_fixture_a/public";`,
      );
    },
  ],
  [
    "literal dynamic private import",
    "import",
    (r) =>
      write(
        r,
        `${a}/internal/bad.ts`,
        `export const load = () => import("../../_fixture_b/internal/factory");`,
      ),
  ],
  [
    "nonliteral dynamic import",
    "import",
    (r) => write(r, `${a}/internal/bad.ts`, `export const load = (path: string) => import(path);`),
  ],
  [
    "require alias resolution",
    "import",
    (r) =>
      write(
        r,
        `${a}/internal/bad.ts`,
        `const other = require("@modules/_fixture_b/internal/factory");`,
      ),
  ],
  ["unowned source", "import", (r) => write(r, "stray.ts", "export const stray = 1;")],
  [
    "barrel leaks ModuleStore",
    "public-type",
    (r) =>
      append(
        r,
        `${a}/public.ts`,
        `export type { ModuleStore as Innocent } from "../../platform/public";`,
      ),
  ],
  [
    "nested inferred capability leak",
    "public-type",
    (r) => {
      write(
        r,
        `${a}/internal/leak.ts`,
        `import type { ModuleStore } from "../../../platform/public"; type Wrapped = { nested: ReadonlyArray<ModuleStore<"fixture_a", string>> }; export function leak(value: Wrapped) { return value; }`,
      );
      append(r, `${a}/public.ts`, `export { leak } from "./internal/leak";`);
    },
  ],
  [
    "public SQL alias",
    "public-type",
    (r) => append(r, `${a}/public.ts`, `type SQL = string; export type Fragment = { value: SQL };`),
  ],
  [
    "public raw binding",
    "public-type",
    (r) => append(r, `${a}/public.ts`, `export interface Hidden { value: D1Database }`),
  ],
  [
    "public Env",
    "public-type",
    (r) =>
      append(
        r,
        `${a}/public.ts`,
        `interface Env { DB: D1Database } export type Hidden = { value: Env };`,
      ),
  ],
  [
    "public generic executor",
    "public-type",
    (r) =>
      append(
        r,
        `${a}/public.ts`,
        `export interface Hidden { execute(sql: string): Promise<void> }`,
      ),
  ],
  [
    "public callback transaction",
    "public-type",
    (r) => append(r, `${a}/public.ts`, `export interface Hidden { commit(fn: () => void): void }`),
  ],
  ["direct SQL read", "sql-ownership", (r) => query(r, "SELECT * FROM fixture_b_items")],
  [
    "direct SQL write",
    "sql-ownership",
    (r) => query(r, "UPDATE fixture_b_items SET value = ? WHERE workspace_id = ?"),
  ],
  [
    "JOIN",
    "sql-ownership",
    (r) => query(r, "SELECT a.id FROM fixture_a_items a JOIN fixture_b_items b ON a.id=b.id"),
  ],
  [
    "subquery",
    "sql-ownership",
    (r) => query(r, "SELECT * FROM fixture_a_items WHERE id IN (SELECT id FROM fixture_b_items)"),
  ],
  [
    "CTE",
    "sql-ownership",
    (r) => query(r, "WITH hidden AS (SELECT id FROM fixture_b_items) SELECT * FROM hidden"),
  ],
  [
    "trigger read",
    "sql-ownership",
    (r) =>
      ddl(
        r,
        "CREATE TRIGGER fixture_a_bad AFTER INSERT ON fixture_a_items BEGIN SELECT id FROM fixture_b_items; END;",
        "fixture_a_bad",
      ),
  ],
  [
    "trigger write",
    "sql-ownership",
    (r) =>
      ddl(
        r,
        "CREATE TRIGGER fixture_a_bad AFTER UPDATE ON fixture_a_items BEGIN DELETE FROM fixture_b_items; END;",
        "fixture_a_bad",
      ),
  ],
  [
    "view read",
    "sql-ownership",
    (r) => ddl(r, "CREATE VIEW fixture_a_bad AS SELECT * FROM fixture_b_items;", "fixture_a_bad"),
  ],
  [
    "cross-owner FK",
    "schema",
    (r) => {
      const file = path.join(r, `${a}/storage/migrations/0001.sql`);
      fs.writeFileSync(
        file,
        fs
          .readFileSync(file, "utf8")
          .replace(
            "value TEXT NOT NULL,",
            "value TEXT NOT NULL, FOREIGN KEY (workspace_id, id) REFERENCES fixture_b_items(workspace_id, id),",
          ),
      );
    },
  ],
  [
    "dynamic SQL",
    "sql-static",
    (r) =>
      write(
        r,
        `${a}/storage/queries.ts`,
        'export const queries = { bad: "SELECT * FROM " + "fixture_b_items" } as const;',
      ),
  ],
  [
    "interpolated SQL",
    "sql-static",
    (r) =>
      write(
        r,
        `${a}/storage/queries.ts`,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: inject interpolation into the fixture source
        "export const queries = { bad: `SELECT * FROM ${table}` } as const;",
      ),
  ],
  ["multi statement SQL", "sql-static", (r) => query(r, "SELECT 1; SELECT 2")],
  ["DDL in query", "sql-ownership", (r) => query(r, "DROP TABLE fixture_a_items")],
  ["ATTACH", "sql-ownership", (r) => query(r, "ATTACH DATABASE ':memory:' AS foreign_db")],
  ["explicit migration transaction", "sql-ownership", (r) => ddl(r, "BEGIN;")],
  ["explicit data_version in migration", "sql-ownership", (r) => ddl(r, "PRAGMA data_version;")],
  ["foreign FTS drop", "sql-ownership", (r) => ddl(r, "DROP TABLE issues_search;")],
  ["runtime FTS drop", "sql-ownership", (r) => query(r, "DROP TABLE issues_search")],
  ["PRAGMA", "sql-ownership", (r) => query(r, "PRAGMA foreign_keys = OFF")],
  [
    "virtual module",
    "sql-ownership",
    (r) => ddl(r, "CREATE VIRTUAL TABLE fixture_a_bad USING fts4(value);", "fixture_a_bad"),
  ],
  ["foreign FTS virtual read", "sql-ownership", (r) => query(r, "SELECT * FROM issues_search")],
  [
    "foreign FTS shadow read",
    "sql-ownership",
    (r) => query(r, "SELECT * FROM issues_search_content"),
  ],
  [
    "unregistered FTS shadow",
    "schema",
    (r) =>
      manifest(r, (owners) => {
        const tables = owners.find((o) => o.id === "issues").storage.tables;
        tables.splice(tables.indexOf("issues_search_idx"), 1);
      }),
  ],
  [
    "Gateway SQL",
    "sql-static",
    (r) => append(r, "gateway/public.ts", 'const query = "SELECT * FROM fixture_a_items";'),
  ],
  [
    "raw binding alias",
    "capability",
    (r) =>
      write(
        r,
        `${a}/internal/bad.ts`,
        "type Innocent = D1Database; export function use(db: Innocent) { return db.prepare('SELECT 1'); }",
      ),
  ],
  [
    "raw R2 binding outside Platform adapter",
    "capability",
    (r) =>
      write(
        r,
        `${a}/internal/bad.ts`,
        "type Bucket = R2Bucket; export function use(bucket: Bucket) { return bucket.get('fixture_a/key'); }",
      ),
  ],
  [
    "Assets cannot read Issues storage",
    "sql-ownership",
    (r) =>
      write(
        r,
        "modules/assets/storage/queries.ts",
        'export const queries = {bad: "SELECT * FROM issues_issues"} as const;',
      ),
  ],
  [
    "other owner cannot read Assets storage",
    "sql-ownership",
    (r) => query(r, "SELECT * FROM assets_blobs"),
  ],
  [
    "any storage escape",
    "capability",
    (r) => write(r, `${a}/internal/bad.ts`, "export function use(db: any) { return db; }"),
  ],
  [
    "double cast escape",
    "capability",
    (r) => write(r, `${a}/internal/bad.ts`, "export const forged = {} as unknown as D1Database;"),
  ],
  [
    "runtime evaluation",
    "capability",
    (r) => write(r, `${a}/internal/bad.ts`, 'const run = eval; run("1");'),
  ],
  [
    "KV prefix overlap",
    "capability",
    (r) =>
      manifest(r, (owners) => {
        owners.find((o) => o.id === "fixture_b").storage.kvPrefix = "fixture_a:";
      }),
  ],
  [
    "R2 prefix overlap",
    "capability",
    (r) =>
      manifest(r, (owners) => {
        owners.find((o) => o.id === "fixture_b").storage.r2Prefix = "fixture_a/";
      }),
  ],
  [
    "owner spoofing",
    "schema",
    (r) =>
      manifest(r, (owners) =>
        owners.find((o) => o.id === "fixture_a").storage.tables.push("fixture_b_items"),
      ),
  ],
  [
    "unregistered schema object",
    "sql-ownership",
    (r) => ddl(r, "CREATE INDEX fixture_a_unlisted ON fixture_a_items(value);"),
  ],
  [
    "tenant column missing",
    "schema",
    (r) => {
      const f = path.join(r, `${a}/storage/migrations/0001.sql`);
      fs.writeFileSync(
        f,
        fs.readFileSync(f, "utf8").replaceAll("workspace_id TEXT NOT NULL", "workspace_id TEXT"),
      );
    },
  ],
  [
    "global unique key on tenant data",
    "schema",
    (r) =>
      ddl(r, "CREATE UNIQUE INDEX fixture_a_global ON fixture_a_items(id);", "fixture_a_global"),
  ],
  [
    "manifest/build hash drift",
    "capability",
    (r) => append(r, "platform/generated/catalogs.ts", "// tampered\n"),
  ],
];

function fixture() {
  fs.mkdirSync(".tmp", { recursive: true });
  const root = fs.mkdtempSync(path.resolve(".tmp/boundary-"));
  for (const file of [
    "apps",
    "modules",
    "platform",
    "gateway",
    "architecture",
    "tools",
    "tsconfig.json",
    "package.json",
  ])
    fs.cpSync(file, path.join(root, file), { recursive: true });
  return root;
}
function run(root, freshness) {
  const script = `import { check } from ${JSON.stringify(new URL("./check-boundaries.mjs", import.meta.url).href)}; const errors = check(process.argv[1], undefined, { freshness: ${freshness} }); console.log(JSON.stringify(errors)); process.exitCode = errors.length ? 1 : 0;`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, root], {
    encoding: "utf8",
    timeout: 30000,
  });
  assert(!result.error, String(result.error));
  assert([0, 1].includes(result.status), result.stderr);
  return { status: result.status, errors: JSON.parse(result.stdout) };
}

test("healthy source fixture passes all checkers", () => {
  const root = fixture();
  try {
    assert.deepEqual(run(root, true), { status: 0, errors: [] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
for (const [name, rule, mutate] of cases)
  test(`${name} must fail ${rule}`, () => {
    const root = fixture();
    try {
      mutate(root);
      const result = run(root, name === "manifest/build hash drift");
      assert.equal(result.status, 1, name);
      assert(
        result.errors.some((error) => error.rule === rule),
        `${name}: ${JSON.stringify(result.errors)}`,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

test("healthy own index, FK, trigger, view and CTE pass SQLite ownership", () => {
  const root = fixture();
  try {
    ddl(
      root,
      "CREATE INDEX fixture_a_value ON fixture_a_items(workspace_id, value);",
      "fixture_a_value",
    );
    ddl(
      root,
      "CREATE VIEW fixture_a_view AS SELECT workspace_id, id FROM fixture_a_items;",
      "fixture_a_view",
    );
    ddl(
      root,
      "CREATE TRIGGER fixture_a_trigger AFTER UPDATE ON fixture_a_items BEGIN SELECT id FROM fixture_a_items; END;",
      "fixture_a_trigger",
    );
    append(
      root,
      `${a}/storage/migrations/0001.sql`,
      "CREATE TABLE fixture_a_child (workspace_id TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(workspace_id,id), FOREIGN KEY(workspace_id,id) REFERENCES fixture_a_items(workspace_id,id));",
    );
    manifest(root, (owners) =>
      owners.find((o) => o.id === "fixture_a").storage.tables.push("fixture_a_child"),
    );
    query(
      root,
      "WITH local AS (SELECT * FROM fixture_a_view) SELECT * FROM local JOIN fixture_a_child USING(workspace_id,id)",
    );
    assert.deepEqual(run(root, false), { status: 0, errors: [] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
