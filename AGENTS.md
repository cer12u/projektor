# Working on the modular rewrite

Read [the approved plan](docs/architecture/rewrite-plan.md) and
[scaffold implementation notes](docs/architecture/scaffold.md). Step 01 introduced
Platform, boundary tooling and test owners; steps 02/02b add Access assertions, membership and MCP OAuth (see
[Access contracts](docs/architecture/access.md)). Do not restore old business
code, global service contexts, release workflows or production bindings.

## Ownership and public contracts

- `architecture/modules.json` is the owner registry. Every runtime/tool source
  belongs to exactly one root. Declare public entry, dependencies, external
  packages and exclusive storage resources there. The full owner DAG, including
  type-only and event dependencies, must be acyclic.
- A module may import another owner's `public.ts` only along a declared edge.
  `internal/`, `storage/` and tests are private. Factories are composition-only.
  Web will import only `gateway/wire.ts`, never server implementations.
- Public contracts contain commands, queries, DTOs and versioned event contracts.
  No SQL, raw bindings, Env, ModuleStore, ORM schema, arbitrary executor or
  callback transaction crosses that boundary. Private implementations receive
  narrowed capabilities and dependencies' public APIs.
- Raw D1/KV/R2 bindings flow only from Worker composition to Platform adapters.
  The operator/test harness in `tools/` is trusted tooling and is never a runtime
  dependency. No owner may import it. Platform knows no business schema rules.
- SQL is exclusively a static `export const queries = { name: "..." } as const`
  catalog in each owner's `storage/queries.ts`, or a migration in its declared
  `storage/migrations/`. Bind values, never identifiers or SQL fragments.
  Neither SELECT nor write may touch another owner's table. FKs, triggers, views
  and indexes stay with their owner. Dynamic SQL and runtime code evaluation,
  `any` and double casts are forbidden in runtime source.
- `ModuleStore` executes catalog names only. The composition-selected owner and
  catalog cannot be changed by callers. Every statement is limited to 100 binds.
  A batch is one D1 transaction; never chunk it and claim all-or-nothing behavior.
- KV/R2 methods take complete keys and reject keys outside the fixed owner prefix.
  KV is not the source of truth for authorization or durable operation receipts.
- Tenant tables require non-null `workspace_id`; every unique key includes it.
  Explicit global-table exceptions require design justification. Test two tenants:
  static checks do not prove the meaning of authorization or tenant predicates.

## Adding a module

1. Create one branch/MR for one bounded module from merged main. Stacking requires
   an explicit task instruction (step 01 targets `rewrite/00-architecture`).
2. Add `modules/<owner>/public.ts`, private `internal/`, `storage/queries.ts`,
   ordered immutable SQL migrations and module tests. Register only the resources
   and dependencies that the module needs. Register explicit index/trigger/view
   names; automatic SQLite indexes inherit their table's owner.
3. Expose the factory only to composition. Inject its own `ModuleStore` and public
   dependency fakes for isolated tests. Do not import providers' schemas/helpers.
4. Run `pnpm generate`; commit the generated catalog with its inputs. The build
   checks their hash and refuses stale or edited generated output.
5. Test the module using only its own migrations and public dependency contracts.
   Include failures, two tenants and the command's atomicity/retry/CAS contract.
   Product endpoints and UI need their own tests when they are introduced.
6. Run `pnpm verify`, update relevant repository docs, push the branch and inspect
   the exact MR pipeline. Fix failures; do not weaken checkers to green the build.
   Do not merge or deploy without the owner's instruction.

## Checks and CI

`tools/check-boundaries.mjs` resolves TypeScript imports/aliases/re-exports and
walks public compiler types. `tools/sql_check.py` uses SQLite parsing, EXPLAIN and
an authorizer, builds isolated schemas, checks resource and tenant ownership,
and compiles trigger/view/FK paths even without rows. `tools/boundaries.test.mjs`
starts from a healthy tree and injects one violation per case; the expected
checker must fail, not merely an unrelated freshness check.

`pnpm test:modules --coverage` uses Miniflare's actual D1/KV/R2 implementations.
Tests cover whole-batch rollback, stale CAS without receipt, racing updates,
prefix rejection, 100/101 binds and migration bookkeeping/failure. This is local
workerd evidence, not a claim about a deployed D1 instance.

GitLab gates are `boundaries`, `static`, `modules`, `build`, `integration`.
Cloudflare smoke/deploy remain disabled pending approved resources and explicit
implementation. No production credentials belong in source, reports or artifacts.
Preserve user changes, deployed data, LICENSE, authorship and Git history.
