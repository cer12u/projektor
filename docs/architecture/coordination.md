# Coordination (step 08)

Coordination lets agents share an issue backlog. Start a session, acquire an issue lease, claim exact repository paths, work, report progress, and release claims and the lease. `endSession` releases that session's claims and leases. Issues remains the authority for issue state; `reportProgress` does not transition an issue.

## Contract

- Session labels and client kinds are descriptive (`codex`, `claude-code`, `dots`, or another client). A session belongs to the authenticated principal and workspace. Its default TTL is 120 seconds; `startSession` accepts 30–3600 seconds. Every call carrying the session ID extends its liveness while it is still live. A terminated or expired session cannot be revived; start a new ID. `listSessions` shows one's own sessions, or all sessions to workspace admins and owners.
- One issue has one current lease row. Acquisition is conditional on vacancy or expiry and atomically increments its persistent fencing token. The default per-project cap is three live leases. A project manager can set a cap of 1–100 with `expectedVersion`; an update cannot lower it below the current live count. Expiry is checked using the server clock on each command. `renewLease`, `releaseLease`, and `reportProgress` require the current session and fencing token. Reclaim records `release_reason=expired` and a `LeaseChanged` event. Stale tokens cannot write progress. A released or ended lease is available immediately.
- Claims match the exact repository and path string, including case. Paths are relative, use `/`, and are not glob patterns or directory locks. A call claims 1–20 distinct paths in one D1 batch; one conflict rolls back all its claims. The conflict names each contested path and holder session. A project manager with a current issue lease may force a claim. Each live contention records `FileClaimForced` with both the acting principal and displaced session; both can poll it through `coordination.readEvents`. Heartbeat and other live session calls extend existing claim expiry. Claims expire with the session unless released earlier.
- REST routes use `/api/w/{workspaceId}/coordination/{action}`. MCP tools use the same `coordination.{action}` catalog and validation. The commands are `start`, `heartbeat`, `end`, `acquire`, `renew`, `release`, `limit`, `claim`, `releaseFiles`, `report`; queries are `getLease`, `listLeases`, `listClaims`, `getProgress`, `listProgress`, `listSessions`, `readOperation`, `readEvents`. The latter returns events involving the calling principal or one of its displaced sessions. Internal consumers use the separate reader capability.
- Every command accepts an `operationId`. Receipts are unique by workspace, principal and operation ID, and bind the command and inputs to a stored result. Use the same ID to recover an uncertain outcome. A reused ID with different inputs conflicts. Cross-owner authorization uses Access, Projects and Issues public APIs on admission; no Coordination SQL reads or updates their tables. Admission before a concurrent revoke may still commit, per the approved Q1 contract.

The module owns `coord_sessions`, `coord_leases`, `coord_file_claims`, `coord_reports`, `coord_report_history`, `coord_limits`, `coord_receipts`, `coord_events`, and `coord_guards`. Coordination's migration is independently testable in Miniflare D1 with only its own schema. `tools/coordination.test.mjs` covers concurrency, fencing, expiry, WIP, claim atomicity, force events, restart, receipts, authorization and two workspaces. `tools/gateway.test.mjs` drives two official MCP SDK clients through the real Worker and checks REST query parity and the untouched Issues state. The local workerd result does not assert production D1 behavior; main-only Cloudflare smoke remains separately gated.

## Progress timeline (08a)

`reportProgress` still returns `Progress`, and `getProgress` remains a primary-key
read of the latest report in `coord_reports`. Each successful new operation also
appends an immutable snapshot to `coord_report_history` in the same transaction
as the latest row, receipt and event. A retry appends nothing. Fencing and live
issue authorization are unchanged; reporting never transitions the Issue.

`listProgress(scope, issueId, {cursor?, limit?})` returns `{items, nextCursor}`.
Items are `ProgressEntry` (`Progress` plus an issue-local increasing `sequence`),
newest first; the cursor is an exclusive sequence boundary. Default page size is
50, maximum 100. A null next cursor means no older retained row existed at read
time. Sequence ordering handles equal timestamps and new reports between pages.
Every page reauthorizes the issue in its workspace. REST query parameters and
MCP tool `coordination.listProgress` expose the same contract.

Keep the most recent **1,000 reports per workspace/issue**, pruning only the
oldest rows during the append transaction. This is a bounded operational timeline,
not permanent audit retention. Pagination does not pin old rows against retention;
a slow reader can miss rows pruned between pages. Retained rows are never edited.
The primary key `(workspace_id, issue_id, sequence)` serves keyset reads and tail
pruning. Receipts and events retain their existing lifecycle policy.

Migration `0002_progress_history.sql` copies each existing latest report as
sequence 1 without editing migration 0001 or removing the latest table. Already
overwritten reports cannot be reconstructed. No dependency edges change.
