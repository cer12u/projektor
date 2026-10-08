# Local recovery contract experiment

`recovery.mjs` is a **memory-only**, single-client-context operation/session coordinator. It is not a browser application, provider enrollment, encrypted DraftVault, persistent operation journal, or production authentication client. No code writes browser storage, persists plaintext, opens a login window, navigates, or reloads the page.

## Exports and use

```js
import {createFetchTransport, SessionCoordinator, OperationCoordinator} from './recovery.mjs';

const session = new SessionCoordinator({
  // Must be supplied by a verified session source, not client-decoded JWT claims.
  initialSession: {
    principalId, workspaceId, workspaceEpoch,
    actorKind: 'machine', // or 'human'
    scopes: ['issue:read', 'issue:write'],
    expiresAt: expiryMilliseconds,
    token: signedToken, // machine transport; held in memory only
  },
  // Optional integration seam, not a provider implementation. Human only.
  // renewSession: async ({previousSession, signal}) => ({kind: 'authenticated', session: verifiedSession}),
});
const transport = createFetchTransport({baseUrl: 'https://app.example'});
const operations = new OperationCoordinator({
  session, transport,
  resourceProjectId: authorizedInitialResource.project_id,
  initialDraft: {title: 'Edited title'},
});
const result = await operations.submit({
  schemaVersion: 1, workspaceId, workspaceEpoch,
  operationId: crypto.randomUUID(), commandType: 'Issue.UpdateTitle',
  entityId, expectedVersion,
  payload: {title: 'Edited title'},
});
// If result is ambiguous/auth-required, the operation remains unresolved.
// This continuation does not create a new ID or send newer editor input.
const recovered = await operations.recover();
```

`initialSession` requires `principalId`, `workspaceId`, `workspaceEpoch`, `actorKind`, `expiresAt` in milliseconds, and a `scopes` string array. One shared `SessionCoordinator` provides local single-flight renewal to its operation lanes. Machine sessions never invoke human renewal. Expiry is observed when the coordinator is called; there is no browser visibility timer in this experiment.

Renewal callback results are `{kind:'authenticated', session}`, `{kind:'interaction-required'}`, `{kind:'forbidden'}`, or a failure with `code`. Each observed auth epoch permits one bounded noninteractive renewal attempt. A timeout/network/infrastructure failure is `recovery-stopped`, not proof that interaction is required. A changed principal, workspace, or actor kind stops recovery and clears retained editor/command plaintext. A workspace-epoch change or scope expansion for the same identity stops under the prior binding and preserves the unresolved ID and retained input while locked; it does not accept the new scope or retry. An accepted scope reduction becomes the next renewal's ceiling. No source is implemented for verifying or changing these session values in a real browser.

`createFetchTransport` performs one HTTP attempt per call. Defaults are:

- POST `/machine/v1/workspaces/:workspaceId/commands`
- GET `/machine/v1/workspaces/:workspaceId/operations/:operationId?workspaceEpoch=…`
- GET `/machine/v1/workspaces/:workspaceId/issues/:entityId?workspaceEpoch=…`

Use `prefix:'/v1'` for the human route, or `paths:{submit,receipt,resource}` functions for alternate same-origin paths. `fetchImpl` and `getToken` are injectable. Human submit requests include the local ingress profile's fixed `X-Projektor-Csrf: same-origin` header, use same-origin cookies, and never send a machine Bearer token; actual cookie/session lifecycle must be supplied by an appropriate browser adapter. This fixed header is not a secret CSRF token or credential. This module does not provision credentials or assert that provider refresh works. Redirects are manual, credentials are same-origin, and Ajax requests include `X-Requested-With: XMLHttpRequest`. Cross-origin endpoints are refused before reading a token. Only a redirect to an explicitly configured `authRedirectOrigins` origin is treated as an auth response. Generic HTML, JSON parse failures, and unavailable auth infrastructure remain distinct from expired authentication.

## Operation/editor contract

- `edit(payload)` increments the live input revision without changing any submitted command
- `prepare(command)` snapshots the command in memory before I/O. Its payload must match the current draft, so stale input cannot acknowledge a newer revision. A caller should generate a UUID for each new logical intent
- `submit(command)` prepares and sends once; `prepare(command)` followed by edits and `submit()` intentionally sends the older prepared snapshot while retaining those later edits
- `recover()` never submits an unsent prepared command. For a submitted command, it renews if needed, reconciles the original ID, revalidates the resource when required, and only then retries the original immutable command
- A committed receipt must match principal, workspace, operation, and entity. A late response after an observed auth epoch change cannot acknowledge any input
- A receipt-reconciliation failure stops conservatively without resending. `not_observed` is not proof of non-execution; an allowed resend uses exactly the same ID and command
- After auth loss, same identity alone cannot unlock input. Current resource read authorization must succeed, its entity ID must match, and its project must equal the original `resourceProjectId`. A moved resource or missing original project remains locked pending a richer authorization flow
- A rejected receipt after renewal follows the same revalidation before restoring the still-dirty draft. Current server resource data is exposed separately as `operation.latestResource`; there is no automatic merge, rebase, or draft overwrite
- A 401, 403, `KEY_REUSE`, or epoch rejection does not prove an earlier write had no effect. Only a rejected receipt with explicit `outcome:'rejected'` and `effectApplied:false` can mark rejection. Unreceipted definitive blocks retain an unresolved operation and prohibit replacing it with a fresh ID
- `snapshot()` redacts draft, receipt body, and latest resource while locked. Later edits are never cleared by acknowledgement of an older snapshot
- `cancelRecovery()` bounds the waiting call and ignores its late I/O completion. `dispose()` aborts and drops local state

Defaults are 15 seconds per submitted attempt, 5 seconds for session/receipt, up to 3 same-ID resends, up to 6 receipt reads, and a 60-second recovery wall budget from the first submission. Retry waits use full jitter with 1/3/10 second ceilings and honor longer `Retry-After` values. A server minimum beyond the wall budget stops recovery and retains `nextAllowedAt`. Counts and wall start are not reset by repeated `recover()` calls **within this memory-only instance**. No reload-survival claim is made. Budget/deadline/random/sleep dependencies can be injected for deterministic tests.

For HTTP 429/5xx with a valid `Retry-After`, status and headers settle the attempt as unavailable immediately; error-body parsing is deliberately skipped. This preserves the observed retry minimum even when the body is malformed or never completes, including under the coordinator's outer attempt deadline. Such responses do not retain a more specific error code from their unparsed body.

`prepareRecovery()` always returns `{kind:'protection-failed', code:'MEMORY_ONLY', mayNavigate:false}`. Draft and journal state disappears on process/tab loss. Its plaintext remains in memory while locked to support same-principal recovery and is not protected against XSS, a debugger, or a compromised runtime. There is no claim of crash recovery, remote erasure, cross-tab locking, bfcache protection, or durable key management.

## Verification and remaining gates

Run `node --test client-test/*.test.mjs` from the experiment root. Tests cover HTTP classification/deadlines, lost responses, immutable snapshot retry, latest input preservation, same-ID concurrency, renewal single-flight, expiry, changed identity/scope/project, machine expiry, denied access, cancellation, and in-memory budget retention. Parent HTTP tests exercise the same exports against the actual local workerd ingress.

Not implemented or verified here: real provider/browser sign-in and renewal; secure cookie/CSRF integration; IndexedDB encryption/read-back protection; draft-key authorization; persistent retry budgets; tab groups/BroadcastChannel/Web Locks; resource moves with separately verified original-project grant; navigation manifests/watchdogs; pageshow/visibility/bfcache; accessibility timeout extension; deployment and production credential enrollment.
