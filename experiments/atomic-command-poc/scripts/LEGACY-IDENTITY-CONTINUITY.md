# Legacy identity continuity: migration plan only

The legacy d398 authentication boundary accepted a signature-verified Access email,
upserted `users` on its unique exact email, and read that row's `users.id`. It did
not persist the Access `sub`. The current authentication boundary uses verified
`iss/sub/kind` and requires an existing `identity_binding`. These identifiers are
not interchangeable. Source: `apps/api/src/middleware/auth.ts` at
`d39852cef35217bc1dbf4c42d646bda1f09994d3`, especially `validateCfAccessJwt`,
`verifyJwtPayload`, and `upsertUserByEmail`; legacy `packages/db/src/schema/core.ts`.

`createLegacyIdentityContinuityPlanner` is an offline, read-only continuity check.
It is not imported by a service entrypoint and exposes no HTTP route or executable
CLI. It cannot create an identity binding, credential, user, membership or provider
application. It does not activate authentication or unfreeze a workspace.

The factory accepts reviewed `providerConfig`, `sourceBoundary`, a read-only
`sourceDb` (SQLite or asynchronous D1), a controlled synchronous frozen `targetDb`
snapshot, `workspaceId`,
`workspaceEpoch`, and `expectedPrincipalId`. Its returned `plan(request)` performs:

1. The exact normal RS256, issuer, audience, application-token, subject and expiry
   verification path. It never independently decodes an unverified email.
2. One exact BINARY email lookup against existing legacy `users`, requiring a
   unique row whose ID equals `expectedPrincipalId`, with a LEFT JOIN of source
   workspace membership in the same statement snapshot. Only IDs are returned.
   No normalization, owner inference or provisioning is performed.
3. Exact workspace and epoch checks in the frozen target (`active=0`), and the
   same nonrevoked imported principal with kind `legacy_unbound` or `human`.
4. Forward and reverse binding collision checks. A preexisting exact binding must
   have a matching unexpired, nonrevoked credential; its handle is never returned.

`sourceBoundary` has exactly `issuer`, `humanAudience`, and `emailVerification`.
The provider values must agree with `providerConfig`. The source-supported mode
is `signed_access_email`: absent `email_verified` is allowed, explicit false is
rejected. `email_verified_claim` requires true and is available only when the
reviewed source boundary independently requires it; it is never added silently.
The shared legacy public viewer is rejected as a human identity.

The frozen result has `mode: migration_plan_only`, `authActivated: false`, the
workspace and epoch, preserved `legacyUserId` and `principalId`, a proposed human
provider tuple, and whether an existing binding matches. It contains no email,
token, credential handle, permissions or scopes. It is neither an ActorContext
nor an authorization decision. Keep any intermediate verified evidence in memory;
do not log emails or tokens. Real provider evidence and private identity records
have not been exercised by the synthetic tests.

Keep the target in a consistent frozen migration snapshot. D1 source reads use
one parameterized SELECT and observe identity and membership together. Planning
is evidence about those snapshots, not a reservation against later changes. Any separately approved
application step would need fresh current checks and is deliberately absent here.

An existing human-only Access application can now be represented with explicit
`machineAudience: null`. Human verification is unchanged; unconfigured machine
authentication fails closed before key fetching. Omitting the field is invalid.
A configured machine audience must remain distinct and keeps its existing
behavior. This does not complete legacy `pk_`/PAT/OAuth machine compatibility and
does not remove the requested machine connection work.
The release profile may use `MCP_RATE_LIMIT_CONFIG: 'null'` (serialized JSON null)
only in this explicit human-only mode. Configured machine access still requires
the existing bounded MCP policy. The serialized-null exemption also requires `LEGACY_API_TOKEN_AUTH` to be absent; enabled legacy bearer access requires a bounded MCP policy even when Access machineAudience is null. No machine capacity evidence is implied.

## Minimum real evidence and adapter boundary

The existing raw migration export contains legacy user IDs and names, without
email or provider subjects. It cannot establish this mapping by itself. The
minimum additional evidence is the same existing, verified Access request inside
a trusted boundary, a parameterized exact-email lookup returning only the existing
user ID, source workspace membership, and the frozen target principal and epoch.
The email must come from that verified request, never an email supplied in a
request body. The token must stay inside the trusted boundary and must not be
exported. Prefer that narrow server-side lookup to exporting a users/email table.

The source adapter supports SQLite `prepare().all(...args)` and asynchronous D1
`prepare().bind(...args).all()` with a successful `{results}` response. Provider
expiry is checked again after that asynchronous read. The target remains a
controlled synchronous frozen snapshot. A local actual Miniflare D1 binding is
tested with synthetic records; no actual person's mapping or live D1 database has
been accessed. Connecting a private source or applying a mapping remains separate.

## Focused verification

The new test uses in-memory synthetic RS256 material and real SQLite source/target
tables, switches both databases to `query_only`, and compares all rows before and
after. It checks exact-email ID equality, collision and revocation denial, the
frozen workspace boundary, no authority activation, and output privacy. Existing
auth tests protect configured human/machine behavior. The release-profile null
audience case only validates configuration; it never authorizes deployment.
The D1 integration reuses that in-memory signing fixture, executes the joined
lookup through an actual Miniflare D1 binding, verifies missing/colliding identity
and membership failures, and compares source and target rows before and after.
Actual D1 result metadata reports zero written rows and no database change. Only
the continuity tests need rerunning for this source-adapter change; shared auth,
hosting and release code are unchanged.

The source manifest is intentionally not self-approved or rewritten by this
change. Changed product bytes require an independent reviewed manifest before
the exact-byte release gate can accept them.
