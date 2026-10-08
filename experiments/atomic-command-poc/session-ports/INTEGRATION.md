# I5 isolated session ports

Base is frozen I2 public head `5c76a7ac3770f2b9d88cf696eca0a58e91780b0d`. Only `session-ports/` is new; no common schema/entry/workspace/auth/transport file was changed. Copy the module directory intact alongside `client`, `browser`, `src`, `service`. Test fixtures are test-only.

## HTTP and client wire

- ARCHITECTURE §6 fixes the initial configured workspace registry maximum at **10**. Exactly 10 is accepted; 11 rejects with `WORKSPACE_DIRECTORY_UNAVAILABLE` (503) before any Store enumeration. No silent truncation. The client independently rejects responses with more than 10 workspaces as `PROTOCOL_ERROR`. A larger registry requires a separately designed read-model directory.
- `GET /v1/bootstrap` has no query. Result: `{principalId:UUID|null,actorKind:'human',workspaces:[{workspaceId,workspaceEpoch,principalId,name}],serverTime,expiresAt,renewalMode:'unknown',globalSessionExpiresAt:null}`. Zero memberships is normal. No automatic user creation. No global principal is fabricated when no mapping exists or mappings differ across Stores.
- `GET /v1/session?workspaceId=UUID` requires explicit selection. Flat `validateContentSession`-compatible session contains principal/workspace/epoch, human kind, current credential-bound sessionId, conservative authzVersion, scope intersection, expiry and serverTime. The selected Store reauthenticates; candidate directory entries grant nothing.
- `POST /v1/draft-keys` accepts exactly `{binding,keyId?}` with same-origin Origin and X-Projektor-Csrf. Binding fields: principalId, workspaceId, workspaceEpoch, resourceType (`issue|project|wiki`), resourceId, editorId, projectAtProtection (UUID; null only for workspace-shared Wiki), draftId. Response matches DraftVault: `{keyId,key,leaseExpiresAt,session}`. No token/cookie output. Key material is memory-only in the browser.
- `createSessionAPI({baseUrl,fetchImpl,deadlineMs})` exports bootstrap, session({workspaceId,signal}), keyProvider(binding,keyId). Reads include X-Requested-With, credentials same-origin, manual redirects, no-store, bounded response parsing. No implicit renewal or redirect loop.
- `createContentProtection` accepts existing IssueContent protection arguments plus optional keyProvider, resourceType, editorId. Use the selected API's keyProvider; preserve draftId/projectAtProtection from the recovery manifest across reload. Wiki callers must provide explicit original scope and resourceType rather than treating Wiki as an Issue.

## Shared-owner integration required

1. Add `session-ports/schema.sql` once through the shared schema/version owner. No migration has been applied to production. Raw server-side draft key storage is sensitive and excluded from ordinary exports/logs; approved encrypted backup/restore and key rotation are separate unpassed release gates.
2. Wire `createSessionHTTP` using the production verifier from `service/auth.mjs`, bounded configured workspace directory, existing origin policy and **private** invokeStore closure. Do not expose currentSession/draftKey as caller-supplied actor RPCs.
3. invokeStore forwards the original request credential to the selected WorkspaceService. That service checks its DO identity, configuration and schema, independently verifies the provider credential, then invokes currentSession/draftKey inside the **same synchronous Store transaction** as identity/credential/grant checks. Never accept a serialized verified actor from browser input.
4. The directory lists candidates only. Current membership and credential checks occur per Store on every bootstrap/session/key access. Unknown directory, uninitialized/fenced Store, ambiguous binding or Store timeout remain typed errors, not empty workspaces. Stale denied candidate memberships can be omitted; an expired verified provider credential rejects bootstrap before enumeration.
5. authzVersion conservatively reuses query_state.revision. Proposed scope/shared-grant triggers complete current ACL invalidation; this may invalidate on unrelated content writes, safely. Read current session on resume before showing protected content.
6. Draft key issuance is idempotent by full canonical binding; explicit missing keyId, revoked/expired keys, deletion, wrong principal/epoch and original-scope loss cannot create a replacement key for existing ciphertext. Every issuance checks current resource and original project/shared read authority. Lease <=5 minutes, current provider expiry, current DB credential expiry and key retention expiry.

## Human UI

`HumanWorkflowController` in `session-ports/human-workflow.mjs` extends the existing IssueContentController with title/progress/transition. Existing content modes and protected journal behavior are inherited. It does not use MachineWorkflowClient or claim APIs.

- title value `{title}`
- progress value `{bodyMarkdown}`
- transition value `{toStatus,reason,waitingFor,nextStep,resultSummary}`; flat text inputs become `reason:{text}` and `result:{summary,artifactIds:[]}` only at submission
- payloadVersion 2 progress/transition; CAS expectedVersion from draft; same saved envelope for receipt recovery and retries
- inherited four total sends, six receipt checks, 60-second deadline, retry floors, late-edit protection, explicit rebase, protected storage before send

Important implementation distinction: generic OperationCoordinator currently has a private memory-only journal and explicitly refuses navigation protection. This extension reuses the existing *protected IssueContentController journal*, not generic OperationCoordinator's private state. Consolidation into a shared persistent coordinator is not claimed done. Parent was notified. Unrelated MachineWorkflowClient is never substituted.

## Evidence and limits

Node SQLite, HTTP Request/Response client fixtures, real workerd SQLite (`cf:false`, outbound fetch denied) verify session, key policy, concurrency and human state behavior. Artificial provider and ephemeral synthetic keys only. Existing browser DraftVault code is reused, but a new end-to-end browser run against these new Store key ports is not yet evidence; UI owner integrates and tests it.

Official Cloudflare session docs were read on 2026-10-08: https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/ . They distinguish global and application tokens, describe reissue when global identity remains valid, and document X-Requested-With for expired AJAX 401. Those docs do not establish this application's live cookie/redirect/renewal/MFA/revocation behavior. Real Access tests, WCAG timing validation and navigation recovery remain NOT_RUN. No 24-hour remainder or infinite renewal was invented.

R08/CC17 receipt/history separation remains inherited from I2, not newly re-certified by this module. R10/R11 production wiring, all-editor browser coverage, provider renewal, key lifecycle backup/rotation, migration/deploy/cutover remain open.
