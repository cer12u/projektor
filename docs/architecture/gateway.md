# Step 06a Gateway and Worker

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
stateless server. `GET` and `DELETE` return 405 because there is no server event
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
Access audience/domain and OAuth issuer/resource values are supplied. OAuth HTTP
endpoints, consent UI, OAuth client E2E and OAuth challenge headers are step 06b.

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
