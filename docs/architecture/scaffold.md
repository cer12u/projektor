# Step 01 implementation

This implements the foundation specified by rewrite-plan §3, §5.2, §6, §7 and
§8/01. Access/Projects/Issues/Wiki are intentionally absent. The two `fixture_*`
owners are synthetic schemas and are excluded from the Worker and production
migration artifact. No existing Cloudflare resource is accessed.

## Catalog and capability flow

The owner registry declares roots, public entries, composition-only factories,
allowed dependencies/packages, tables/schema objects and KV/R2 prefixes. The
TypeScript compiler resolves aliases, package exports, type imports and barrels.
Both declared owner edges and actual source edges are checked for cycles.
Tooling is privileged but cannot be imported by any runtime owner. The sole
explicit generated import exception is the test composition bundle in `.tmp/`.

`pnpm generate` parses literal query catalogs with the TypeScript AST, validates
SQL using Python's SQLite authorizer, splits migrations with SQLite's statement
parser, then emits `platform/generated/catalogs.ts`. The generated hash covers
queries, migration checksums and resource declarations. Every full boundary
check and build recomputes it; generated catalogs are never accepted by filename
alone. No adapter accepts caller-supplied SQL. `createModuleStore(db, owner)` is
composition-only; its returned methods take only names from that fixed catalog
and bound values. The store also carries a frozen owner type/tag; factories reject
a store wired to the wrong owner, even when query names happen to match. All batch statements are prepared and checked before submission.
KV/R2 adapters similarly close over manifest prefixes and return only portable
values, not binding objects.

The module public-type pass traverses compiler types, nested generics, inferred
returns, signatures, aliases and their declaration references. It rejects raw
bindings/storage types, named SQL types, generic storage methods and callbacks.
Private implementation bodies may use their own store. Standard value containers
are allowed; Gateway alone exposes the Request/Response transport boundary.
This is conservative static enforcement, not proof that arbitrary strings are
never SQL or protection from an adversary who can change the checker itself.

## SQL and migrations

SQLite compiles every catalog query using EXPLAIN with an authorizer. Read/write,
JOIN, subquery and CTE accesses are checked against exact resources. DDL is allowed
only in migrations; multi-statement catalog queries, ATTACH, PRAGMA, transaction
control and unapproved virtual modules fail closed. Source `.sql` files outside
the registered migration directory are also rejected.

Each owner is built into a separate in-memory SQLite database. Schema objects
must exactly match the manifest, use their owner's prefix, and have only same-owner
FKs. Explicit indexes/triggers/views and tables are registered; SQLite automatic
indexes inherit their table's owner. Tenant tables need non-null workspace IDs
and tenant-local unique keys. Trigger bodies are compiled on INSERT, every-column
UPDATE and DELETE; views are compiled on SELECT, so empty fixtures and false
trigger predicates cannot hide foreign access. Checks are repeated against the
combined schema to detect foreign reads even when those tables actually exist.

FTS was added in Step 04 for Issues and Step 05 for Wiki. Each virtual table and
its five FTS5 shadow tables are registered to its owner; the checker treats
shadow schemas as SQLite internals while enforcing their exact ownership. See
[Issues](issues.md) and [Wiki](wiki.md).

`platform_schema_versions(owner, version, checksum)` is inaccessible through a
runtime store. The operator-only migration entry accepts owner IDs, not arbitrary
SQL. It bootstraps the ledger, checks recorded versions/checksums, and commits each
owner migration with its receipt in a D1 batch. Migration jobs must be serialized.
A failed migration rolls back its schema changes and receipt; earlier committed
migrations remain applied. Never edit an already-applied migration.

The synthetic repositories use an owner guard table with `CHECK(changed = 1)`.
A versioned UPDATE is immediately followed by `INSERT ... changes()` in the same
batch, then the receipt and guard removal. Zero changed rows abort the whole batch.
This proves a primitive; operation fingerprinting, retry/recovery policy and
admission-time authorization still belong to later business modules.

## Evidence and deliberate scope

