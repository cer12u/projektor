# Projektor — modular rewrite

The core owners Access, Projects, Issues and Wiki are implemented. Step 06a adds
one Worker that composes them with Platform adapters and exposes workspace-scoped
REST and MCP Streamable HTTP operations through Gateway. OAuth HTTP endpoints,
consent UI and OAuth client end-to-end tests are step 06b. The Web app remains a
placeholder. The Worker reports `deployable: false`; Cloudflare smoke and deploy
jobs are disabled until resources and configuration are approved.

The upstream Projektor was created by **Thomas Dickson**. This fork retains the
[MIT license and copyright](LICENSE), authorship and Git history. The previous
implementation is available at `d39852cef35217bc1dbf4c42d646bda1f09994d3`.
Removing source does not migrate or delete deployed data.

```text
apps/worker/                 Worker composition entry
apps/web/                    static placeholder
modules/{access,projects,issues,wiki}/  core business owners
modules/_fixture_{a,b}/       test-only owners
platform/                    scoped adapters and migration ledger
gateway/                     REST/MCP dispatch and wire descriptions
architecture/modules.json    owner DAG and resources
tools/                       checks, tests, build and packaging
```

Use Node **22.22.1**, pnpm **10.18.0** and Python 3. Development and tests need
no Cloudflare account or production secrets.

```sh
pnpm install --frozen-lockfile
pnpm verify
# After editing named queries, migrations or resource ownership:
pnpm generate
```

`pnpm verify` runs lint, strict TypeScript, ownership and SQL checks, negative
checker fixtures, isolated module tests, Gateway integration tests, build and
artifact verification. `pnpm test:modules --coverage` emits JUnit and LCOV to
`reports/`. The build produces the Worker, placeholder assets, license,
production migrations and a commit/checksum manifest. Fixture schemas and
factories are excluded. Local Miniflare checks do not establish deployed D1
behavior.

See [Gateway routes and evidence](docs/architecture/gateway.md),
[Access contracts](docs/architecture/access.md),
[Projects](docs/architecture/projects.md),
[Issues](docs/architecture/issues.md),
[Wiki](docs/architecture/wiki.md),
[approved plan](docs/architecture/rewrite-plan.md) and [AGENTS.md](AGENTS.md).
