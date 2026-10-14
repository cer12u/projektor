# GitHub main to Workers Builds

Use native Workers Builds. GitHub Actions runs verification only and holds no Cloudflare credential. After initial production setup, connect the existing Worker under Settings → Builds, select only this repository in the Cloudflare GitHub App, branch main, root `/`, and disable preview branches.

- Build: `CI_COMMIT_SHA=$WORKERS_CI_COMMIT_SHA pnpm verify`
- Deploy: `node tools/github-deploy.mjs`
- Node: `22.22.1`; pnpm: `10.18.0`.

Connecting the GitHub App and selecting/creating a persistent deployment token require owner approval. Never transfer CLI/OAuth credentials into CI. Prefer Editor scoped to the existing Worker, plus D1 Read, Workers KV Storage Read and Workers R2 Storage Read for preflight. Legacy tokens use account-scoped Workers Scripts Edit instead of per-Worker Editor; verify current dashboard requirements before creation. This path needs no storage writes, Access edit or zone edit. Avoid the default token if its privileges exceed approval.

## Initial setup

Preserve all existing databases. Create a separate approved D1, KV and R2; initialize only the new D1 using reviewed `dist/migrations.json` and the platform migration ledger. Builds never provision resources or run migrations. Approve necessary Access path configuration from `operations.md` separately. Provision Worker secrets `INTEGRATIONS_KEY` and `OAUTH_FORM_SECRET` through secure owner input, never build variables. Initial deployment and login/MCP OAuth validation are separate operator actions. Automatic preflight intentionally rejects the old runtime or an uninitialized schema.

Build variables:

- `CF_PRODUCTION_READY=true`, after initial setup approval and verification.
- `CF_PRESERVED_D1_IDS`: comma-separated IDs of all preserved databases.
- `CF_DEPLOY_CONFIG`: JSON with exactly `worker`, `d1Id`, `d1Name`, `kvId`, `r2Name`, `origin` (HTTPS origin with trailing slash), `accessTeamDomain`, `accessAudience`, `rateIds` (three distinct decimal strings).
- `CLOUDFLARE_ACCOUNT_ID`: approved account; Workers Builds supplies its approved token.

Installation values stay outside source. Worker name must match committed Wrangler name. Rate namespaces must not conflict with other applications.

Run `node tools/github-deploy.mjs --check` in the authorized build environment before enabling the trigger. It checks commit, exact migration ledger, Worker secret names, KV/R2 existence, public endpoint responses and Wrangler dry-run. This performs read operations and a local dry-run only. Build verification separately checks artifact checksums. Missing settings, preserved DB IDs or schema differences block before upload.

Main pushes verify then upload only code/assets with explicit existing bindings. No provisioning, migration, deletion, secret upload or Access change occurs. Schema changes block until an operator separately reviews/applies migrations to the approved new database. Inspect build/health results; rollback is an explicit operator action. Builds itself runs verification and does not rely on Actions completion.

Official references: https://developers.cloudflare.com/workers/ci-cd/builds/ and https://developers.cloudflare.com/workers/ci-cd/builds/configuration/ .
