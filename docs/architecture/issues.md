# Issues — Step 04

## Flow timestamps (UI restoration C5)

Migration `0006_flow_timestamps.sql` adds `ready_at`, `claimed_at`,
`in_review_at` and `review_bounce_count` to the owned issue row. Ready is stamped
when an issue first enters an open status past backlog; claimed is stamped when
it first enters the in-progress category; review entry is stamped on the first
review step. These three times are retained on later transitions. Leaving review
for a non-done status increments the bounce count. The status change, timestamps,
history, receipt and event share the command's guarded batch. An `updateIssue`
history detail now includes `statusId` when supplied.

The migration infers ready and claimed times only from older `transition` and
`status_category_changed` history records with a `to` category. It cannot infer
review entry or bounces from those records. Backfill includes frozen scopes via
the existing purge bypass and clears the bypass in the same migration batch.
`flowIssueRows`, `countDoneBefore` and paged `humanCommentCounts` are authorized,
workspace-scoped reads for Insights; the latter binds no more than 100 IDs per
page.

Issues owns issue rows, per-project counters, comments, versioned history, receipts,
outbox events, guards, and the FTS5 index. Its only dependencies are Access and
Projects public APIs. Tests migrate only Issues storage.

## Public contract

`createIssue`, `editIssue`, `transitionIssue`, `assignIssue`, `addComment`, and
`archiveIssue` take a caller-generated operation ID. Changes to an existing issue
also take its expected version. Results contain the stable issue ID, per-project
number, and resulting version. `getIssue` accepts an ID, project plus number, or
project plus `<PROJECTKEY>-<number>` reference; the key is checked through
Projects, never a cross-owner SQL join. `listIssues` uses descending issue-number
keyset pagination within one authorized project. `searchIssues` ranks FTS5 matches
within that project. History records actor ID, human/machine kind, and nullable
`clientId` from Access RequestScope. Comments and event payloads preserve the
same client attribution; OAuth human users remain human, machines remain machine.
The caller can render “via Claude Code client <id>” from this metadata. `readEvents`
requires a composition-issued reader capability.

Allowed transitions are `todo → in_progress/cancelled`,
`in_progress → todo/done/cancelled`, `done → in_progress`, and
`cancelled → todo`. Repeating a transition with a new operation ID is a conflict.
Archiving is terminal for new writes; old successful operations can still be
recovered with their original ID while project permission remains live.

Every command asks Projects for live write authorization at admission. Assignment
also asks Access for an active principal and Projects for that principal's live
workspace membership and project grant. This required the small
`ProjectsApi.authorizeProjectPrincipal` contract addition. A revoke completed
before admission blocks the next command; an admitted command may finish after
the revoke, as Q1 specifies.

## Storage and recovery

The counter update and issue insert are one D1 batch. A unique
`(workspace_id, project_id, number)` index protects the invariant. Every change
uses a versioned update and a `changes() = 1` guard, then replaces the FTS row
and writes history, receipt, and event in that same batch. A failed statement
rolls back all of them. Receipts bind `(workspace, principal, operationId)` to a
hash of command kind and canonical input. A retry reads the saved result after
authorization; different input conflicts. If the batch response is lost, the
receipt is checked and the same operation ID remains the recovery handle.

