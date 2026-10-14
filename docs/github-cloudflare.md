# GitHub main to Cloudflare

GitHub Actions runs verification and, once initial setup is approved, deploys the same checksum-verified artifact on main pushes. Deployment is serialized and is disabled while repository variable `CF_PRODUCTION_READY` is absent or not `true`. Pull requests and manual verification runs never deploy. The workflow has `contents: read` and uses the `production` GitHub environment.

Actions is preferred here because no existing Workers Builds trigger is present and the official Cloudflare GitHub App requests administration, contents, checks, deployments and pull requests write permissions. Actions requires only an approved Cloudflare deployment token saved in the production environment secret. No GitHub App grant is needed. Workers Builds remains an alternative if its App is already authorized or its broader repository access is explicitly approved.

## Persistent access approval

Approve a deployment token preferably with Editor scoped to the existing Worker, plus D1 Read, Workers KV Storage Read and Workers R2 Storage Read for preflight. Legacy tokens use account-scoped Workers Scripts Edit instead of per-Worker Editor. No storage write, Access edit or zone edit is needed by this code-only path. Confirm current dashboard permission requirements before creation. The token allows persistent deployment and preflight reads, and is saved through secure owner input as `CLOUDFLARE_API_TOKEN` in the GitHub `production` environment. Never transfer an interactive CLI/OAuth token into CI.

## Initial setup

Preserve every existing database. Create a separate approved D1, KV and R2; initialize only the new D1 using reviewed `dist/migrations.json` and the platform migration ledger. Builds never provision resources or migrate. Approve necessary Access path configuration from `operations.md` separately. Provision Worker secrets `INTEGRATIONS_KEY` and `OAUTH_FORM_SECRET` through secure owner input, never GitHub/build variables. Initial deployment and login/MCP OAuth validation are separate operator actions. Automatic preflight intentionally rejects the old runtime or an uninitialized schema.

Set production environment variables:

- `CF_PRESERVED_D1_IDS`: comma-separated IDs of all preserved databases.
- `CF_DEPLOY_CONFIG`: JSON with exactly `worker`, `d1Id`, `d1Name`, `kvId`, `r2Name`, `origin` (HTTPS origin with trailing slash), `accessTeamDomain`, `accessAudience`, `rateIds` (three distinct decimal strings).
- `CLOUDFLARE_ACCOUNT_ID`: approved account.

After initial approval and validation, set repository variable `CF_PRODUCTION_READY=true`. Installation values stay outside source. Worker name must match committed Wrangler name. Rate namespaces must not conflict with other applications.

Run `node tools/github-deploy.mjs --check` in the authorized deployment environment before enabling main deployments. It checks commit/checksums, exact migration ledger, Worker secret names, KV/R2 existence, public endpoint responses and Wrangler dry-run. This performs read operations and a local dry-run only. Missing settings, preserved DB IDs or schema differences block before upload.

Main pushes verify then upload only code/assets with explicit existing bindings. No provisioning, migration, deletion, secret upload or Access change occurs. Schema changes block until an operator separately reviews/applies migrations to the approved new database. Inspect build/health results; rollback is an explicit operator action. Initial deploy token/secret provisioning and the first production cutover are not performed by this PR.

## Workers Builds alternative

If explicitly selected: main only, root `/`, no preview branches, Node `22.22.1`, pnpm `10.18.0`; build command `CI_COMMIT_SHA=$WORKERS_CI_COMMIT_SHA pnpm verify`; deploy command `node tools/github-deploy.mjs`. Supply the same installation variables and approved deployment token to Builds. Do not enable both pipelines.

Official references: https://developers.cloudflare.com/workers/ci-cd/builds/ ; https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/ ; https://github.com/apps/cloudflare-workers-and-pages .
