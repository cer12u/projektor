# Gateway and Worker (06a / 06b)

Gateway uses the public Access, Projects, Issues and Wiki APIs. Its shared dispatch
catalog is in `gateway/catalog.ts`; `gateway/wire.ts` generates MCP tool descriptions
and OpenAPI paths from that catalog. REST routes use
`GET /api/w/:workspaceId/:owner/:action` for queries and `POST` with JSON for
commands. `GET /api/openapi.json` serves the generated description. Each command
needs an `operationId`; versioned commands also need `expectedVersion`. Module
APIs validate business inputs and enforce authorization, retry and CAS rules.

`POST /api/w/:workspaceId/access/create` creates a workspace for an authenticated
human. `GET /api/w/:workspaceId/access/workspaces` lists accessible workspaces.
Credential issue and revoke are REST-only at `access/credential.issue` and
`access/credential.revoke`. Issue requires a caller-generated, cryptographically
random 32-byte lower-case hex `secret`, plus `operationId`, `credentialId`,
`principalId`, `scope` and `expiresAt`. The response returns the bearer once with
`Cache-Control: no-store`. Retrying with the same operation ID and secret returns
that bearer; the Access receipt stores no secret. Revoke requires
`operationId`, `credentialId`, `expectedVersion`.

`POST /mcp/:workspaceId` supports MCP Streamable HTTP JSON-RPC initialize,
initialized notification, tools/list and tools/call using protocol version
2025-11-25. The server does not assign an MCP session ID; the protocol allows a
stateless server. Authenticated `GET` and `DELETE` return 405 because there is no server event
stream or session to close. Every request reauthenticates the bearer and
workspace. Credential issue/revoke are absent from the MCP catalog. Transport
errors map to HTTP status codes; tool execution errors return `isError` with a
JSON text block containing `{code,message}`. The request ID is returned in
`X-Request-Id`.

The Worker builds the scoped Platform adapters from D1/KV bindings once per isolate,
so Access can retain its short-lived trusted JWKS cache. It composes
Access → Projects → Issues/Wiki → Gateway, and keeps business rules in their
owners. `wrangler.jsonc` describes the D1/KV/R2 and Static Assets bindings with
placeholder resource IDs. Deployment stays disabled until approved resource IDs,
Access audience/domain, OAuth issuer/resource and the consent signing secret are supplied.
Step 06b adds the OAuth HTTP surface described below.

`tools/gateway.test.mjs` runs the real Worker fetch handler on Miniflare with all
production migrations. It covers REST/MCP parity for success, validation,
not-found, conflict, forbidden and unknown operations; idempotent retry, two
workspaces, read/write machine scope, cross-workspace token rejection,
header/path mismatch, size/content-type/Origin limits and request IDs. It also
uses a signed Cloudflare Access assertion through the Worker for workspace
creation/listing and credential issue/retry/revoke. The official MCP TypeScript SDK client initializes over
Streamable HTTP and creates/transitions/comments on an issue, edits a wiki page
and searches Japanese text. The project in that fixture is pre-created by a
workspace owner because the existing Projects contract reserves project creation
to workspace owner/admin while Access can provision machines only as
member/viewer. Owner resolution of that acceptance conflict is pending.

Access JWKS retrieval was corrected in this MR: workerd rejects `fetch`
`redirect: "error"` before making any request. The verifier now uses `manual`;
its existing non-2xx check still rejects redirects. The signed assertion Worker
test exercises this path.

The build injects only production catalogs into the Worker bundle after the
source catalog hash and SQL checks pass. The artifact check rejects fixture
names and verifies the production migration package.


## Step 06b OAuth HTTP

The canonical resource is **OAUTH_ISSUER + `/mcp`**, shared by all
`/mcp/:workspaceId` paths. Tokens remain confined to one workspace by Access.
`OAUTH_ISSUER` must be an exact HTTPS origin; `OAUTH_RESOURCE` must equal that
canonical resource. Composition rejects partial/inconsistent configuration.
`OAUTH_FORM_SECRET` is a secret binding of at least 32 characters (use 32 random
bytes encoded as hex), shared across isolates; never commit it or put it in vars.
Omitting all three disables OAuth. Metadata, OAuth and MCP requests must use the
configured origin; request Host/forwarded headers never select the token resource.
REST accepts interactive assertions and machine credentials, **not OAuth tokens**.

