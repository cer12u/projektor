# Access (steps 02 and 02b)

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
because Platform's KV port has no TTL option. Outbound refresh attempts (including
unknown kids and failed fetches) have a 30-second issuer cooldown recorded at
`access:jwks-refresh:<issuer>`. One instance coalesces concurrent fetches and keeps
a local cooldown even if KV fails. Known cached keys still work during cooldown;
a new signing key can take up to the cooldown to become usable. KV is eventually
consistent, so this bounds amplification per instance and propagated KV state,
not exactly one fetch globally across all isolates/locations. A strict distributed
quota would require a strongly consistent coordinator, outside this step.
Expired cache plus network failure fails closed. KV failures do not reject a signature
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
is no delivery scheduler or consumer/inbox. Part 2 adds the OAuth events below.

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

Part 2 implements the MCP OAuth module contract below. Gateway later owns credential extraction,
Origin/CSRF, transport limits, REST/MCP parity and Streamable HTTP interoperability.
Q4 migration/cutover and Q5 real Cloudflare resources remain owner decisions.

## MCP OAuth (02b): protocol and identity

Composition optionally supplies `oauth: { issuer, resource }` to `createAccess`.
`issuer` is an exact HTTPS origin without trailing slash; `resource` is the exact
canonical HTTPS MCP URL without credentials, query or fragment. Neither is taken
from request Host/forwarded headers. Omission disables OAuth commands with
`temporarily_unavailable`. All APIs return data; this step adds no HTTP routes,
login/consent UI, bindings, deployment or client interoperability claim.

