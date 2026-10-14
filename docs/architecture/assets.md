# Assets (step 09)

Assets owns `assets_blobs`, `assets_links`, `assets_gc_jobs`, `assets_history`,
`assets_receipts`, `assets_events` and `assets_guards`. Link metadata never appears
in Issues or Wiki storage. The dependency graph adds Access directly because each
Assets command and query rechecks `access.authorize`; target visibility is checked
through `issues.authorizeIssue` or `wiki.authorizePage` and project visibility
through `projects.authorizeProject`. The approved plan's owner row was updated to
record this required edge.

## Binary contract

`assets.begin` declares the project, size (0–10 MiB), MIME content type,
lowercase SHA-256 hex digest and display filename. The browser or agent sends one `PUT` to
`/api/w/{workspaceId}/assets/upload/{assetId}`. Assets checks the payload against
the declaration before storing it at `assets/<workspaceId>/<assetId>`. The
workspace-scoped Platform adapter rejects a foreign workspace, nested key, or
foreign owner prefix. `assets.complete` reads the actual R2 object and verifies
its size and digest before marking the row ready. The filename is shown in
attachment lists and encoded in the download disposition. The upload and its
R2 object remain eligible for GC if no target is linked within 24 hours.

`assets.link` and `assets.unlink` require an issue or wiki page in the blob's
project and recheck write permission at admission. `assets.list` pages a target's
links by link ID. `assets.get` returns metadata. `assets.downloadUrl` gives MCP
clients a relative REST URL; it does not fetch bytes. Binary upload and download
are REST-only. `GET /api/w/{workspaceId}/assets/download/{assetId}` checks live
membership, project and at least one visible target link, then streams R2 bytes
through a narrow `ByteReader`. A removed membership, archived project/target,
or last link prevents a new download. Responses use `no-store`, force an
`attachment` disposition and set `X-Content-Type-Options: nosniff`, including
HTML/SVG. The 10 MiB application cap bounds complete-time hash
verification and the single-PUT upload; this is independent of Cloudflare's
account request-size allowance.

Commands take an operation ID, with versioned commands also taking
`expectedVersion`. The ID is tied to an input fingerprint. D1 batches commit
the business row or link, history, receipt, and event together; a failed CAS
trips the guard table and rolls back. Repeating an operation ID returns its
committed result. `readOperation` recovers results after lost responses. The
outbox event reader is capability-gated.

## GC and failure behavior

`begin` writes an expiry job in the same batch as the blob row. `complete`
keeps it until a link is committed. Unlinking the final link retires the blob
and writes an immediately due job in the command batch. The Worker
hourly `scheduled` handler calls `drainGc`. For each due pending or retired blob, or a ready blob that was never linked,
it atomically retires an unlinked pending/ready row before opening the R2 delete.
This closes completion/link admission during collection: otherwise a pending
object could complete and acquire a link between the GC read and the R2 delete.
It then deletes R2 first and only then removes the job, history and blob in
a D1 batch. R2 deletion is idempotent. A crash or deletion failure leaves the
job, so the next run can repeat safely. A committed ready blob with other links
causes a stale job to be removed without deleting the object. Receipts and
outbox events remain after GC for operation recovery and audit.

D1 and R2 cannot share a transaction. The pending job covers an R2 upload that
succeeds while completion fails. Admission-time authorization follows owner
Q1: a command admitted before a revocation may finish, while the next command
or download is denied. Local Miniflare tests exercise R2 put/delete faults,
D1 completion failure, replay, tenant separation, mismatches, expiry and
visibility changes. They do not establish behavior of a deployed R2 bucket.

## Independent audit (09a)

[Behavior/test map and mutation evidence](test-audit.md#assets-independent-audit--09a)
cover the scoped R2 adapter, isolated Assets D1 storage, actual Worker scheduled
GC, binary REST/MCP authorization, and headless Web attachment recovery. Run the
bounded probes with `node tools/audit-assets-mutations.mjs`; do not run other
source writers or tests against its shared bundles concurrently. Each probe
checks its healthy regression, applies one defect, records assertion-based
results in `reports/`, and restores the sources. No public contract, migration,
owner resource or dependency was added by the audit.

## Event attribution (11a)

New outbox events use schemaVersion 2 and `payload.clientId` from RequestScope (nullable), alongside the actor ID. Existing version-1 rows keep their original data and read with null client attribution. Consumers must accept both versions.

## Lifecycle maintenance (13)

See [Lifecycle](lifecycle.md) for owner-local atomic freeze, bounded purge, retained
markers, project attribution, REST-only owner access and recovery limits.