Routes follow [Access's HTTP contract](access.md#exact-gateway-http-contract-step-06).
Protected-resource metadata is served at the root fallback, `/mcp`, and
`/mcp/:workspaceId` well-known suffixes, all reporting the same resource. 401
challenges point to the canonical `/mcp` metadata; invalid credentials add
`invalid_token`. An Access `OAuthInsufficientScope` after live authentication and
membership checks gives HTTP 403 with `insufficient_scope` and `scope="read write"`.
Other authorization failures do not advertise an upgrade as a cure for lost access.
No management operation is added to the MCP catalog.

Consent GET displays the escaped client name, callback host, requested/granted
scopes and human workspaces. Changing workspace requires Review workspace; the
approve button explicitly names the workspace bound to the displayed grant.
POST requires the exact Origin, a Secure/HttpOnly/SameSite=Lax host cookie and an
HMAC-SHA256 envelope containing the original request, principal, workspace,
10-minute expiry, random cookie binding, operation ID and random code secret.
The Access handle is recreated inside POST and never serialized. Access stores
only the envelope hash, subject, workspace and expiry, and atomically deletes it
on consumption. Duplicate/concurrent POSTs have one winner even across isolates.
Nonce consumption precedes approval: after response loss or backend failure the
user starts fresh consent, not a replayed browser POST. The underlying Access
approval retains its operationId/idempotency contract. Signing-key rotation
invalidates outstanding forms without affecting OAuth tokens.

Rate admission uses Platform's narrow `RateLimiter` port backed by Cloudflare's
native rate-limit binding, with separate namespaces for register (10/minute/IP)
and token (60/minute/IP). Gateway uses the edge-provided `CF-Connecting-IP`; absent
addresses share the `unknown` bucket. Denial returns 429 + Retry-After before
calling Access, and limiter failure returns sanitized 503. Keys are bounded to
128 characters, with no attacker-sized application map or KV counters. The
bindings are required when OAuth is configured; `wrangler.jsonc` supplies sample
namespace IDs that deployment owners must reserve independently of other Workers.
[Cloudflare's native limiter](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
is approximate and local to a Cloudflare location, not an exact global quota.
Access's D1 registration caps remain the installation-wide durable bound. No
account resource is provisioned or deployed by this MR.

Bodies are limited to 32 KiB while streaming. Duplicate/unrecognized form fields,
ambiguous credentials and unsupported authentication methods fail closed.
Public OAuth/discovery endpoints allow noncredentialed CORS; consent has no CORS,
no third-party assets and CSP/frame protection. Consent pages use origin-only
referrers; callback responses use no-referrer. Responses are no-store.
Only `/oauth/authorize` belongs behind Cloudflare Access's interactive login.
Do not configure browser redirects on discovery/DCR/token/revoke/MCP routes, or
log authorization queries, cookies, assertions, codes or tokens.

Evidence: `gateway-oauth.test.mjs` drives the official TypeScript SDK through
401 discovery, DCR, signed-assertion consent, PKCE exchange, issue create/retry/
transition/stale CAS, refresh rotation and revoke on the real Worker in Miniflare.
It covers wrong redirects/PKCE, CSRF, one-time POST races, viewer read-only scope,
write scope challenges, cross-workspace/REST denial and admin client revocation.
Transport rule tests use public-provider contract fakes for parser/admission/error
behavior; Access-only D1 tests prove nonce confinement, restart, concurrency,
expiry and the 16-outstanding-forms-per-human/workspace cap. Browser display is
reviewed against this same Worker using a local test-assertion proxy.

The SDK test requests read/write for an agent that needs writes. A DCR client
registered with a read-only scope remains capped at read by Access; clients that
need later step-up must register with read/write (or omit the registration scope).
An HTTP scope challenge alone cannot enlarge that registered ceiling. Separate
Claude Code/claude.ai/Codex/Dots application acceptance and real Cloudflare smoke
remain deployment follow-up; SDK success does not establish those products' UX.
The current [MCP authorization specification (2026-07-28)](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
keeps DCR as a compatibility path; CIMD/confidential clients remain unadvertised.


Browser compatibility note: Chrome emits `Origin: null` for an HTML form POST
from a `Referrer-Policy: no-referrer` document. This was reproduced during the
06b Computer Use review. Consent pages therefore use `Referrer-Policy: origin`
(no path/query is disclosed); 303 callback responses use `no-referrer`. POST still
requires the exact configured Origin and rejects missing/foreign/null origins.
The page's CSP `form-action` allows self and only the Access-validated callback
origin, because browsers also enforce it on the form's redirect chain.
