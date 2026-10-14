# Lifecycle (step 13)

Lifecycle owns `lifecycle_jobs`, `lifecycle_steps`, `lifecycle_receipts`,
`lifecycle_guards`, `lifecycle_history`, and `lifecycle_events`. Its dependencies
are exactly the nine data owners plus Platform. It never reads their tables.

## Commands and access

The REST-only operations are `lifecycle.requestPurge`, `lifecycle.resumePurge`,
and `lifecycle.getPurgeStatus` under `/api/w/{workspaceId}/lifecycle/…`.
No Lifecycle operation appears in the MCP tool catalog. Both commands require
an interactive human workspace owner; admins, machines and OAuth principals
are rejected in Lifecycle itself. Request requires an exact `confirmation`
equal to the workspace or project ID, `operationId`, and `expectedVersion: 0`.
Resume requires the job ID, operation ID and observed job version. There is one
permanent job per scope. Reused operation IDs return their immutable result for
the same fingerprint and conflict for a different request. Refresh status to
observe later progress. A stale CAS creates neither receipt nor history.

Gateway passes the authenticated principal to Lifecycle, which performs live
membership checks. When Access is being purged or has been purged, only the
original requesting human can read that workspace job's status without its
now-deleted membership. Access still verifies the principal's provenance and
interactive identity. This is a receipt-reading entitlement, not permission to
write to the deleted workspace. Project status continues to require workspace
ownership, even after project metadata has gone.

The Web workspace and project administration sections provide typed confirmation,
status refresh and resume. Archive is unchanged. No delayed purge schedule or
soft-delete feature is introduced.

## Durable protocol

The Worker `scheduled` handler advances Lifecycle on a dedicated minute cron.
The existing hourly cron also advances it before ordinary GC, webhooks and
Insights consumption; those unrelated jobs keep their hourly cadence. This
cron resumes existing user-requested jobs and never creates a purge request. Each tick handles at most 10 jobs, one durable
transition each; it does not enumerate Access workspaces, so deleting membership
cannot lose a job. Failures record a bounded generic error and retry after 30
seconds. Resume makes the job eligible again; it does not execute deletion in
an HTTP request. Concurrent ticks use CAS, and every owner operation is idempotent.

1. Call each owner's composition-only `maintenance.freezeScope` and observe its
   `purgeStatus`. The owner persists its own frozen marker. Pending external
   operations must drain before the global acknowledgement barrier opens.
2. Only after every owner has acknowledged, enter the purge phase.
3. Persist each owner's purge intent, call `purgeScope`, and observe its status.
   The order is Integrations, Insights, Planning, Assets, Coordination, Wiki,
   Issues, Projects, then Access. Project purges omit Access because it owns no
   project-scoped data.
4. Complete only when every owner reports `purged`, zero remaining rows and zero
   pending work. History and events commit with each Lifecycle transition.

A crash before or after a provider effect repeats that provider operation. A
crash before or after the acknowledgement transaction repeats or advances the
transition from durable state. Parent metadata survives until its children have
finished; Access runs last for a workspace.

## Owner storage and freeze

Every owner's factory returns a typed maintenance capability separate from its
ordinary API. Only composition passes these capabilities to Lifecycle. Negative
boundary fixtures reject Gateway imports of every owner factory. SQL ownership
checks still compile all queries, triggers and migrations against both isolated
and combined schemas.

Owner-local freeze triggers reject inserts, updates and public deletion paths
inside the same D1 transaction as the business change, including writes admitted
before the marker was committed. A committed receipt may still be replayed:
that returns a previous result and writes nothing. The purge implementation uses
only its owner's static catalog. Where deletion triggers exist, its bypass row
is inserted and removed within the same batch; it is never a persistent bypass.
Markers remain after completion to prevent delayed writes recreating data.

Deletion is bounded to 50 rows per table per call, and parent rows are retained
until dependent rows have gone. Project attribution is persisted with receipts,
history and events so deleting the parent cannot lose the scope predicate.
Workspace-wide records such as Coordination sessions and Insights cursors are
retained for a project purge. Global Access identity, OAuth registration and the
installation bootstrap latch are retained; they are not workspace authorization.

Assets keeps a durable GC job, deletes R2 first, then removes the blob and GC
receipt. A failed R2 delete cannot acknowledge completion. Its purge handles at
most 10 blobs per call. Upload admission is recorded in Assets D1 before the R2
write. Freeze waits for admitted uploads; an upload completing across freeze
deletes its object before releasing admission. Ordinary GC skips frozen scopes.

## Upgrade and external-operation limits

New project-attributed writes are covered. Migrations backfill attribution from
an owner's own surviving parent rows. Some pre-step-13 rows cannot be attributed:
Insights subscriptions/notifications or activity without a surviving source
mapping, Integrations history that never recorded an aggregate, and Assets
receipts/events whose blob was already collected. A project purge must not guess
which project owns these records. Owners report unresolved rows as `pending`
instead of falsely reporting completion; a workspace purge can delete them.
The no-importer owner decision remains in force. Existing-data attribution needs
an explicit operator-supplied mapping or a separately reviewed reconciliation.

D1 and R2 do not share a transaction. A Worker crash during an admitted upload
can leave its durable admission unresolved. This implementation deliberately
keeps purge incomplete rather than expiring admission and allowing a late R2
write to resurrect the object. Automatic resolution of such ambiguous uploads
needs an upload protocol with a reliable external completion fence. The same
D1 freeze cannot retract a webhook HTTP request already sent before freeze;
its delayed local state update is rejected, and no new delivery is admitted.

## Evidence

`maintenance-core`, `maintenance-derived` and `maintenance-assets` tests use
Miniflare with owner migrations and two workspaces/projects. They cover bounded
FK-safe deletion and already-admitted public commands stopped before commit,
frozen atomically and then resumed. Assets tests cover real R2 objects,
deletion failure/retry, active upload compensation and persistent GC receipts.
`lifecycle.test.mjs` uses only Lifecycle migrations with typed-provider behavior
fakes: owner/human rules, confirmation, retry/CAS, transaction response loss,
crashes at every owner effect and durable transition, pending barriers and
Access-last ordering. Gateway tests prove REST dispatch and absence from MCP.
Headless Playwright covers typed confirmation, durable reload and resume errors.
`lifecycle-scheduled.test.mjs` invokes the real Worker scheduled handler with
all owners, real D1 rows and R2: project purge, then workspace purge, R2-before-parent
ordering, Access membership deletion last, another workspace preserved, and
maintenance even when the Integrations secret is unavailable.
These are local workerd tests, not a deployed D1/R2 purge claim.