References checked 2026-10-13: [MCP authorization 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization),
[RFC 8414](https://www.rfc-editor.org/rfc/rfc8414.html),
[RFC 9728](https://www.rfc-editor.org/rfc/rfc9728.html),
[RFC 7591](https://www.rfc-editor.org/rfc/rfc7591.html),
[RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html),
[RFC 8707](https://www.rfc-editor.org/rfc/rfc8707.html),
[RFC 7009](https://www.rfc-editor.org/rfc/rfc7009.html),
[RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html).
Current MCP prefers Client ID Metadata Documents and keeps DCR for compatibility.
This bounded step implements requested DCR/public clients only, does not fetch
client URLs, and does not advertise CIMD, OIDC, confidential-client auth, implicit,
password or client-credentials grants. CIMD/other client requirements must be
assessed during step 06 interoperability, not silently assumed to work.

OAuth authentication uses `authenticate({kind: "oauth", bearer, resource})`.
The resulting principal is **the same human**, with the same issuer/subject hash
as their Cloudflare Access Web login. Frozen scopes add `clientId` for attribution;
the family records the human, client, workspace and resource. `kind` remains
`human`, so downstream project grants continue to address the human. Consumers
must retain `scope.clientId` in future activity attribution when present.
OAuth principals cannot create workspaces, issue credentials, manage Access or
consent to another client: those surfaces require a live interactive assertion.
Normal business reads/writes use existing `requireMembership` / `authorize`.

`read` permits reads. `write` includes read, and is normalized to `read write`.
An omitted authorization scope defaults to read. Registration's omitted scope
permits requesting read/write later; it grants neither. Membership is still the
ceiling: viewers cannot consent to write. Refresh may narrow but never enlarge
scope; narrowing is permanent for that family and also invalidates held write
handles. Protected-resource discovery advertises minimal `read`; AS metadata
advertises both scopes. Every token request must contain the exact configured
resource. Access admission requires that same resource, never the Access JWT
audience, client ID, URL supplied by a bearer, or a caller-selected audience.

## Registration, consent and tenant ownership

`registerOAuthClient` accepts a name (1–128 characters), 1–10 redirect URIs
(each at most 2048 characters), supported grant/response types, scope and public
`token_endpoint_auth_method: none`. The defaults are name `MCP client`, code
grant only and auth method `none`. Refresh is issued only to clients registering
`refresh_token`. Unknown optional metadata is ignored, not fetched or echoed.
The client ID is random and is not a secret. No client secret is generated.
Registration is atomically capped at 100 per rolling hour and 10,000 total clients
per installation; exhaustion is `temporarily_unavailable`. Gateway must add a
per-source abuse limiter before exposure. Caps do not replace that edge control.

HTTPS callbacks match exactly, including query and case. Literal `http://127.0.0.1`
and `http://[::1]` callbacks may change only their port at authorization time
(RFC 8252); localhost names, other HTTP, credentials, fragments, whitespace,
backslashes and wildcard URIs are rejected. Token exchange must repeat the exact
redirect URI selected at authorization, including its loopback port.

DCR happens before the human chooses a workspace. Therefore
`access_oauth_clients` is an explicit **global metadata-only exception**: a client
has no membership or grants. `access_oauth_workspace_clients` is created only by
consent in a selected, authorized workspace. Its versioned revocation prevents
that client from obtaining/admitting any tokens in that workspace, without
revoking an independently consented client binding in another workspace.
`getOAuthClient` / `revokeOAuthClient` are interactive manager-only; revocation
accepts `operationId` and `expectedVersion`. There is no re-enable in this step;
a deliberate future management feature must define that policy.

`getOAuthConsent(principal, request)` validates the client, redirect, response
`code`, resource, scopes, S256 challenge and optional state (at most 2048 characters),
then returns a frozen request-local handle and safe display values. The challenge
must be 43 base64url characters; verifier is 43–128 RFC 7636 unreserved characters.
The handle binds the exact request to that human and expires within 10 minutes
or their assertion expiry. It confers no workspace rights. After explicit user
approval and selection, obtain a scope from that same human and call
`approveOAuthConsent(scope, consent, {operationId, codeSecret})`. Approval rechecks
membership and scope. A handle from another instance, copy or human is rejected.

Gateway generates the 32-byte random hex `codeSecret`, retains it with the operation
ID for a request retry, and never accepts it from the OAuth client. Access returns
`{redirect_uri, code, state?, iss}`; state is passed through unchanged. Identical
approval retries recover the same unused/unexpired code, receipt and history;
changed input conflicts. Approval/registration do not provision humans or
workspaces. Consent must be displayed for every authorization, never inferred
from an existing client registration or Cloudflare Access login alone.

## Token lifecycle and atomicity

Codes expire after 120 seconds, access tokens after at most 300 seconds. Refresh
tokens expire after 7 days, limited by a 30-day absolute family lifetime. Tokens
are opaque random 256-bit secrets with routing prefixes `pc1`, `pa1`, `pr1` and
workspace ID; routing fields confer no authority. Only SHA-256 of the complete
code/token is stored. Cleartext is never in receipts, events, KV, logs or errors.
PKCE and redirect/client/resource are checked before consuming a code.

Code consumption + family creation + access/refresh hashes + event commit in one
batch. Rotation consumes the refresh exactly once, CAS-increments the family and
commits new token hashes + event in one batch. Guard constraints roll back zero-row
consumption or stale family versions. Old refresh hashes remain tombstones.
Replaying a used refresh revokes the whole family, including current access and
refresh tokens, even if the old refresh has expired. A correctly bound used code
also revokes its family, even after code expiry. Wrong clients/verifiers cannot
use this mechanism to revoke another client's family. Concurrent exchanges have
one issuance winner, then reuse retires that family; clients must serialize refresh.
There is no grace replay that returns an old secret.

`revokeOAuthToken({client_id, token, token_type_hint?})` retires the associated
family for either access or refresh tokens. Hints are advisory. Unknown,
malformed, already revoked and foreign-client tokens are success without revealing
existence (a missing/empty token is invalid input). Unknown client IDs are
`invalid_client`; public clients prove possession of the submitted token, not a
client secret. Revocation and its event are atomic and repeated revocation is inert.

Every new admission checks D1 membership, active workspace, client binding, family
and token expiry. No KV authorization cache is used. Codes/families capture the
membership version: **any role/membership change requires fresh consent**. This
conservative policy prevents removal/reinvitation from reviving old credentials.
Q1 still allows an already admitted command to finish; held scopes are rechecked
on each new operation. A workspace/client revocation cannot revive via refresh.

OAuth wire exchanges deliberately differ from normal command retries: OAuth clients
supply no `operationId`, and secrets stored only as hashes cannot be recovered.
Registration retry creates another public client; code/refresh retry is replay and
fails closed. After response loss, start authorization again. If a lost response
is detected inside Access after a committed exchange, retire its family. When
storage/recovery itself is unavailable the HTTP adapter must report a transient
error, never claim no commit occurred. The consumed code/refresh remains the durable
single-use marker. Interactive consent and client revocation retain the normal
idempotent operation/CAS contract. This is an explicit §5.2 protocol exception,
not relaxed database atomicity.

New tables: `access_oauth_clients` (global), `access_oauth_workspace_clients`,
`access_oauth_codes`, `access_oauth_families`, `access_oauth_tokens` (all tenant-local
keys/FKs). Existing receipt/event/guard tables are reused. New schemaVersion-1
events: `OAuthConsentGranted`, `OAuthClientRevoked`, `OAuthTokenIssued`,
`OAuthTokenRotated`, `OAuthFamilyRevoked`, with the existing actor-only payload.
The code hash/family ID is the credential aggregate ID, not a credential secret.
No other module's schema or new business dependency is used.

## Exact Gateway HTTP contract (step 06; not wired here)

For example issuer `https://projektor.example`, resource
`https://projektor.example/mcp`:

| HTTP surface | Access API and response |
|---|---|
| `GET /.well-known/oauth-authorization-server` | `getAuthorizationServerMetadata()`, 200 JSON |
| `GET /.well-known/oauth-protected-resource/mcp` | `getProtectedResourceMetadata()`, 200 JSON; derive suffix from resource path, also serve root fallback with identical data |
| `POST /oauth/register`, JSON | `registerOAuthClient`, 201 JSON; fields as `OAuthClientInput`/`OAuthClient`; no secret/auth cookie required |
| `GET /oauth/authorize`, query | Cloudflare Access human login, `getOAuthConsent`, `listWorkspaces`; render escaped client name, callback host, requested scopes, explicit workspace selector and approve/deny buttons |
| `POST /oauth/authorize`, form | Verify browser Origin/CSRF and integrity-bound consent request, reauthenticate assertion, reconstruct handle, resolve selected workspace with `requireMembership`, call `approveOAuthConsent`; 303 to returned callback with URL-encoded `code`, unchanged optional `state`, and `iss` |
| `POST /oauth/token`, form URL encoded | `exchangeOAuthToken`, 200 JSON `access_token`, `token_type: Bearer`, `expires_in`, `scope`, optional `refresh_token`; public `client_id` in body |
| `POST /oauth/revoke`, form URL encoded | `revokeOAuthToken`, 200 empty body even for unknown token; public `client_id`, required `token`, optional hint |
| Protected MCP requests | Extract Authorization Bearer on every request; `pa1` maps to `authenticate(kind: oauth, resource: configured URL)`, `pt1` to existing machine path; resolve workspace explicitly and reject URL/header/body/connection disagreement |

Token form for code: `grant_type=authorization_code`, `client_id`, `code`,
`redirect_uri`, `code_verifier`, `resource`. For rotation: `grant_type=refresh_token`,
`client_id`, `refresh_token`, `resource`, optional `scope`. Reject duplicate fields,
multiple resources, unsupported response modes, unsupported auth methods and
ambiguous credential sources; decode form/query exactly once. Gateway passes only
these validated fields. Do not expose credential, consent or client-management
commands as MCP tools. OAuth credentials cannot authorize the management surface.

The GET-to-POST consent binding is mandatory transport work: use a short-lived
signed/encrypted server envelope bound to the authenticated subject and CSRF cookie,
containing the original validated request, expiry and unpredictable nonce. Never
trust hidden form client/scope/redirect values merely because GET validated them.
No Access handle is serialized. On POST verify the envelope and origin, recreate
`getOAuthConsent` with its original request in the same Access instance used for
approval, and obtain the selected workspace scope from the fresh human login.
Use an operation ID and code secret tied to that consent attempt for retries;
any recovered code is usable only once. GET/login by itself must never grant a
code. Deny redirects only to the validated callback, with `error=access_denied`,
original state and issuer, and calls no approval command.

`OAuthError.code` is the protocol error, never its internal stack. At authorization,
`authorizationRedirect` exists only after client and redirect validation: encode
`error`, `state?`, `iss` onto that exact URI. Without it, render a local 400 and do
not redirect. On approval failures use the integrity-bound validated callback;
expired/forged browser state stays local. Consent `PlatformError` forbidden/conflict
maps to `access_denied`; unknown maps to `temporarily_unavailable`. Interactive
client-management APIs retain the normal REST 403/404/409/503 mapping. For token/registration errors use 400
JSON `{error: code}`, except `temporarily_unavailable` uses 503 with Retry-After.
Public-client `invalid_client` is 400 (no HTTP authentication challenge).
Unclassified storage errors are sanitized 503; never reinterpret them as successful
revocation. Browser denial/Access forbidden maps to `access_denied`, not token
`invalid_grant`. Unsupported grant/response types retain their specific codes.

All token/registration/revocation and authorization responses: `Cache-Control:
no-store`, `Pragma: no-cache`; consent pages also `Referrer-Policy: no-referrer`,
frame protection/CSP and no third-party assets. Use URLSearchParams to overwrite
reserved callback response parameters, removing stale `code`, `error`, `state`,
`iss` before adding this response. No assertion/token/verifier/authorization query
in access logs or error telemetry. Apply a 32 KiB request-body limit and rate limits
per source/client before calling Access. Public endpoints/discovery/token requests
must not be intercepted by Cloudflare Access browser login redirects: protect the
interactive authorization UI only, and validate human assertions there. TLS and
configured-origin validation are required. Public metadata/token/registration/
revocation may allow noncredentialed CORS for browser MCP clients; consent is
same-origin and must never allow credentialed wildcard CORS.

Unauthenticated/expired/invalid MCP tokens: 401 with `WWW-Authenticate: Bearer
resource_metadata="https://projektor.example/.well-known/oauth-protected-resource/mcp",
scope="read"` (and `error="invalid_token"` for a supplied bad token). Insufficient
scope: 403 with `error="insufficient_scope"`, required scope (`read write` for
writes), and the same metadata URL. Never accept bearer tokens from query strings,
forward them upstream, or use browser assertion audience as MCP resource. Gateway
must distinguish scope denial from missing membership without exposing another
tenant; when Access returns only generic forbidden, use a generic 403 instead of
claiming that a scope upgrade will fix membership/client revocation.

## Part 2 evidence and remaining work

`tools/access.test.mjs` adds pure URI/PKCE/registration rules, issuer JWKS abuse
bounds including concurrency/restart/fetch failure, metadata/DCR quota races,
human identity/client attribution, provider membership contract, hash-only state,
consent provenance/expiry/retry/fingerprint, incorrect PKCE/redirect/resource,
code replay/expiry, two-workspace client bindings, interactive-management denial,
refresh narrowing/expiry/absolute family lifetime/reuse, RFC7009 idempotence,
client CAS/live membership/archive invalidation, atomic rollback, lost responses,
and concurrent code/refresh consumption. Tests use only Access migrations and
Platform's migration ledger on Miniflare; fake clock/IDs/JWKS and storage fault
ports provide deterministic cases. No new business provider exists to fake.

Step 06 must implement and test the HTTP/CSRF/consent envelope and edge limits,
then exercise actual Claude Code, claude.ai, Codex and Dots-style clients. That
acceptance may reveal additional registration/auth method needs. Retention/cleanup
of expired clients/codes/families/tokens is future Access maintenance: do not delete
reuse tombstones while a family can still be live. Current caps fail closed rather
than reclaim client identities automatically. Q4/Q5 and real Cloudflare smoke
remain open; local tests do not validate deployed D1/JWKS/KV propagation.
