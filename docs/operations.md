# Operations: configuration lives outside the repository

This repository is published as-is (it is also mirrored to a public GitHub repository).
It must not contain values that belong to one installation:
- registries;
- account, zone or resource IDs;
- hostnames;
- workers.dev subdomains;
- Access team domains or audiences;
- secrets.

Those values are supplied as GitLab CI/CD variables, or by deploy-time configuration that a job generates from them.
`pnpm check:literals` (run in the `static` job and in `pnpm verify`) enforces this.

## CI/CD variables

| Variable | Protected | Masked | Purpose |
|---|---|---|---|
| `CI_NODE_IMAGE` | no | no | Optional prebuilt Node CI image. Without it, the pinned public `node` image is used and pnpm is installed per job. |
| `CI_BROWSER_IMAGE` | no | no | Optional prebuilt Playwright CI image. Without it, the pinned public Playwright image is used. |
| `FORBIDDEN_LITERALS` | no | no | Comma-separated installation-specific strings (internal domains, registry names, account handles) that `check:literals` must reject. Keeping the list here keeps it out of the repository. |
| `CLOUDFLARE_API_TOKEN` | yes | yes | Token for the verify smoke, the inventory and the deploy. |
| `CLOUDFLARE_ACCOUNT_ID` | yes | yes | Cloudflare account. |
| `CF_VERIFY_NAME` | yes | no | Optional name of the verify Worker, D1, KV and R2 (default `projektor-verify`). |
| `CF_VERIFY_RATELIMIT_IDS` | yes | no | Optional `register,token,feedback` rate-limit namespace IDs for the verify Worker (default `1001,1002,1003`). Rate-limit namespaces are account-wide, so pick IDs that no other Worker uses. |
| `CF_ZONE_NAME` | yes | no | Optional zone that the inventory job inspects for Worker routes. |


## Prebuilt CI images
`ci/Dockerfile` adds pnpm and a store prefetched from `pnpm-lock.yaml` to the pinned public bases.
1. Build and push the images with `CI_IMAGE_REPO=<registry>/<project>/projektor-ci tools/ci-image.sh`.
2. Set `CI_NODE_IMAGE` and `CI_BROWSER_IMAGE` to the printed digests.
3. Rebuild after a lockfile, Node, Playwright or pnpm change. A stale store still works, because jobs install with
   `--prefer-offline`.

## Production deploy

The manual `deploy` job runs on protected `main`. It does the following, in order:
1. verifies the build artifact;
2. finds or creates the production D1, KV and R2 by name;
3. applies D1 migrations through a temporary, secret-gated `<worker>-migrate` Worker, which it deletes again afterwards;
4. deploys the Worker with configuration generated from the variables below;
5. checks `<origin>/health`.

If the health check fails, the job rolls back to the previous Worker version. The manual `rollback` job restores the previous
version, or `ROLLBACK_VERSION_ID` when set. Data is never touched: migrations are additive.

| Variable | Protected | Masked | Purpose |
|---|---|---|---|
| `CF_PROD_WORKER` | yes | no | Worker name. A Worker that already serves the hostname is replaced in place, and its custom domain is kept. |
| `CF_PROD_RESOURCE_NAME` | yes | no | Name of the production D1, KV and R2. Use a new name, so that data from another deployment is never reused. |
| `CF_PROD_ORIGIN` | yes | no | Public origin, e.g. `https://projektor.example.org`. Used for the OAuth issuer/resource and the post-deploy checks. |
| `CF_PROD_RATELIMIT_IDS` | yes | no | `register,token,feedback` rate-limit namespace IDs. They are unique within the account. |
| `ACCESS_TEAM_DOMAIN` | yes | no | `https://<team>.cloudflareaccess.com` |
| `ACCESS_AUDIENCE` | yes | no | AUD tag of the Access application. |
| `PROD_INTEGRATIONS_KEY` | yes | yes | 64 hex characters (`openssl rand -hex 32`). Keep it stable: it decrypts stored webhook secrets. |
| `PROD_OAUTH_FORM_SECRET` | yes | yes | 32+ random characters (`openssl rand -hex 32`). |

