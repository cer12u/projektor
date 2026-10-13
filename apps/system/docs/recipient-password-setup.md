# Recipient-bound initial and reset setup

New administrator-issued setup uses a recipient-established protected browser context. No new issuance returns a password-setup bearer. The legacy holder endpoints remain solely to consume previously issued, unbound grants; they reject owner- or recipient-bound grants.

## Browser entry separation

`/password/setup` mounts only recipient setup. `/password/setup/legacy` mounts only the migration holder flow. Both offer a plain same-origin link to `/password/setup/owner`; neither mounts the owner controller or calls the owner bootstrap API, including when a prior owner operation ID remains in browser storage.

`/password/setup/owner` is the dedicated top-level owner entry. If external admission is configured, protect this owner page and the exact `/api/auth/password-setup/owner-initial` API family together, keeping ordinary recipient pages and recipient APIs outside that owner-only admission scope. Following the link permits interactive admission before JavaScript issues scoped requests. Setup fetches retain `redirect:error`; do not make them forward a password or capability through a login redirect. This routing change does not create or modify provider security settings.

## State and authority

1. The recipient explicitly begins at `/password/setup`. A fresh same-origin login challenge creates a random, Secure, HttpOnly, host-only cookie and a nonsecret `requestId`. Only the capability hash is persisted. The request ID can be shared with the administrator; it never authorizes setup or recovery.
2. The administrator selects the target principal and initial/reset purpose, supplies the recipient request ID, target revision and stable issuance operation ID. One atomic commit checks current administrator authority, target active/auth version/revision, purpose eligibility, the unbound and unexpired recipient context, and the latest grant. It binds one grant and records the result. Replaying the same operation recovers that result under current authority; changing the request ID is an input mismatch.
3. With its cookie and CSRF, the recipient reads waiting, ready or completed state. Ready state displays target login/name, initial/reset purpose and issuer. Explicit recipient confirmation is required before the password form. Completion repeats operation ID, principal ID, issuer ID and purpose. Cookie binding, grant validity, latest grant, target version, password change and completion result are checked/committed together.
4. Lost issuance or completion acknowledgements retain the same operation and grant. The recipient does not need the administrator's lost operation ID: its existing capability discovers the immutable binding. A later reset, revocation, target deactivation/version change, or absolute expiry denies old result disclosure. Error responses do not certify nonapplication; a known submitted operation ID is retained with unknown application certainty and no protected snapshot.

## Reload and explicit retirement

`POST /api/auth/password-setup/recipient/context` with `{requestId}` is resume-only. It requires the existing matching capability and consumes a fresh login challenge to rotate CSRF. It does not renew lifetime, rebind a grant, or send Set-Cookie. Context lifetime is at most 30 minutes; grant binding may shorten it.

`POST .../recipient/abandon` requires `{requestId}`, the capability and a fresh same-origin login challenge. The exact request/cookie match and inactive-grant condition are checked atomically. A currently valid bound uncompleted grant returns 403. An unbound, completed, expired, revoked or superseded context may be retired; this does not revoke a completed password/session or an unrelated reset. Retirement forfeits that old result capability. It returns `{abandoned:true}` only for a matching confirmed retirement. A missing/orphaned capability returns `{abandoned:false,reason:"context_missing"}` without a server-revocation claim. No Set-Cookie is emitted, including on retries, so delayed retirement cannot clear a newer cookie.

Only a separate explicit Begin may send `{replaceAbandoned:true,replacesRequestId}`. A stored predecessor must be revoked and match that request ID. A unique immutable predecessor-hash link allows at most one replacement child, including concurrent tabs. An orphaned or missing capability permits only a fresh unbound context, never recovery of the old grant. A lost replacement response is not permission to remint another capability. The client preserves uncertainty and rejects a response that conflicts with its saved request/binding; it never silently changes the setup target.

First creation without an existing capability is fenced by a single-use login challenge. Distinct anonymous challenges cannot establish that two requests came from the same browser. This limitation cannot recover or rebind an issued grant: the client retains its exact request marker and refuses a mismatched context. Lost-cookie recovery requires explicit resolution, rather than treating a public request ID as a secret.

## Responsibility and verification

Identity application/rules own eligibility, purpose selection, lifetimes, secret generation/hashing orchestration and exact confirmation. Concrete persistence ports carry the selected values and expected observations. D1 encodes and atomically rechecks current conditions; it does not decide a separate workflow. External issuer grammar and trusted deployment configuration belong to the external-identity adapter. No JWT claim or request body may choose a trusted issuer or bootstrap owner.

Migration `0019_recipient_setup_contexts.sql` is additive. Earlier migration bytes remain unchanged. It introduces context binding/expiry immutability and one-child replacement uniqueness; it does not issue grants, passwords or credentials.

Focused local verification uses the actual HTTP worker, D1 and Argon2 WASM with synthetic identities. It covers lost acknowledgements, restart recovery, concurrent issuance/completion/replacement, current-authority loss at disclosure, stale request/cookie intent, no cookie writes during refresh/retirement, legacy-bound rejection and result privacy. UI tests separately cover explicit target confirmation, local storage failure, resume-only reload, cross-tab mismatch and deliberate retirement. These tests do not establish production deployment, live provider permissions, real credentials or cross-executor continuity.
