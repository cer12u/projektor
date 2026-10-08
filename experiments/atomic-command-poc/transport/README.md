# Authenticated local transport proof

This directory adds a local-only signed-token profile to the shared atomic Issue command core. It is not a deployed Access integration and is not a generic JWT validator. A configured local public RSA JWK verifies a single algorithm, key ID, issuer, purpose-specific audience and token type. Tests generate the signing keypair in memory for each process; no private key or bearer token is written to evidence.

## Routes

- POST /machine/v1/workspaces/:workspaceId/commands, Bearer token, JSON envelope and matching Idempotency-Key
- GET /machine/v1/workspaces/:workspaceId/operations/:operationId?workspaceEpoch=…
- GET /machine/v1/workspaces/:workspaceId/issues/:entityId?workspaceEpoch=…
- GET /machine/v1/workspaces/:workspaceId/projects[/:projectId]?workspaceEpoch=…
- GET /machine/v1/workspaces/:workspaceId/issues/:issueId/entries?workspaceEpoch=…
- GET /machine/v1/workspaces/:workspaceId/issues/:issueId/revisions[/:revisionId]?workspaceEpoch=…
- The same paths without /machine accept only the custom local test session cookie. Unsafe human requests require exact configured request origin, exact Origin header and X-Projektor-Csrf: same-origin. No CORS permission is exposed. This does not issue cookies or implement Cloudflare Access assertion handling.

`ingress.mjs` is the public application handler. `workspace.mjs` has no HTTP handler: RPC identity input is trusted solely from its internal binding. Tests use a separate non-routed control service and test-only DO subclass to seed data, inspect SQL and inject postcommit response loss. There is no public SQL/seed/fault route. Never deploy that fixture class.

Issuer+subject+credential ID map to an immutable-for-this-slice local identity row. Lookup and the shared command call have no intervening await; DO request execution cannot interleave a revocation between them. The core performs current credential, membership and project authorization inside its transaction. The exact verified token expiry reaches that check. Signature validation does not grant a role. Public result and error responses are no-store.

The body reader enforces 2 MiB of actual bytes and a three-second deadline without trusting Content-Length. This accommodates 256 KiB of exact UTF-8 Markdown with worst-case JSON escaping. Issue.UpdateTitle retains its original 16 KiB envelope cap. New command payload validation is shared with the core; source is never truncated or normalized by the adapters. Core envelope validation retains 4096-byte title and version rules, including HTTP 428 for a missing version. Authentication rejects mixed sources, unknown protected headers and claim-controlled key retrieval. Unsupported requests return JSON errors; no login redirect or owner fallback is introduced.

## Run

Use Node >=24.19.0 with the pinned package-lock dependencies. `npm run test:transport` starts an actual Miniflare/workerd loopback server and sends Node fetch and chunked HTTP requests over TCP. `npm run test:all` also preserves the original 37 Node and 20 workerd regressions, plus client state tests. `npm run verify` records test evidence and source hashes.

The test profile chooses short-lived ephemeral claims solely as fixtures; no application session policy is inferred. Current DB revocation is immediate at the tested transaction boundary; provider-side revocation latency is not implemented or measured. Production key rotation/JWKS, real Access/OAuth, TLS/host policy, enrollment, MCP, encrypted draft persistence and other domain capabilities remain separate gates.

Current database revocation retains the frozen core's generic FORBIDDEN/403 instead of exposing whether membership, credential or a grant was removed. The client stops and never starts login recovery on that response. More specific machine CREDENTIAL_REVOKED diagnostics remain a separate provider/contract step; no privilege fallback is allowed. Database and JWT expiry map to CREDENTIAL_EXPIRED for machines and SESSION_EXPIRED for humans.

Recovery integration tests supply trusted synthetic initial/renewed session records directly. This slice has no GET /v1/session implementation or actual provider renewal adapter. They test operation/session coordination over the real command, receipt and resource HTTP routes, not production session bootstrap.

## Issue content slice

The command endpoint dispatches `Issue.Create`, `Issue.UpdateBody`, `Issue.Assign`,
`Issue.SetPriority`, `Issue.AddComment`, and `Issue.EditComment` in addition to the
unchanged title command. Create uses expectedVersion 0; EditComment uses the
comment ID/version while authorization and current-state rereads use its parent
Issue. No-op receipts can be committed with effectApplied false and unchanged
version. Receipt acknowledgment never substitutes for a current authorized GET.

The in-process REST/MCP adapters in `src/adapters.mjs` invoke the same core.
`mcpCommand` verifies the exact tool name/envelope pairing: issue_create,
issue_update_body, issue_assign, issue_set_priority, issue_add_comment, and
issue_edit_comment. Read tools are project_get/list, issue_get/list,
issue_entries_list, content_revision_get/list, plus existing my_issues and
operation_get. These are adapters, not a separately deployed MCP server.

Current entry reads and immutable revision reads are distinct. History requires
current and original audience/scope authorization plus history:read. Public
routes never accept SQL, actor overrides, enrollment, or test controls. All
Miniflare tests set cf:false and disable unmocked outbound HTTP; provider JWKS
responses are synthetic explicit mocks only.
