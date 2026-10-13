# Access part 1 (step 02)

Access has no business dependencies; Platform supplies its fixed catalog store,
`ScopedKV`, clock and IDs. No HTTP route or production binding is introduced.
`internal/factory.ts` is composition-only. Pass an Access store, `access:` scoped
KV, and typed `AccessConfig { teamDomain, audience }`; the team domain must be an
HTTPS origin such as `https://example.cloudflareaccess.com`. The configured URL,
not a JWT's `iss`, selects `/cdn-cgi/access/certs`. `fetchJwks` is a narrow private
port for offline testing. Raw bindings never enter Access. Gateway composition
(step 06) will inject environment values and retain only `api` for requests.

## Authentication and handles

Human assertions use Web Crypto RS256 verification and exact issuer/audience,
expiry, issued-at and optional not-before checks. Require application type,
subject and email; service-token claims are rejected. The identity key hashes
`[human, issuer, subject]`, never email. Authentication creates no durable rows.
Membership commands explicitly register identity records. Public signing keys
alone are cached as `access:jwks:<issuer>` for 300 seconds, with an embedded expiry
because Platform's KV port has no TTL option. Unknown kid refreshes once; expired
cache plus network failure fails closed. KV failures do not reject a signature
that can be checked with fresh keys. Membership and credential status are never
cached. [Cloudflare's signed JWT and JWKS contract](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
is the external protocol reference.

`authenticate` returns an opaque principal. `requireMembership` resolves a
workspace and issues a frozen `RequestScope`. `authorize(scope, read|write)`
rechecks identity expiry, live credential, active workspace and membership.
Factory-local WeakMaps verify provenance: casts, spread copies, prototype copies,
serialized handles and another factory's handles are invalid. Scope fields are
admission snapshots, not reusable authorization decisions. Every downstream
operation must call `authorize`; do not persist or queue a handle. Workers must
use one composed Access instance for the duration of a request. Reauthenticate
after restart. Q1 allows an already admitted operation to finish after revocation;
new admissions and operation-result reads check current authority.

## Commands and minimal roles

All management requires an interactive human. Machines are confined to the
credential workspace and read/write ceiling, even when a caller changes IDs.

| Role | Permission |
|---|---|
| owner | read/write; manage all memberships and machine credentials; archive workspace |
| admin | read/write; invite/change/remove member or viewer; manage machine credentials |
| member | read/write business admission; no Access management |
| viewer | read admission only; no Access management |

Only owners can appoint or change owners/admins. The last active owner cannot be
removed or demoted; SQL checks this in the transaction, including concurrent
changes. The update predicate also limits an admin to member/viewer targets,
so a concurrent promotion plus guessed future version cannot bypass that rule.
Machines can only be member/viewer. `provisionMachine` is human
owner/admin-only and creates a deterministic workspace-specific machine identity.
`issueCredential`/`revokeCredential` are likewise interactive-only, never MCP tools.
Membership removal revokes that principal's credentials in the same batch.
Human reinvitation uses the tombstone's expected version; old credentials cannot
revive. Workspace version currently changes only on archive, not membership edits.

`createWorkspace` is an explicit authenticated-human command; it grants its caller
owner membership. One installation-wide `bootstrap(operator, principal, input)`
creates the initial workspace owner. Composition must deliberately enable and
retain the operator capability; a request caller cannot mint it. Concurrent
bootstrap attempts on different workspaces still have one winner. Retries with
identical workspace/principal/operation/input recover the receipt, with current
membership checked. Disable the capability after initial setup. No operator HTTP
endpoint is provided here.

Each mutation takes `operationId`; updates also take `expectedVersion` (creation
is version 1; first invitation has expectedVersion 0). `inviteMember`, `changeRole`,
`removeMember`, `provisionMachine`, `issueCredential`, `revokeCredential` and
`archiveWorkspace` return `{id, version}`. `getMembership` and `getCredential`
provide versions; credential queries are manager-only and omit hash and secret.
`getPrincipalSummary` requires active same-workspace membership of the target.
`listWorkspaces` returns up to 100 active memberships in workspace-ID order;
pagination beyond that is deferred until the product needs it.

## Credential delivery and retries

The trusted interactive caller generates 32 cryptographically random bytes,
encodes them as 64 lower-case hex characters, and retains them until issuance is
known. `issueCredential` accepts this `secret` plus credential ID, principal ID,
read/write scope and expiry in Unix seconds. Its response is metadata only.
Bearer format is `pt1.<workspaceId>.<credentialId>.<secret>`. Workspace and credential
IDs use `[a-zA-Z0-9_-]{1,128}`. Never log the input, bearer or assertion. Storage
contains SHA-256(secret); the operation fingerprint contains that hash, not the
secret. No cleartext is stored in receipts, events or KV. This avoids persisting a
recoverable credential to support idempotent issuance. After a lost response,
retry with the retained input. If the caller loses its secret, revoke that
credential and issue a new one. Gateway must generate/deliver the secret over the
interactive surface and must not expose management through MCP.

## Storage, history and recovery

Owned tables are `access_principals`, `access_workspaces`, `access_memberships`,
`access_credentials`, `access_receipts`, `access_events`, `access_guards`, and
`access_bootstrap`. The first is a justified global identity registry; identity
alone grants no access. The bootstrap table is a global one-row installation
latch. All other tables and their unique keys are tenant-local. All FKs stay in
Access. Auth attempts are omitted: no rate limiting/audit retention requirement
needs a new durable table in this step, and assertions/tokens must not be logged.

One D1 batch commits each mutation, immutable history/outbox record, and receipt.
A guard following the mutation aborts zero-row CAS or invariant failure.
Membership removal's credential revocation follows this guard in the same batch.
Receipts are unique by workspace/principal/operation and fingerprint the command,
target and input. Concurrent identical retries return the one committed result;
changed input conflicts. Constraint failures roll back; other store failures are
`unknown`. A failed response triggers a receipt read; if recovery also fails,
return `unknown`, never "not applied". `readOperation` returns metadata or null;
null is not proof that an in-flight transaction will not commit. Reuse the same ID.
After membership removal or workspace archive, result reads/retries are denied
by live authorization even for a previously successful command.

`access_events` serves both immutable history and producer outbox. Envelopes have
source `access`, schemaVersion 1, workspace/aggregate/version, event ID, occurrence
time, type, actor-only payload and workspace-local monotonic cursor. Event types:
WorkspaceCreated, MembershipChanged, MachineProvisioned, CredentialIssued,
CredentialRevoked, WorkspaceArchived. `readEvents(capability, workspaceId, cursor,
limit)` accepts 1–100, ordered after cursor. Composition may bind an EventReader
to a named consumer; no reader is issued by default. The factory-local capability
is specific to that Access producer/consumer pair and intentionally reads even
archived workspaces for downstream invalidation. Keep it out of HTTP/MCP. There
is no delivery scheduler, consumer/inbox or OAuth server in step 02.

## Evidence and boundaries

`tools/access.test.mjs` uses local RSA keys, fake clock/ID/JWKS ports and real
Miniflare D1/KV with only Access migrations (plus Platform's ledger). It tests
rules, public API provenance/roles, tenant separation, hash-only credentials,
expiry/revoke/demotion, bootstrap concurrency, last-owner concurrency, operation
fingerprints, CAS, history/receipt rollback, lost-response and restart recovery,
event cursor/capability checks, and a controlled Q1 admission/demotion race.
`modules/access/tests/contract.ts` is a public-only provider contract seed for
consumer fakes; Access has no business provider to fake in this step. The existing
Platform contract tests cover its store/prefix ports. These are local workerd
results, not proof about deployed Cloudflare D1 or Access policy configuration.

The public-type checker previously traversed standard String methods on a literal
union after already checking all members. That false positive is corrected by
returning after inspecting every union constituent. Negative fixtures specifically
hide D1, SQL literal and callback capabilities in unions; no allowlist was added.

02b implements MCP OAuth 2.1 login. Gateway later owns credential extraction,
Origin/CSRF, transport limits, REST/MCP parity and Streamable HTTP interoperability.
Q4 migration/cutover and Q5 real Cloudflare resources remain owner decisions.