The API token additionally needs the same account permissions as the smoke job. No zone permission is needed while the custom
domain stays attached to the same Worker name.

## Cloudflare Access application
People sign in through Cloudflare Access. Agents use machine bearer tokens or MCP OAuth, which Access must not intercept.

1. Create a self-hosted Access application for the hostname, with an Allow policy for the people who may sign in. Note its AUD
   tag and the team domain.
2. Add Bypass (path-scoped) applications, or policies, for the following paths:
   - `/mcp/*`
   - `/.well-known/*`
   - `/oauth/register`, `/oauth/token` and `/oauth/revoke`
   - `/integrations/*`
   - `/health`
   - `/api/*`
   Keep `/oauth/authorize` and the Web UI (`/`) behind Access.
3. How `/api/*` works under Bypass:
   - The browser still sends the Access `CF_Authorization` cookie, and Gateway verifies that JWT exactly as it verifies the
     `Cf-Access-Jwt-Assertion` header.
   - A cookie-authenticated write must carry this site's `Origin`.
   - The cookie never authenticates MCP, and never overrides a bearer token.

Any person whom the Access policy admits can create a workspace and becomes its owner, so keep the Allow policy narrow.

# Restored UI routing and migration

The Worker sends `/api/*`, `/auth/*`, `/mcp/*`, `/oauth/*`,
`/.well-known/*`, `/integrations/*`, and `/health` to Gateway. Other paths use
the Astro files in `dist/assets`, with the original project, issue, share,
feedback, and wiki deep-link fallbacks. The artifact records checksums for all
files below `dist/assets`.

Optional Worker vars are `ADMIN_EMAILS` (comma-separated, case-insensitive),
`DEFAULT_WORKSPACE_SLUG` (defaults to `projektor`) and
`DEFAULT_WORKSPACE_NAME` (defaults to `Projektor`). Only a verified human whose
email is listed may create the default workspace, once, on `/auth/me` when
they have no membership. Other users are never auto-joined.

For this MR, apply the additive Access `0005_profile.sql` and Projects
`0004_ui_fields.sql` migrations to the approved production D1 before code
deployment. Verify the ledger and database backup, then set
`CF_APPROVED_SCHEMA_SHA256` to the SHA-256 of the new `dist/migrations.json`
as described in [GitHub deployment](github-cloudflare.md). Deploy code after
the schema hash is approved.

For C4a, apply Planning `0004_sprint_details.sql` and
`0005_one_active.sql`, and Assets `0005_link_assets.sql`, to the approved
production D1 through the operator migration path before deploying this code.
Verify the `platform_schema_versions` receipts for all three files. Then build
the merged commit, calculate `sha256sum dist/migrations.json`, and update
`CF_APPROVED_SCHEMA_SHA256` to that exact digest before the code deploy gate.
The Planning timestamp backfill skips frozen scopes, whose legacy sprint
timestamps remain zero.

For C4b, run the read-only slug-conflict query in the MR before migration.
Apply Wiki `0003_workspace_pages.sql` through the operator migration path on
the approved production D1 before deploying code. Verify its
`platform_schema_versions` receipt and that `wiki_purge_bypass` has no remaining
rows. Build the merged commit, calculate `sha256sum dist/migrations.json`, and
set `CF_APPROVED_SCHEMA_SHA256` to that exact digest before the code deploy gate.

For C4c, apply Access `0006_credential_metadata.sql` through the operator
migration path on the approved production D1 before deploying code. Verify its
`platform_schema_versions` receipt, confirm legacy `access_credentials.created_at`
matches each `CredentialIssued` event time where available, and confirm
`access_purge_bypass` has no remaining rows. Build the merged commit, calculate
`sha256sum dist/migrations.json`, and set `CF_APPROVED_SCHEMA_SHA256` to that
digest before the code deploy gate.
