# Removed legacy auto-join and scheduled trash purge

Status: local candidate for independent review. No Cloudflare changes, data changes,
production deployment, credential/Access changes, or backup deletion occurred.
Baseline is PR7 caa65d78580812be8117a703c0743be82ee349cf; the source bytes are copied
from the separately verified service-boundary candidate. The source digest manifest
records a candidate delta, not a claim that this modified source is already committed.

## Actual changes

- Product configuration rejects AUTO_JOIN_ROLE even when set to `none`, as well as
  auto-provision, trash-purge and schedule/cron switches. There is no compatibility
  switch to reactivate those capabilities.
- The new service remains a narrow fetch entry plus WorkspaceService. It imports no
  legacy enrollment, GET provisioning, email upsert or scheduled purge implementation.
  Its empty-store initialization never creates accounts, membership, or identity grants.
- Deprecated enrollment/purge routes and RPC names reject; tests check stored entity,
  membership, identity, activity, outbox and operation counts are unchanged.
- Read-only preflight rejects unknown configuration, unsupported entrypoints,
  any schedule in this release, changed live binding identities, stale deployment
  versions, missing workspace namespace attestation, and unresolved DO lifecycle review.
- Source-graph validation parses/links without evaluating code. It requires all nine
  product source modules to match a trusted reviewed SHA256 inventory and checks the
  exact exported names `WorkspaceService` and `default`. A hash change inside default
  (including an added scheduled handler) rejects. The digest inventory must itself be
  independently reviewed; self-generated hashes are not proof of semantic safety.
- No production Wrangler file is emitted. The repository's development manifest is
  not a release input and must never be deployed implicitly.

## Production config and lifecycle blockers

The read-only Cloudflare audit confirms existing schedules empty, AUTO_JOIN_ROLE=none,
Worker projektor, hostname projektor.cerutech.net, and no WORKSPACE namespace. It does
not publish binding IDs or secret values. Therefore no genuine deployable production
manifest is supplied here. Tests use conspicuously synthetic identities only.

Preflight takes an independently obtained live snapshot and reviewed profile. Preserve
all existing binding identities including DB, KV/OAuth, R2, secret-text binding names
and existing RateLimiter namespace. The `identity` field is a non-secret stable resource
reference; for a secret, use name/type presence attestation only, NEVER its value.
No legacy variable (AUTO_JOIN_ROLE included) is passed into the new service vars.
The five service vars are an exact allowlist. Unknown extra config fails closed.

An explicitly authorized WORKSPACE namespace with WorkspaceService class mapping is
required. Existing RATE_LIMITER binding and class export/rollback compatibility still
need a concrete reviewed deployment plan. Do not silently remove RateLimiter, import
its legacy composition root, invent a namespace ID, repoint legacy D1, or treat a
lifecycle evidence reference as independent proof that its evidence was actually approved.

The checked-in reviewed-product.json is a candidate digest inventory tied to the
baseline revision for review only. Before release, independent reviewers must bind
its exact bytes to the FINAL remote commit and regenerate the externally trusted
review input with that final sourceCommit. A profile/review commit mismatch rejects.
The validator always returns deploymentAuthorized:false, including on success.
Remaining cutover gates in the sibling projektor_cutover_20261008/RELEASE-GATES.md still apply.

## Obsolete legacy paths at cutover

Legacy apps/api development AUTO_JOIN_ROLE=viewer, GET-time user/membership provisioning,
and automatic cron trash purge are obsolete in the replacement product. They are not
copied into this candidate, and the old worker must be fenced/drained before switching.
The old repository code/config is retained as historical rollback input until a safe
cutover plan explicitly retires it. No old live code or stored records are deleted here.

This removes only automatic enrollment and automatic trash deletion. User-authorized
manual membership administration and recoverable trash/restore remain product
requirements; the narrow current service does not yet implement those broader features.
No permanent ban on future explicitly designed outbox/backup maintenance is introduced.
This release has no cron; any future schedule requires a separately reviewed change.

## Reproduce

From experiments/atomic-command-poc:

- npm run test:release
- npm run test:all
- node --test browser-test/fixture-authz.test.mjs

Read-only CLI (no implicit defaults, no network, no deployment):
node --experimental-vm-modules release/check.mjs ROOT PROFILE_JSON OBSERVED_JSON REVIEW_JSON

Inputs use the schema enforced by release/preflight.mjs. The positive synthetic fixture
in release/preflight.test.mjs shows its shape without misrepresenting actual live IDs.
Node >=24.19.0 and the existing locked dependencies are required. SourceTextModule is
experimental in Node; the test/CLI flag is explicit.

The binding inventory must include audited DB, KV, OAUTH_KV, RATE_LIMITER, JWT_SECRET
and one R2 binding. Its actual R2 binding name is taken only from the live snapshot.
Lifecycle review requires matching RateLimiter namespace/class/export resolution,
WorkspaceService namespace/class/SQLite migration tag, and rollback code/data evidence.
These references require independent review; the preflight cannot authenticate approvals.
