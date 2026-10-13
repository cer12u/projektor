# Projektor system

This is the canonical application selected by the repository root. Read [AGENTS.md](AGENTS.md) and the [architecture specification](docs/architecture-spec.md) first. The implementation contains Identity, Work and Execution modules, concrete D1/provider adapters, HTTP/MCP delivery, Web and Agent clients. Retained upstream applications are not runtime dependencies.

## Reproduce

Use Node 24.19.0 and npm 11.9.0.

```sh
npm ci --include=dev --include=optional
npm run verify:ci
npm run db:migrate
npm run start
```

The build uses official Wrangler dry-run with isolated local tool state and no credential provider. `dist/worker` contains the Worker entry, map and two static WASM modules. `dist/web` is served by the same Worker. MCP is disabled by default. The Agent entry is `src/agent/public.ts`; it requires an explicit credential provider and origin rather than storing credentials itself.

The source has an isolated npm lock and is deliberately excluded from the legacy pnpm workspace. Generated dependencies, bundles, test databases and reports stay under ignored `node_modules`, `dist` and `.local` paths. `build:verified` records actual source equality before/after the build and exhaustive artifact hashes under `.local/verification/release`; those local test manifests are not deployment approval.

## Setup and deployment

Local migration commands apply only the canonical `migrations/` chain to the local database. Initial identities must use the documented setup capability or synthetic test fixture; login does not auto-create business permissions. [Deployment guidance](docs/deployment.md) explains private target/state configuration, explicit release binding and forward-compatible rollback. No production action is part of build or CI.

The [current API](docs/openapi.json) and [integration scope](../../docs/system-integration.md) state the implemented surface. Retained old source does not establish feature parity. Hosted identity-provider behavior, real credential custody and next-day/Android use require separate evidence.
