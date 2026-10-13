---
title: "Contributor conventions"
description: "Architecture contract and conventions for working on the Projektor codebase."
sidebar:
  order: 1
---
> **Note:** this page is generated from [`AGENTS.md`](https://github.com/cer12u/projektor/blob/main/AGENTS.md)
> in the repo root by `scripts/gen-conventions-page.ts`. Edit that file, not this page — it is
> overwritten on every generate.

## Active implementation

`apps/system` is the canonical Worker, Web and Agent application. Read its `AGENTS.md` and `docs/architecture-spec.md` before changing it. That adopted design is authoritative for the new implementation: Identity, Work and Execution own business rules and typed use cases; concrete storage/provider/HTTP code belongs in adapters. Tags, file moves and wrappers alone do not establish those boundaries.

Root `start`, `dev`, `build`, `type-check`, `lint`, `test`, `verify`, and `release:build` select this app. Use Node **24.19.0**, npm **11.9.0**, and the committed `apps/system/package-lock.json`. Install with `npm run setup`. The app deliberately has an isolated npm lock and is excluded from the retained pnpm workspace graph.

## Retained reference source

`apps/api`, `apps/web`, `packages/*`, `plugins/*` and `experiments/*` remain for history and independent legacy checks. They are not a fallback, second writer, or dependency of the active runtime. `AGENTS.legacy.md` and `README.legacy.md` preserve their prior instructions. Legacy business/SQL co-location rules do not override the active specification. Do not claim retained features are implemented in the new app.

## Verification and safety

- Add focused tests for concrete defects and preserve honest evidence provenance.
- Run `npm run verify` for the active app; use explicit `legacy:*` scripts for retained checks.
- Keep public configuration generic. Never commit account/database IDs, credentials, cookies, provider assertions, runtime databases, private release pins, or operational evidence.
- Generated bundles, WASM outputs and dependency installations are built from the pinned lock; do not commit them.
- A source push or PR is not permission to merge, tag, deploy, migrate a live database, change authentication, or create credentials.
- Preserve LICENSE, attribution, unrelated source and existing history.