- Python SQLite supplies parsing/authorizer/schema checks. Miniflare supplies
  workerd-backed D1/KV/R2 for execution tests; Node's built-in test runner avoids a
  second testing framework. The runtime is pinned to Miniflare 4.20260730.0 and
  compatibility date 2026-07-30. It is not real-account D1 smoke.
- Module tests prove isolated schemas, two-tenant read/write separation, batch
  rollback, stale CAS without a receipt, concurrent CAS winner, 100 successful
  binds/101 rejected binds, catalog/owner rejection, KV/R2 prefix rejection and
  migration idempotency/drift/rollback. JUnit and bundled-code LCOV are retained.
- Checker tests include a healthy baseline and a healthy own-index/FK/trigger/view/
  CTE fixture. Each negative case requires the intended checker category to fail;
  a stale generated hash is not accepted as a substitute failure.
- CI has mandatory boundaries/static/modules/build/integration jobs for branch
  and MR pipelines. The public Node image and digest, pnpm and dependency versions
  are fixed. Install caches use lockfile plus job name; tests need no secrets,
  private image, Docker socket, SSH or production DB.
- Integration runs the checksum-verified artifact in workerd with Static Assets:
  health, unknown business route and the placeholder page. REST/MCP business parity,
  recovery scenarios and browser tests are deferred to their respective module MRs;
  no no-op test command pretends those tests passed. No Playwright is installed.
- Cloudflare smoke and deploy jobs use `when: never`; their commands explicitly
  fail if invoked. Production readiness requires approved resources and real smoke.
  The build artifact is marked non-deployable and includes commit/file/catalog
  hashes. The old GitHub release/docs/deploy automation and bootstrap were deleted.
- This MR is stacked on `rewrite/00-architecture` by explicit owner instruction;
  the usual merged-main branch rule resumes after the architecture MR merges.

## Negative fixture catalog

The executable definitions are in `tools/boundaries.test.mjs`. Runtime prefix and
executor rejection cases live in `tools/runtime.test.mjs`.

| Checker | Injected violations and reason for failure |
|---|---|
| Import / DAG | Private relative import, TS alias private import, package export private import, undeclared public dependency, type-only owner cycle, literal dynamic private import, nonliteral import, require alias, unowned source: forbidden entry/edge, unresolved owner or cycle |
| Public type | Barrel ModuleStore/SQL catalog exports, inferred nested store, SQL alias, D1 binding, Env, generic execute method, callback transaction: forbidden transitive signature |
| SQL ownership | Cross-owner SELECT/UPDATE/JOIN/subquery/CTE, trigger read/write, view read: authorizer denies the foreign table; query DDL, ATTACH, PRAGMA, unapproved virtual module: prohibited operation |
| Static SQL | Concatenated/interpolated catalog, multiple statements, Gateway SQL, SQL file outside migrations: invalid static catalog/location |
| Capability | Raw binding alias, any, double cast, eval alias/indexed eval, overlapping KV/R2 prefixes, generated manifest/hash drift: raw capability/evaluation/prefix or stale build input |
| Schema | Cross-owner FK, owner spoofing, missing tenant column, global unique key: resource/FK/tenant invariant; unregistered index: DDL authorizer rejects undeclared object |
| Executor / prefix (runtime) | Foreign query ID, raw SQL as ID, platform/prototype owner, cross-wired/mutated owner, 101 binds, foreign/empty KV and R2 keys on get/put/delete: reject before operation; 100 binds and own-prefix operations pass |

## Step 04a migration validator correction

FTS5 DROP can reconnect its virtual table after schema changes and internally
read `data_version`. The same narrowly scoped introspection permission used for
FTS creation now also applies to an exact DROP of a registered owner virtual
table. Explicit PRAGMA and other-owner/runtime DROP remain rejected. Validator
connections use autocommit to prevent Python sqlite3 from injecting BEGIN while
validating a data-rebuild migration; explicit transaction statements remain
forbidden. The healthy Issues upgrade exercises DROP/rebuild, and negative
fixtures cover explicit data_version/BEGIN and foreign/runtime FTS DROP.