Search accepts up to twelve whitespace-separated literal substring terms within
256 UTF-16 code units. Punctuation-only terms are ignored; an empty term set or
more than twelve terms is a validation error. Terms containing letters/numbers
retain internal punctuation. FTS5 uses `tokenize='trigram'`; terms are quoted with
embedded quotes escaped, so operators remain literal. If any term is shorter
than three Unicode code points, named static query `searchShort` applies all
terms with AND via escaped LIKE to the authorized workspace/project's active
issue titles/descriptions. `%`, `_`, and `\` in terms are escaped. This path uses
15 bound values, returns at most 100 rows (default 20), and orders by descending
issue number. It scans the project subset; LIMIT bounds output, not worst-case
rows scanned. Longer-term searches retain bm25 ordering and number tie-breaks.
Japanese is substring-matched, not linguistically segmented; LIKE's case-folding
covers ASCII English, not general Unicode case equivalence. See
[SQLite trigram semantics](https://www.sqlite.org/fts5.html#the_trigram_tokenizer)
and [D1 search guidance](https://developers.cloudflare.com/d1/best-practices/use-indexes/).

Migration `0002_search_attribution.sql` preserves 0001, adds nullable client fields,
and recreates the FTS index from issue rows. Unknown historical clients remain
null. Operation IDs remain principal/workspace scoped; a later retry through a
different client returns the original result without changing its attribution.
`IssueHistory.clientId` and `IssueEvent.payload.clientId` are additive fields on
the existing event schema version 1.

List cursors must be canonical positive decimal strings; non-string assignee
filters are rejected. Limits are 1–100 and filters apply before pagination.

 The virtual table and its five SQLite
shadow tables are registered to Issues. The SQL checker verifies their presence,
allows only FTS5, and rejects another owner's virtual or shadow reads. FTS rows
are replaced on edit and marked archived in the same batch as the issue row;
search excludes archived issues.

Miniflare tests prove concurrent number allocation, stale-version rejection,
idempotent replay and conflicting reuse, response-loss recovery, rollback of
body/search/history/receipt/event, two workspaces and projects, revoke at next
admission, machine actor history, and search after edit/archive. This is local
workerd evidence; real-account D1 smoke remains a later gate.

The independent [04a audit](test-audit.md) records every public API invariant,
provider-fake checks and executed mutations. A Q1 admitted write can durably
commit after revoke while its post-commit receipt recheck denies the response;
recovery requires restored current permission.

## Lifecycle maintenance (13)

See [Lifecycle](lifecycle.md) for owner-local atomic freeze, bounded purge, retained
markers, project attribution, REST-only owner access and recovery limits.

## C2 tracker model

Migrations `0004_tracker_fields.sql` and `0005_definitions_links.sql` are additive. The first
backfills issue timestamps and creator from the earliest history row and updates the old priority,
status and comment fields, including frozen scopes through a transaction-local purge bypass. The
second adds workspace status and type definitions, issue links, and definition command receipts and
history. Migration checksums are recorded in `platform_schema_versions`. Production must apply both
migrations through the operator migrator before updating `CF_APPROVED_SCHEMA_SHA256`.

Issues now expose their status key and ID, category (`state`), optional type and parent, labels,
creator, and epoch-second creation, update and completion times. `priority_level` is the public
priority; the old `priority` column is maintained only to satisfy its historical constraint (`none`
is stored there as `low`). The first issue write or definition write in a workspace seeds the six
built-in statuses and four built-in types in the same batch. Until then, list reads return those
built-ins without writing. Issue creation uses the workspace's default status and no type unless
specified. Changing a status category updates its issues, their versions, history and outbox events
in the same batch. Reopening clears `completed_at`; entering done stamps it.

C6 migration `0007_done_at.sql` adds write-once `done_at`, backfilled from the earliest recorded
entry into a done category or from `completed_at`. Reopening clears `completed_at` while retaining
`done_at`; flow metrics use the latter. The backfill temporarily bypasses freezes and clears the
bypass marker in the same migration batch.

`updateIssue` changes selected fields in one version bump and validates the status, type, parent
chain, and assignee at admission. `queryIssues` searches all visible projects when `projectId` is
absent, supports the tracker filters, and pages by `(created_at DESC, id DESC)`. Its JSON array
filters use static recursive CTEs with `json_extract`: the schema ownership checker currently
rejects `json_each` as an unowned table-valued source. This retains one JSON bind per array and
does not add dynamic SQL. `getIssuesByIds` accepts at most 100 IDs and checks
each distinct project. Its optional archived-project mode supports Planning's
bounded sprint-item read and omits IDs whose project is no longer visible;
archived issue rows remain readable for historical sprint display. `childRollups` reports counts by
category.

Comment edits and deletes bump the issue version, keep the full command receipt and history
pattern, and require the comment author for edits or the author or workspace admin for deletion.
Link creation canonicalizes inverse and symmetric types, checks write access to both issues, and
bump the source issue version. Lists return each visible link in either direction with the linked
issue's reference and status. Lifecycle purges links before issues and removes workspace definitions,
their receipts and history when the whole workspace is purged.

## UI restoration reads (C3)

`queryIssues` and `countIssues` apply the same workspace, visible-project and
filter predicates. The count omits pagination, so the UI sends `total` only on
its first page. `countIssuesByProject` accepts at most 100 authorized project IDs
and counts open (`state` other than done/cancelled) and backlog issues for the
project list. The caller chunks longer visible-project lists. Search accepts the
same all/any label filter as the issue list; both SQL statements remain static.
These reads do not add migrations or storage resources. `createIssue` also accepts
an optional assignee and checks that principal before its existing atomic batch, so a
UI create request cannot leave an unassigned issue after assignment fails.

## C7 due date and estimate

Migration `0008_due_estimate.sql` adds nullable `estimate` (0–1000) and `due_date`
(`YYYY-MM-DD`, a calendar date with no time zone) to issue rows, plus a workspace/date
index. Insert and update triggers reject out-of-range estimates and malformed dates.
There is no backfill; existing issues retain nulls, including frozen scopes.
`createIssue`, `editIssue`, and `updateIssue` include both values in the receipt
fingerprint and history detail, with the row, guard, receipt, history, and event in
one batch. Null clears either value. Reads expose both fields.

`queryIssues` and `countIssues` accept inclusive due bounds, an overdue flag,
and a due-date-presence filter. The caller supplies `today` as a bound calendar
date for overdue filtering; done and cancelled issues are excluded. The default
created-time order and cursor are unchanged. `sort: "due_date"` uses ascending
date with nulls last, then descending creation time and ID, and a separate
`d:<date-or-~>:<created-at>:<id>` cursor.
