# Manual receipt recovery correction

## Finding

The frozen I2 IssueContentController applied the original six-check/60-second automatic recovery budget to every Check button click. Unknown operations could therefore become impossible to inspect after reload or reauthentication, despite durable receipts.

## Contract

- Existing `checkResult()` is the explicit user Check action and delegates to new `checkManually({signal})`.
- `checkResult({retry:true})` remains the original bounded exact-envelope retry path. Its four total sends, six receipt checks and original 60-second deadline are unchanged.
- Manual checks have a separate persisted `journal.manualReadBudget:{startedAt,count}`. Each explicit click permits one receipt GET; at most three within a fixed 60-second window. Exhaustion returns `manual-budget-exhausted` with nextAllowedAt. The window can refill later without resetting original command counters/timestamps.
- Manual checks fetch a current selected-workspace session first, compare principal/workspace/epoch/human kind, and refuse scope expansion. A different identity erases the old in-memory editor record. Server receipt GET remains responsible for current membership/credential/resource/original-scope authorization. No write or history scope is added as a prerequisite. An observed authzVersion/sessionId/scope change immediately locks and clears cached keys before draft reuse; the existing Verify/revalidate action performs fresh key/resource verification, after which the same manual receipt action is available.
- The original saved operationId and complete envelope are passed only to `readReceipt`; no submit/dispatch, new ID or retry is called by the manual path. `not-observed` and network failures remain unknown. Definitive receipts reuse existing binding validation and late-edit acknowledgement logic.
- Session and receipt reads each have a five-second deadline. The full explicit check, including journal protection/current-resource refresh, is bounded to 30 seconds. Timeout/abort locks and invalidates late work; callbacks cannot resurrect content after identity change/hide/dispose. Busy state suppresses concurrent clicks.
- The separate read budget is protected before the receipt request. Reload/restoration retains it. Subsequent user actions after the minute can retry read-only; no timer, automatic poll or retry is scheduled.

## Integration

Apply `RECEIPT-RECOVERY.patch` at the existing atomic-command-poc root, or replace only `client/issue-content.mjs` with the reviewed file. Keep `client/recovery.mjs` unchanged. HumanWorkflowController inherits this fix through its existing IssueContentController import. UI Check buttons already call `checkResult()`; Retry buttons must continue to pass `{retry:true}`. Do not wire a timer/poller to `checkManually`.

Run `node --test client-test/manual-receipt.test.mjs` and the normal aggregate. The tests use synthetic memory protection and synthetic transport/session values, including absent write/history permission, saved-journal revalidation, exact command stability, no submits, concurrency, denial, identity switch, page hiding, abort and ignored-abort deadlines. This is not new provider or production/browser evidence.

Original I2, session-ports checkpoint and Artifact code are not modified by this patch. Deployment/migration/Access changes are outside this repair.
