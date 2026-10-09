# Existing API-token continuity candidate

This local candidate preserves d398 API-token authentication while domain reads and
writes go through the current WorkspaceService and Store. It does not activate
production access, issue a secret, create authorization rows, or implement OAuth.
The old `/mcp/{workspaceId}` tool contract is a separately reviewed adapter; this
authentication change alone does not claim old endpoint or tool compatibility.

## Operator configuration

`LEGACY_API_TOKEN_AUTH` absent disables this mode. The only enabled value is
`d39852-api-tokens-v1`; all other defined values fail closed. Enabled mode uses the
existing `DB` D1 binding. No additional D1 database or identity provider is created.
The release profile must retain the independently attested existing D1 identity.
An explicit bounded `MCP_RATE_LIMIT_CONFIG` is required when this mode is enabled.
Serialized MCP `null` is permitted only when this setting is absent and Access
`machineAudience` is explicitly null.

## Authentication and authority

The original bearer is SHA-256 matched inside a prepared, read-only D1 query. The
query projects only credential/principal IDs, scope storage, expiry, provenance and
selected-workspace membership. It never selects email, name or token hash. No
last-used update, provisioning, enrollment, credential insertion or scope write is
performed. Missing/deleted or ambiguous source rows deny; source errors are 503,
not invalid-credential responses and never trigger fallback.

Source scope parsing preserves JSON arrays and historical `[read,write]` strings.
`write` implies read, `*` permits those two capabilities, and unknown strings grant
nothing. Workspace-scoped tokens remain confined. Global PATs require membership
in the requested workspace. Expiry uses source epoch seconds and is checked after
the asynchronous read. A source null expiry is represented internally by
Number.MAX_SAFE_INTEGER, still intersected with the current Store expiry.

The source `users.id` and API-token UUID remain unchanged. A human-owned bearer has
`principalKind: human` and `actorKind: machine`: existing human membership is
preserved while human session, bootstrap and draft-key paths stay inaccessible.
Only immutable source `issued_by_user_id != user_id` identifies a delegated
machine. Its source membership must remain member, its token must be workspace
scoped and have a finite future expiry, and every stored scope must be read/write.
A human owner/admin is not downgraded merely for using a PAT.

Each Store request requires the exact existing credential ID and principal pair.
It cannot borrow a human Access credential or authenticate an unstored token.
Current credential/membership revocation, epoch/fence, expiry, scope rows and
project/resource ACL remain authoritative in the Store transaction. Live legacy
capabilities additionally narrow stored can_read/can_write and domain scopes.
Reviewed domain scopes are issue/wiki read/write, comment write, history/deleted
read, own-operation read, and claim/progress/transition write. Human-owned bearers
can use Wiki trash/restore only with current explicit lifecycle and scope-manager
grants. Delegated machines cannot administer scopes. `resource:manage` and unknown
or future scopes are deliberately unsupported by this adapter.

Provider Access JWTs retain their unchanged signature/audience verifier. OAuth
colon-delimited tokens reject until the pinned provider can validate them; no
identity is derived from an unverified OAuth token. Access cookies plus bearer requests reject. A co-present Access service assertion
must independently pass the existing provider's JWKS signature verification,
issuer, existing human application audience, service-claim and time checks. This
uses the same bounded verifier implementation and does not enable standalone
Access machine authentication when machineAudience is null. The Access service
identity is never used as a business principal: only the independently verified
D1 bearer supplies that mapping. Request expiry is bounded by both proofs.
Invalid signatures, human claims, malformed or expired assertions reject; an
invalid D1 bearer never falls back to Access. Caller identity headers and command actor
objects cannot supply authentication.

The source verifier runs at ingress and again in WorkspaceService immediately
before dispatch. D1 credential validity is an admission-time observation; the
Store performs its own current authority checks synchronously at commit. There is
no claimed distributed atomic transaction between D1 and the Store, and no legacy
authorization result is cached across requests.

## Evidence

`service-test/legacy-bearer.integration.test.mjs` uses actual local Miniflare D1 and
workerd with generated synthetic credentials and network disabled. It covers the
same human principal through pk/PAT read/write and receipt replay, actual MCP
calls, unchanged source snapshots, missing Store credential without enrollment,
live source downgrade/expiry/deletion, workspace/global membership checks, Store
revocation/kind/current ACL, denied human/OAuth/forged-context requests, human
owner versus delegated-machine lifecycle authority, and unavailable source.

Source contract: cer12u/projektor at
`d39852cef35217bc1dbf4c42d646bda1f09994d3`,
`apps/api/src/middleware/{auth,workspace}.ts` and
`apps/api/src/auth/{scopes,machine-token}.ts`.
