# Build and deployment boundaries

`npm run build:verified` is an offline/local build. It does not deploy, obtain credentials or migrate a hosted database. The root release builder packages only this app's Worker/WASM, Web and ordered canonical SQL files. Do not mix these with the retained `packages/db/migrations` lineage.

The public `wrangler.production.example.json` is a copy template, not an executable target. Its relative paths are intended for `.local/deployment/wrangler.jsonc`. Replace only the explicit placeholders in an ignored private copy. The parameterized `deploy/` implementation requires a complete private target, approved state and separately bound source/artifact manifests before reaching credential checks or provider requests. Missing configuration fails closed. Provider requests remain restricted to the official Cloudflare API; redirects and alternate auth destinations are rejected.

The migration chain includes additive authentication/setup-context schema changes after the original 17 migrations. Read and verify the exact SQL inventory shipped with each artifact; CI derives it from actual files. Existing hosted application of any later migration is not assumed. Validate the prior schema/ledger and preserve existing rows, identifiers and history before an explicitly authorized upgrade. The local preservation fixture is synthetic and does not prove completeness of a hosted dataset.

A previous Worker version may not understand a new authentication flow. Rollback must preserve the current database and operation history; do not drop context tables, rewrite receipts or concatenate historical migration proposals. Review compatibility and pending operations before selecting earlier code. No automatic migration, schema rollback, authentication change or release promotion is hidden in build/CI.

The deployment code's read-only prerequisite collector and official CLI adapter can be tested with synthetic local fixtures. Such tests do not establish live provider permissions, account readiness, secret custody or a successful hosted rollout. See `deploy/README.md` for the closed configuration and operation contract.
