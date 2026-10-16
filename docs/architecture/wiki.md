# Wiki — Step 05, extended in C4b

The Step 05 contract below describes the original project-only implementation.
The C4b section at the end supersedes it where the UI restoration expanded the
scope.

Wiki owns project pages, immutable revisions, operation receipts, events, guards,
and the FTS5 index. Its only business dependency is `ProjectsApi.authorizeProject`.
The public `Scope` type is derived from that method, so Wiki has no direct Access
edge. Projects performs live membership and project permission checks at each
admission. Q1 allows a command admitted before revocation to commit; a later
read or retry checks current permission again.

## Contract

`createPage`, `editPage`, and `archivePage` require caller operation IDs. Edit
and archive also require `expectedVersion`. Slugs are immutable lowercase ASCII
letters/digits separated by single hyphens, 1–128 characters. A DB unique index
on `(workspace_id, project_id, slug COLLATE NOCASE)` protects simultaneous
creates and case-insensitive collisions. Archiving retains the slug, page,
revisions, receipt, and events. No rename or project move is in core.

`getPage` accepts an ID or project and slug. `listPages` uses ascending slug
keyset pagination within one authorized project; `listRevisions` uses descending
version keyset pagination. `getRevision` and `listRevisions` remain available for
an archived page while its project is visible. Markdown is stored as plain text
and returned unchanged. No server rendering or HTML trust decision is made here.
Each revision stores the complete title and body plus actor ID, human/machine
kind, acting OAuth client ID (nullable), and time. Events have schema version 1
and the same attribution. `readEvents` requires a factory-issued reader identity.

The plan's Wiki row omitted `listRevisions` even though the core calls for
revision history and `getRevision` alone cannot enumerate it. Step 05 adds that
query and updates the plan row. No other business dependency or operation was
added.

## Storage and recovery

Every command makes one D1 batch containing the page change, a
`changes() = 1` guard, FTS replacement, revision, receipt, and event. The guard
aborts a stale update even if an expected revision record is missing. The
receipt key is `(workspace, principal, operationId)` and binds a SHA-256 digest
of the command kind and canonical input. Retry first checks current project
visibility, then returns the saved result or rejects a changed fingerprint.
If a batch response is lost, the same operation ID recovers the durable result;
if outcome remains unknown, the caller retries that ID. A stale edit reports a
conflict with the page's current version. All pages and revision lookups include
workspace predicates; by-slug and lists also include project predicates.

Search accepts 1–12 whitespace-separated literal terms within 256 UTF-16 code
units, combines them with AND, and limits output to 1–100 pages. Trigram FTS5
indexes title and body for Japanese, English, and mixed substrings. Quoted FTS
terms escape embedded quotes. If any term is shorter than three Unicode code
points, static `searchShort` uses escaped LIKE for all terms in the authorized
project, escaping `%`, `_`, and `\`. This fallback bounds result count, while
read cost still depends on project size; real project sizing and Cloudflare D1
smoke remain later gates. Edited and archived pages update the FTS row in the
same batch.

The Wiki test suite uses a dedicated bundle with no Issues source and migrates
only Wiki storage on Miniflare D1, with a Projects public contract fake. It
covers validation, two workspaces and projects,
live read/write denial, Q1 revocation race, concurrent CAS, missing-revision
guard, response loss/restart/retry, every command's rollback, keyset pagination,
revision and event attribution, FTS replacement, and short Japanese terms.
`node tools/audit-wiki-mutations.mjs` checks five focused mutants: missing page
workspace predicate, missing slug project predicate, downgraded live write
authorization, removed edit CAS, and skipped changed-row guard. Every mutant
must fail a behavioral assertion. These are local workerd checks, not deployed
D1 evidence.

## Lifecycle maintenance (13)

See [Lifecycle](lifecycle.md) for owner-local atomic freeze, bounded purge, retained
markers, project attribution, REST-only owner access and recovery limits.

## C4b UI restoration

Wiki now accepts workspace pages as `project_id = ''` in storage and exposes that
value as `null` in its public DTO. A workspace page requires live workspace
membership to read and a live member, admin or owner role to write. Project pages
still require project authorization. Slugs are unique per workspace, including
archived pages. Pages carry parent, creator, updater and timestamps; the additive
`0003_workspace_pages.sql` migration derives metadata from the earliest and latest
revision and renames cross-project slug conflicts by age and ID. The old
`wiki_project_slug` index stays in place. Parent changes require an active parent
in the same workspace and project scope and reject cycles.

`getPageBySlug` resolves a workspace-unique slug. List and search without a
project filter include workspace pages and pages from currently visible projects.
The static SQL receives the visible project IDs as one JSON array bind; IDs are
validated alphanumeric/underscore/hyphen values, and the SQL searches quoted
complete IDs in that array. The C4b UI API maps core list, create, view, edit,
archive, revision and search requests. Every write still uses a fresh operation
ID, CAS, a guard, a receipt, a revision and an event in one batch. The UI API
reports CAS conflicts as HTTP 409.

The original UI's tree, drafts, diff, templates, trash, watches,
notifications, backlinks and export remain deferred with HTTP 501. Delete
archives only the selected page; the original's cascade trash and undo are not
available. Revisions use numeric page versions as response IDs rather than the
original UUID revision IDs. Frontmatter, verification and freshness fields have
no source yet and return their original empty defaults.
