# GitHub main to Cloudflare

Actions verifies and deploys the same checked artifact on main pushes, serialized in the production environment. Deployment stays disabled until repository variable CF_PRODUCTION_READY is explicitly true. Pull requests and default manual verification never deploy. An explicit deploy_production manual input can perform the approved first cutover from main. Workflow permissions are contents: read. GitLab's build job also runs the local performance budget probe.

## Owner token input

Go to Cloudflare Manage Account → Account API tokens: https://dash.cloudflare.com/?to=/:account/api-tokens . Select the existing account and create an account-owned token. Under Permission policies choose Specified Workers, select only the existing Worker, and grant Workers Editor. Do not select Entire Account or legacy Workers Scripts Edit (which applies to all Workers in the account). No D1/KV/R2 Read or Write, zone Routes Write, Access edit or token-creation grant is needed by this pipeline. Current official granular token documentation supports this scope; confirm it on the owner's summary screen before creating it.

Go to the repository Settings → Environments: https://github.com/OWNER/REPO/settings/environments . Create production, restrict its deployment branch to main, and enter the token directly in environment secret CLOUDFLARE_API_TOKEN. Do not put token values in chat, source, logs or transfer interactive CLI/OAuth credentials. The environment/action setup and persistent credential require owner approval. A deployment-only token has code/control access to the selected Worker and its existing bindings; it cannot be described as only uploading text.

## Initial setup and cutover

Use a separate D1, KV and R2 Standard. Preserve old storage. Independently initialize only the new D1 using the reviewed migrations/platform ledger. Verify the actual ledger once through the authorized operator path, then record the SHA256 of dist/migrations.json as CF_APPROVED_SCHEMA_SHA256. CI compares this approved fingerprint; it does not query the database or assert absence of later out-of-band schema drift. A schema-changing commit blocks until separately reviewed/applied and the approved fingerprint updated.

Choose explicit oauthEnabled and integrationsEnabled booleans. Both can be false for browser-only setup, requiring no new runtime secret. INTEGRATIONS_KEY is required only for Integrations; OAUTH_FORM_SECRET only for OAuth, together with issuer/resource settings. Enter enabled feature secrets securely on the Worker, never in GitHub variables. Existing enabled-feature secrets cannot be silently disabled by flags; preflight rejects mismatches.

Keep existing Access policies. Browser-only UI/API operate with the root Access assertion. The pipeline does not require public health or Access Bypass: local workerd/artifact tests establish runtime behavior, unauthenticated API checks accept Access login/403 or application auth rejection, and after upload Cloudflare deployment metadata must show the new version serving 100%. This proves code activation, not authenticated application health. Initial owner login/workspace setup and any enabled OAuth/agent/integration flows must be verified manually. Agent/OAuth/inbound integration path changes are a separate, explicit approval if those features are selected.

Generated config manages no routes/custom domains; a committed route setting is rejected. Pinned Wrangler does not call route/domain publish when no routes/domains are supplied, preserving the existing custom domain. No zone permission is requested. The first approved manual cutover updates the existing Worker with new bindings; old databases are never migrated or deleted. Code rollback does not restore/modify DB data.

## Variables and enablement

Production environment variables:

- CLOUDFLARE_ACCOUNT_ID: approved account.
- CF_PRESERVED_D1_IDS: every preserved database ID, comma separated.
- CF_APPROVED_SCHEMA_SHA256: fingerprint approved after new DB ledger verification.
- CF_DEPLOY_CONFIG: JSON with worker, d1Id, d1Name, kvId, r2Name, origin (HTTPS, trailing slash), accessTeamDomain, accessAudience, rateIds (three distinct decimal strings), oauthEnabled and integrationsEnabled (booleans). Optional fields: `adminEmails` (string array), `defaultWorkspaceSlug` (workspace ID pattern), `defaultWorkspaceName` (nonempty string), `placement` (`"smart"` only). Present optional workspace fields become Worker vars `ADMIN_EMAILS`, `DEFAULT_WORKSPACE_SLUG`, and `DEFAULT_WORKSPACE_NAME`; empty admin lists do not enable bootstrap. An absent `placement` leaves Smart Placement disabled.

For an owner trial, record the current D1 query latency and authenticated UI/API TTFB (median and p95, especially issue list, board, and writes) from the same client locations and traffic period. Set `placement` to `"smart"` in the protected `CF_DEPLOY_CONFIG`, deploy through the normal approved main workflow, and allow at least 15 minutes plus traffic from multiple locations for placement analysis. Check Cloudflare's placement status and `cf-placement` response header, then repeat the D1 latency and TTFB measurements with the same paths and clients. Remove the field and redeploy if overall TTFB or write latency worsens. Static assets remain edge served. Read replication is a later experiment requiring explicit read consistency and bookmark design.

Run node tools/github-deploy.mjs --check with the approved configuration before enabling the job. It validates commit/checksums, approved schema hash, preserved-DB refusal, feature secret names, protected HTTP boundary and local dry-run. Binding existence is independently verified during initial setup; upload validates the referenced resources. It does not create/migrate/delete resources or save secrets.

After independently checking initial resources/schema/configuration and approving the cutover, set repository CF_PRODUCTION_READY=true and manually dispatch the main workflow with deploy_production=true for the first cutover. Confirm owner login/setup after it completes; disable the flag and explicitly roll back if necessary. Subsequent main pushes verify then deploy code/assets only. No automatic rollback changes production behind the operator; inspect any failure and explicitly choose rollback. Account/installation details stay outside the repository.

## Why Actions

The official Cloudflare GitHub App requests repository administration/contents/checks/deployments/PR write permissions, and existing authorization is unverified. Actions avoids adding that broad GitHub grant. Workers Builds is an alternative only if selected/authorized explicitly; use main only, no preview branches, Node22.22.1/pnpm10.18.0, build CI_COMMIT_SHA=$WORKERS_CI_COMMIT_SHA pnpm verify, deploy node tools/github-deploy.mjs, with the same approval variables. Never enable both pipelines.

References: https://developers.cloudflare.com/workers/authorization/workers/ ; https://developers.cloudflare.com/changelog/post/2026-09-15-granular-worker-permissions/ ; https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/ ; https://github.com/apps/cloudflare-workers-and-pages .

## Retained legacy Durable Objects

The existing Worker owns SQLite Durable Object namespaces for WorkspaceHub and RateLimiter.
Keep both compatibility class exports in the Worker entrypoint. They return 503 and never
access storage; the modular application has no bindings to them. This preserves the
namespaces without reviving retired business code. Do not add a delete migration or a
deleted export tombstone: either permanently deletes the stored objects. No Durable
Object lifecycle change is part of this cutover. The native Miniflare regression test
seeds both namespaces, loads the production entrypoint, then verifies the original data.

Reference: https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/ .
