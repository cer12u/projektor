# Planning (step 10)

Planning owns `planning_sprints`, `planning_items`, `planning_history`, `planning_receipts`, `planning_events`, and `planning_guards`. Its only business dependencies are Issues and Projects public APIs; it reads and writes no other owner's tables. The partial unique index `planning_open_issue` permits one issue in at most one open sprint per workspace. Project and issue IDs remain opaque.

`createSprint`, `scheduleIssue`, `unscheduleIssue`, and `closeSprint` authorize at admission. Scheduling requires a live, visible issue in the sprint's project. The sprint version is the CAS token for item changes. Each command batches membership, version, history, operation receipt, and event. A retry with the same operation ID and input returns the saved result; reusing it with different input conflicts. A stale version or duplicate active membership rolls back the batch. Closing a sprint deactivates its unique-index memberships but keeps its items visible as history. Planning never updates Issues.

`listSprints` and `getSprintItems` return authorized sprint data. Item state is fetched on every read from Issues, so state changes appear without a Planning projection. Archived issues and projects remain visible to previously authorized readers with `archived: true`; their Planning controls are read-only. An unavailable issue has a null issue body and an archived marker. A lost project grant still denies the whole sprint read. These semantics required narrow `getIssueIncludingArchived` and `getProjectIncludingArchived` public queries in the provider owners. They reuse each provider's authorization and expose no storage capability. This is the Step 10 dependency-contract addition to the one-module implementation rule.

The Gateway catalog exposes sprint create/list/items/schedule/unschedule/close and operation recovery through REST and MCP. Web provides a project-scoped sprint view with live issue state and scheduling controls. `readEvents` is a capability-gated outbox API for later owner composition and is not exposed to untrusted transport callers.

Miniflare tests run only Planning migrations with Access, Issues, and Projects public contract fakes. Worker transport parity uses the actual providers and D1. The owner boundary checker rejects SQL reads of Issues/Projects tables from Planning. No velocity, burndown, or Insights projection is introduced.

Step 10a audit: item reads use an issue-ID keyset page (`cursor`, `limit`, default
50, maximum 100) and return `nextCursor`. SQL fetches at most `limit + 1` IDs;
only the returned page is resolved through Issues, exactly once per item. The
extra ID determines whether another page exists and is not resolved. REST and
MCP accept the same optional page fields; Web offers next/first page navigation
and resets the cursor when the selected sprint changes. Pages are live reads,
not a snapshot across concurrent membership changes. This bounds the previously
unbounded provider fan-out without silently hiding the remainder of a sprint.

Access is also a declared direct dependency for live scope admission (as already
implemented in step 10); Issues and Projects remain the only business-data
providers. The step 10a audit and reproducible mutation runner are documented in
[test-audit.md](test-audit.md).

## Event attribution (11a)

New outbox events use schemaVersion 2 and `payload.clientId` from RequestScope (nullable), alongside the actor ID. Existing version-1 rows keep their original data and read with null client attribution. Consumers must accept both versions.

## Lifecycle maintenance (13)

See [Lifecycle](lifecycle.md) for owner-local atomic freeze, bounded purge, retained
markers, project attribution, REST-only owner access and recovery limits.
