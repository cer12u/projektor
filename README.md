# Projektor

This is the [cer12u fork](https://github.com/cer12u/projektor) of [TAJD/projektor](https://github.com/TAJD/projektor), under the existing [MIT license](LICENSE).

## Canonical application

[`apps/system`](apps/system) contains the current modular implementation: one Worker, one D1 schema lineage, a React Web client and an Agent SDK over the same business API. Identity, Work and Execution own typed business contracts and rules. D1, HTTP/MCP and provider adapters are composed at the application boundary.

Start with the [adopted architecture](apps/system/docs/architecture-spec.md), [application guide](apps/system/README.md), [current API](apps/system/docs/openapi.json), and [integration scope](docs/system-integration.md). The implementation and verification limits are stated there; this branch does not claim production deployment, completion of [A1–A12 operational acceptance](apps/system/docs/history/acceptance-baseline.md), or full legacy feature parity.

### Reproduce locally

Use Node **24.19.0** and npm **11.9.0**.

```sh
npm run setup                  # locked install in apps/system
npm run verify                 # types, lint, build, boundaries and focused runtime checks
npm --prefix apps/system run db:migrate
npm run start                  # local Worker + built Web at https://localhost:8787
npm run release:build -- v0.7.7 # local artifact only
```

The local database is separate from any hosted database. Initial application credentials/identity must be established through the documented setup flow or synthetic local fixtures; no automatic business-permission provisioning is enabled. Hosted configuration uses an ignored private copy of the example config.

The application uses an isolated npm lock. The existing pnpm lock remains for retained reference packages; root runtime commands never use Turbo to select an old application.

## Retained source and history

The previous Hono/Astro application, packages, plugins and PR#7 experiments remain intact as reference source. They are outside the canonical runtime graph. Their original documentation is [README.legacy.md](README.legacy.md); its generated MCP counts describe that legacy implementation only. `npm run legacy:gen:docs` regenerates its catalog. New API documentation comes from `npm run gen:docs`.

Features such as attachments, sprints, feedback, old fleet/file-claim coordination, realtime notifications and the full upstream administration suite are not implicitly ported by retaining their source. See the explicit [scope and data limitations](docs/system-integration.md). The new migration chain must never be concatenated with `packages/db/migrations`.

## Release behavior

`npm run release:build -- <version>` packages only `apps/system` Worker/WASM/Web and its migration chain with hashes and a placeholder configuration. It does not upload, migrate, tag or deploy. Existing release workflows now read the application version from `apps/system/package.json`; production release remains a separate reviewed operation. Root `deploy` stops with a review-required message rather than invoking a legacy deployment.
