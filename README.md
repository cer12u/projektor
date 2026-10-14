# Projektor — modular rewrite

Projektor is task management for people and coding agents (Claude Code, Codex and
other MCP clients) working in the same workspaces. It runs as one Cloudflare Worker
with D1, KV and R2.
- Business modules own their data and are reached only through their public
  contracts:
  - Access, Projects, Issues and Wiki;
  - Coordination (sessions, fenced leases, file claims, progress);
  - Assets, Planning, Insights, Integrations and Lifecycle.
- Gateway exposes them as workspace-scoped REST and MCP Streamable HTTP, with
  Cloudflare Access for people and machine bearer or MCP OAuth for agents.
- The Preact Web app is served as static assets.

Installation-specific configuration (registries, account and resource IDs, hostnames
and secrets) is never committed. See [docs/operations.md](docs/operations.md).

The upstream Projektor was created by **Thomas Dickson**. This fork retains the
[MIT license and copyright](LICENSE), authorship and Git history. The previous
implementation is available at `d39852cef35217bc1dbf4c42d646bda1f09994d3`.
Removing source does not migrate or delete deployed data.

```text
apps/worker/                 Worker composition entry
apps/web/                    Preact browser application
modules/<owner>/             business owners (public.ts, internal/, storage/)
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
`reports/`. The build produces the Worker, static Web assets, license,
production migrations and a commit/checksum manifest. Fixture schemas and
factories are excluded. Local Miniflare checks do not establish deployed D1
behavior.

See [Gateway routes and evidence](docs/architecture/gateway.md),
[Access contracts](docs/architecture/access.md),
[Projects](docs/architecture/projects.md),
[Issues](docs/architecture/issues.md),
[Wiki](docs/architecture/wiki.md),
[Web and local browser tests](docs/architecture/web.md),
[approved plan](docs/architecture/rewrite-plan.md) and [AGENTS.md](AGENTS.md).


OAuth HTTP setup (step 06b): configure `OAUTH_ISSUER` as the exact HTTPS origin,
`OAUTH_RESOURCE` as that origin plus `/mcp`, and secret binding `OAUTH_FORM_SECRET`
with at least 32 characters of cryptographic randomness. All three and the two OAuth rate-limit bindings are required
together. Keep the secret outside source/vars. Only the interactive authorization
page belongs behind Cloudflare Access login; discovery, register, token, revoke
and MCP must return their protocol responses. See [Gateway OAuth operations](docs/architecture/gateway.md#step-06b-oauth-http)
for consent, rate limits, tests and remaining deployment acceptance.

Coordination sessions, issue leases and exact-path claims: [Coordination contract](docs/architecture/coordination.md).

Explicit workspace/project purge: [Lifecycle and recovery](docs/architecture/lifecycle.md).
