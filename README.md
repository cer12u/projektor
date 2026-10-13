# Projektor — modular rewrite

This branch implements **step 02b / Access MCP OAuth** of the approved
[modular rewrite](docs/architecture/rewrite-plan.md). Access has a tested module API
for human assertions, machine credentials, workspace membership and MCP OAuth
(discovery, public registration, consent, PKCE, rotating tokens and revocation).
Projects, Issues, Wiki, MCP transport and a product UI are not implemented. Access is
not yet wired to HTTP; this is not a usable project manager. `/health` reports `deployable: false`; other Worker routes
return 404. The static page is a placeholder.

The upstream Projektor was created by **Thomas Dickson**. This Fork retains the
[MIT license and copyright](LICENSE), authorship and Git history. The previous
implementation is available at `d39852cef35217bc1dbf4c42d646bda1f09994d3`.
Removing source does not migrate or delete any deployed data.

```text
apps/worker/                 Worker composition entry
apps/web/                    static placeholder
modules/access/               authentication, membership, credentials and outbox
modules/_fixture_{a,b}/       test-only owners: public, internal, storage
platform/                    clock/IDs/errors, scoped stores, migration ledger
  generated/                 checked static catalogs (pnpm generate)
gateway/                     Hono health/404 mapping
architecture/modules.json    owner DAG, public entries, resources, prefixes
tools/                       TypeScript/SQLite checks, tests, build and packaging
docs/architecture/           approved plan and scaffold implementation notes
.gitlab-ci.yml               secret-free verification; deploy disabled
```

Use Node **22.22.1**, pnpm **10.18.0** and Python 3 (standard-library SQLite with
an authorizer). No browser download, Docker daemon, Cloudflare account or secrets
are required. CI pins a public Node image by tag and digest; its Python/SQLite
version is provided by that immutable image. There is one root package to keep
this foundation small; logical modules are not separately published packages.

```sh
pnpm install --frozen-lockfile
pnpm verify
# After editing named queries, migrations or resource ownership:
pnpm generate
pnpm check:boundaries
```

`pnpm verify` runs lint, strict TypeScript, ownership/public-type/DAG checks,
negative checker fixtures, Miniflare storage tests, isolated migration checks,
build and artifact verification. `pnpm test:modules --coverage` additionally emits
JUnit and LCOV to `reports/` (coverage measures the bundled test composition).
Checks run on branch and MR pipelines using shared, tag-less Docker runners.
No verification job is optional. Cloudflare smoke/deploy jobs are disabled;
their commands fail explicitly if invoked.

The build produces `dist/worker.js`, placeholder assets, the license, production
migration package, and a commit/checksum manifest. Fixture schemas and factories
are excluded. `pnpm check:artifact` checks hashes and runs the built Worker plus
Static Assets in workerd. This is not a real Cloudflare smoke or deployment approval.

See [Access contracts and setup](docs/architecture/access.md), [AGENTS.md](AGENTS.md) for boundaries and how to add a module,
[scaffold details](docs/architecture/scaffold.md) for enforcement and test limits,
and [SECURITY.md](SECURITY.md) for private reporting.

Projects: [contracts](docs/architecture/projects.md).
