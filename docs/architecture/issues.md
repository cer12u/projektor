# Issues — Step 04

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
within that project. History records actor ID and human/machine kind. `readEvents`
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

FTS search input is reduced to at most twelve Unicode letter/number tokens and
each is quoted as a literal FTS phrase. The virtual table and its five SQLite
shadow tables are registered to Issues. The SQL checker verifies their presence,
allows only FTS5, and rejects another owner's virtual or shadow reads. FTS rows
are replaced on edit and marked archived in the same batch as the issue row;
search excludes archived issues.

Miniflare tests prove concurrent number allocation, stale-version rejection,
idempotent replay and conflicting reuse, response-loss recovery, rollback of
body/search/history/receipt/event, two workspaces and projects, revoke at next
admission, machine actor history, and search after edit/archive. This is local
workerd evidence; real-account D1 smoke remains a later gate.
