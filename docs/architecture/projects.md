# Projects module (step 03)

Projects owns project identity, direct principal grants, archive state, operation receipts, and immutable event records. It depends on Access only through `modules/access/public.ts`. Composition gives it an owner-bound `ModuleStore`; it does not use KV or R2. The schema can be migrated and tested without Access tables.

## Public behavior

- `createProject` requires a workspace owner or admin with live Access write admission. A project has an opaque ID, a display name, and a key of 2–16 ASCII letters/digits beginning with a letter. Keys are stored uppercase. The database also enforces `(workspace_id, project_key COLLATE NOCASE)` uniqueness, including concurrent create and rename. No separate slug is needed; clients can use the stable project ID.
- `renameProject` changes name and optionally key. `archiveProject` marks the project archived; it never deletes project data. `grantProjectRole` and `revokeProjectRole` change direct grants. All edits use the project version as CAS and increment it, including grant changes. A grant cannot be repeated unchanged with a new operation ID.
- Project roles are `manager` (manage grants and edits), `editor` (write), and `viewer` (read). Workspace owner/admin is implicitly manager. Access still caps writes by live membership and credential/OAuth scope. Machine principals and human principals using OAuth clients can receive direct grants. A grant is active only while Access accepts that principal in the workspace.
- `getProject` and `authorizeProject` return `not_found` for a nonparticipant, foreign tenant, or archived project. `listVisibleProjects` uses project ID as a keyset cursor and returns at most 100 active projects per page. It performs Access admission on each call. `readOperation` checks current project visibility before returning a receipt. Event reads require the composition-held reader capability.
- Every command has an operation ID unique per `(workspace, principal)`. A retry with the same input returns its stored result after live admission; reuse with different input is a conflict. Business update, CAS guard, receipt, and versioned outbox/history event share one D1 batch. An unrecoverable batch result is `unknown`; retry the same operation ID.

`ProjectChanged`, `ProjectArchived`, and `ProjectGrantChanged` are schema version 1 events. A grant event uses the project as aggregate, so its `aggregateVersion` is the new project version. The outbox has no consumer state in this step.

## Limits and later integration

The selected Q1 policy allows an already admitted operation to commit after a concurrent Access or grant revoke. Every new operation rechecks Access and the Projects grant. Gateway, Issues, Wiki, and Coordination will use this public API in later steps; this step introduces no routes or UI. Hard purge belongs to a later Lifecycle module. The current storage test uses Miniflare D1, not a deployed Cloudflare database.

## Step 04 consumer contract addition

`authorizeProjectPrincipal(scope, projectId, principalId)` checks an assignee's
live workspace membership and project visibility through Projects-owned grants.
Issues uses this public method before assignment; it never reads Projects tables.
