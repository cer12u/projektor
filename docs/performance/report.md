# Cloudflare performance investigation (C8a)

## C8d fixed request cost

Warm Miniflare measurements on the same 2,000-issue fixture, before and after this
change. Trips are D1 calls across the complete page request set; waves are the
largest number of nonoverlapping D1 groups in one request. Rows read are lower
bounds because `first()` has no row metadata. The board probe now sends
`limit=100&fields=summary` on every cursor page, matching the web client. Its
corrected C8d baseline is 133 trips over eight requests; the C8b report's 280
trips used 30-item cursor pages and cannot be compared directly.

| Page or operation | Trips before → after | Longest waves before → after | Rows read before → after |
|---|---:|---:|---:|
| projects list | 18 → 18 | 16 → 13 | 2,050 → 2,050 |
| project landing | 39 → 34 | 14 → 13 | 864 → 858 |
| issue list | 86 → 80 | 30 → 29 | 8,482 → 8,474 |
| board | 133 → 124 | 16 → 14 | 8,220 → 8,212 |
| issue detail | 78 → 68 | 12 → 10 | 385 → 371 |
| My Issues | 116 → 113 | 31 → 30 | 65,696 → 65,684 |
| sprint page | 123 → 63 | 17 → 13 | 2,460 → 2,460 |
| wiki page | 33 → 27 | 16 → 13 | 2,273 → 2,264 |
| metrics page | 21 → 19 | 21 → 19 | 439 → 437 |
| issue search | 16 → 14 | 16 → 14 | 6,049 → 6,046 |
| MCP tools/list | 12 → 8 | 12 → 8 | 16 → 16 |
| MCP issue read | 17 → 12 | 17 → 12 | 21 → 21 |
| PATCH issue | 24 → 22 | 24 → 22 | 83 → 80 |
| add comment | 18 → 16 | 18 → 16 | 41 → 38 |
| create issue | 18 → 16 | 18 → 16 | 68 → 65 |

The probe maps prepared SQL to the generated owner catalog and stores each page
set's top statement counts in `baseline.json`. In the issue-list set, the leading
counts changed from `access.admission=37`, `projects.project=15`,
`projects.visible=7`, `access.refreshProfile=5`, and
`access.discoverWorkspaces=5` to `access.admission=40`,
`projects.project=15`, `projects.visible=7`, and `access.workspace=1`.
One `/api/issues?limit=30` request was 40 trips / 30 waves / 2,304 rows
before, with 18 admissions and 10 project reads; it is 39 / 29 / 2,303
after, with 19 admissions and 10 project reads. The extra admission is the
explicit check for the bulk parent authorization call, including an empty ID set.

The corrected board set's leading counts changed from
`access.admission=56`, `projects.project=20`, `access.refreshProfile=8`,
and `access.discoverWorkspaces=8` to `access.admission=62`,
`projects.project=20`, and `access.workspace=1`. Its first 100-issue summary
request was 24 trips / 14 waves / 1,069 rows before, with 10 admissions and
four project reads; it is 23 / 13 / 1,069 after, with 11 admissions and four
project reads. Subsequent 100-issue pages remain separately admitted. These
wave counts approximate remote serial depth; they are not deployed D1 latency.

`scopeFor` now uses `requireMembership` directly when the UI supplies its
workspace header. Only headerless hostname or single-workspace fallback calls
`me()`; `/auth/me` retains profile refresh. Two routes that need the workspace
name use authorized `getWorkspace`. Projects' `getProjectBySlug`
(`modules/projects/internal/factory.ts:432-436`) reuses its freshly admitted
scope inside the same public call, removing one duplicate `access.authorize`.
Planning's `getSprintItems` (`modules/planning/internal/factory.ts:333-348`)
replaces each per-item Issues public call with one bounded `getIssuesByIds`
call; that Issues call authorizes itself and each distinct project once
(`modules/issues/internal/factory.ts:2064-2092`). Missing or hidden IDs still
produce null sprint items, and archived issues and projects remain readable.
The sprint gateway performs independent page and metadata reads concurrently.
Project ID resolution calls the slug path first for non-UUID inputs; UUIDs keep
the ID-first lookup and slug fallback. The board's existing 100-item summary
limit is covered by web and UI API tests; other list limits are unchanged.

Machine admission now joins live credential state, active membership, and
workspace state in one static Access read. Every admission still checks token
hash, principal, revocation, expiry, role and write scope. Human admission and
same-scope revocation behavior are unchanged. No migration was required; the
joined query uses existing keys. The budget ceilings are the measured warm
trips plus 10%, rounded up.

### Rejected (Q1)

Caching Access admission or project grants per scope, request, or TTL would
hide a revocation, demotion, or archive from the next public module call. The
remaining `access.admission` and project-grant reads are therefore retained.
`/auth/me` still refreshes its profile as specified. Command receipt checks,
version CAS, guards, history and events remain separate from this read-path
optimization. Cross-request status, type and member reads were retained because
their freshness cannot be assumed from an earlier HTTP request.

## C8b before and after

Local Miniflare warm measurements on the same fixture; D1 rows read are lower bounds because `first()` omits metadata. The budget ceilings add 10% to the measured D1 round trips and round up.

| Page or operation | D1 trips before → after | Rows read before → after | Response KiB before → after | Target trips |
|---|---:|---:|---:|---:|
| projects list | 18 → 18 | 2,050 → 2,050 | 1.8 → 1.8 | — |
| project landing | 155 → 39 | 47,240 → 865 | 37.2 → 37.2 | 25 |
| issue list | 192 → 86 | 214,731 → 8,482 | 27.0 → 26.9 | 25 |
| board | 1834 → 280 | 142,480 → 10,379 | 324.1 → 209.7 | 80 |
| issue detail | 78 → 78 | 439 → 385 | 4.2 → 4.2 | 30 |
| My Issues | 1224 → 116 | 93,209 → 65,697 | 245.0 → 245.0 | 40 |
| sprint page | 123 → 123 | 2,282 → 2,460 | 19.0 → 19.0 | 30 |
| wiki page | 33 → 33 | 2,273 → 2,273 | 14.8 → 14.8 | — |
| metrics page | 21 → 21 | 440 → 440 | 3.4 → 3.4 | — |
| issue search | 20 → 16 | 14,027 → 6,049 | 4.4 → 4.4 | 6 |
| MCP tools/list | 12 → 12 | 16 → 16 | 32.5 → 32.5 | — |
| MCP issue read | 17 → 17 | 21 → 21 | 0.1 → 0.1 | — |
| PATCH issue | 25 → 24 | 101 → 83 | 0.0 → 0.0 | 12 |
| add comment | 19 → 18 | 59 → 41 | 0.0 → 0.0 | 12 |
| create issue | 19 → 18 | 86 → 68 | 0.1 → 0.1 | 12 |

All measured response statuses matched the pre-change probe; the Wiki templates request remains the planned 501. The new index and bulk sprint lookup cut board round trips by 1,554 and My Issues by 1,108. The opt-in board projection reduced its response set by about 114 KiB. Issue detail retained 78 trips while its rows read fell from 439 to 385 after the bulk ID lookup was made to use the `(workspace_id,id)` primary key.

The numeric targets remain unmet for project landing, issue list, board, My Issues, issue detail, sprint page, search and all three writes. These page sets contain multiple HTTP requests, each with fresh workspace admission and module authorization; the board and My Issues also fetch every page. The sprint page uses `getSprintItems` rather than the issue-to-sprint lookup changed here, so its 123 trips did not fall. Search still authorizes each of five projects through Projects, yielding 16 trips. The write paths retain UI version reads, module admission, receipt replay, CAS and the atomic write; the safe seed-presence query removes one trip per write, leaving 24/18/18. Further reduction needs a bounded bulk authorization or command contract with equivalent revocation and retry behavior.

## C8b implementation notes

Remote smoke retries 403 for every secret-gated smoke call during edge version propagation; bearer API probes retry only 403/404 in the first 60 seconds after readiness. Hashed Astro files are verified at build time and receive an immutable browser cache header.

The issue list now uses dedicated workspace and project SQL for the created-date default shape, with an owner index on `(workspace_id,project_id,archived,created_at DESC,id DESC)`. On a 2,000-row, five-project SQLite fixture with bound project values, `EXPLAIN QUERY PLAN` changed from `SEARCH issues_issues USING INDEX issues_created_order (workspace_id=?)` to `SEARCH issues_issues USING INDEX issues_project_default_order (workspace_id=? AND project_id=? AND archived=?)`. The due-date candidate `(workspace_id,project_id,due_date,created_at,id)` was not added: with the actual catalog SQL and bound project values the planner retained `issues_project_number` and `USE TEMP B-TREE FOR ORDER BY` both before and after creating the candidate. The `(due_date IS NULL)` sort expression also prevents a direct match to that candidate's order. `parentsByIds` uses an ID-first CTE joined to the Issues primary key; an `IN` formulation had caused SQLite to scan the new project index across the workspace. `projectByKey` uses `projects_key_unique` with the active grant joined in the same authorized read.

Visible issue search now uses one authorized cross-project query. FTS results are ordered by FTS rank, then `created_at DESC`, then `id`; short-token results have equal rank and use the latter two keys. This deliberately replaces the old project-by-project concatenation order. `fields=summary` is used only by the board and returns exactly the fields declared in `board-utils.ts`. The default issue-list response is unchanged. List SQL reads an empty description projection when the response omits `body`.

The write-path change is limited to Issues' independent status/type seed-presence reads, now one static owner query. The admission checks, receipt lookup, CAS, guard, and atomic write batch retain their order. The UI pre-read is required to pass `expectedVersion`, while the module repeats admission and receipt checks to protect retries and concurrent changes. The target of 12 D1 round trips cannot be reached safely with this bounded change; further reduction needs a separately specified command/read contract and targeted retry/CAS proof. The measured counts appear in the table above.

Feedback paging remains pending an explicit UI page contract. Read replication needs a session/bookmark consistency design before a trial. Code splitting remains a lower-priority cold-start experiment. Smart Placement is configurable but off by default; the owner trial procedure and D1 latency/TTFB measurements are in [GitHub to Cloudflare](../github-cloudflare.md).

## Method and limits

Run `pnpm build && pnpm perf:probe`. The probe builds an instrumented copy of the built Worker, migrates Miniflare D1, and seeds **one workspace, five projects, 2,000 issues (two labels each), 100 comments, 50 links, one R2 file, ten sprints (100 issue assignments), 200 wiki pages, and three members (286 issues assigned to the owner)** through existing commands. It persists this fixture while it measures page request sets, then creates a new isolate per cold page set. `docs/performance/baseline.json` retains each request's status and counters. The page sets follow `apps/web/src/islands/issue-list/useIssueFetching.ts:48-108`, `IssueDetail.tsx:114-320`, `ProjectLanding.tsx:88-101`, `SprintManager.tsx:285-286`, `WikiPage.tsx:2319-2460`, and `MetricsDashboard.tsx:193`. The board set pages through all 400 project issues, as the UI does. The read sets are measured before write probes change the fixture. Requests within a set run sequentially in the probe; the browser may overlap independent calls, so a set's local wall time is the **maximum request** and is not a browser page-load measurement. Wiki templates intentionally returns 501.

The wrapper counts one D1 round trip for `all`, `first`, `run`, and `batch`; a batch's statements are counted individually. `rows_read` comes from D1 metadata, which `first()` does not expose, so it is a lower bound. “Waves” counts groups of overlapping D1 calls and approximates, but cannot prove, the longest dependency path. “CPU approx.” subtracts the union of D1 wait intervals from Miniflare wall time; it is **not** Workers billed CPU. Cold figures also include local isolate startup and JWKS fetch. These local figures establish operation counts and relative local costs; they do not measure Cloudflare D1 network latency, a deployed D1 primary, or real browser render time.

| Page or operation | Requests | D1 warm / cold | Statements warm | Rows read warm | Response KiB warm | Longest waves | Local wall ms warm / cold | CPU approx. ms warm / cold |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| projects list | 2 | 18 / 18 | 18 | 2,050 | 1.8 | 16 | 32 / 94 | 2 / 65 |
| project landing | 3 | 155 / 155 | 155 | 47,182 | 37.2 | 140 | 191 / 205 | 14 / 53 |
| issue list | 5 | 192 / 192 | 192 | 214,731 | 27.0 | 148 | 204 / 224 | 14 / 52 |
| board | 15 | 1,834 / 1,834 | 1,834 | 141,969 | 324.1 | 420 | 524 / 567 | 78 / 119 |
| issue detail | 7 | 78 / 78 | 78 | 439 | 4.2 | 31 | 45 / 114 | 12 / 54 |
| My Issues | 4 | 1,224 / 1,224 | 1,224 | 93,184 | 245.0 | 428 | 492 / 561 | 43 / 73 |
| sprint page | 5 | 123 / 123 | 123 | 2,282 | 19.0 | 17 | 63 / 91 | 11 / 49 |
| wiki page | 4 | 33 / 33 | 33 | 2,273 | 14.8 | 16 | 30 / 107 | 11 / 57 |
| metrics page | 1 | 21 / 21 | 21 | 440 | 3.4 | 21 | 74 / 121 | 9 / 51 |
| issue search | 1 | 20 / 20 | 20 | 14,027 | 4.4 | 6 | 100 / 147 | 2 / 38 |
| MCP tools/list | 1 | 12 / 12 | 12 | 16 | 32.5 | 12 | 21 / 49 | 5 / 12 |
| MCP issue read | 1 | 17 / 17 | 17 | 21 | 0.1 | 17 | 29 / 59 | 3 / 12 |
| PATCH issue | 1 | 25 / 25 | 32 | 101 | 0.0 | 25 | 61 / 103 | 6 / 40 |
| add comment | 1 | 19 / 19 | 27 | 59 | 0.0 | 19 | 46 / 114 | 2 / 44 |
| create issue | 1 | 19 / 19 | 27 | 86 | 0.1 | 19 | 42 / 102 | 3 / 40 |

The 30/150 ms estimates below are **network sensitivity calculations**, not latency predictions: one removed serial D1 trip saves at most roughly 30/150 ms of critical-path wait. Parallel calls or server-side D1 execution reduce that saving.

## Ranked structural fixes

1. **Bulk sprint lookup for issue pages.** `modules/planning/internal/factory.ts:256-266` loops over every issue, calls `issues.getIssueIncludingArchived`, then `issueSprint`. A 100-item My Issues page takes about 400 D1 trips and the first 100-item board page has the same path; the sprint page, including two populated lists, takes 123 trips in this fixture. Add a static `planning/storage/queries.ts` catalog entry `issueSprintsByIds` using a JSON ID array (or a fixed, bounded 100-bind form) and a public Issues bulk authorization method that reads IDs and project IDs once, then authorizes each *distinct project*, not each row. Keep Planning from reading Issues tables. `EXPLAIN` also shows `planning.issueSprint` using only the `(workspace_id,sprint_id,issue_id)` primary key's workspace prefix; add `planning_issue_lookup(workspace_id,issue_id,present,sprint_id)` in a new Planning migration. Adapt `sprintsForIssues` in Planning only. Keep two-workspace isolation tests. A 100-item page should approach 10-20 trips instead of about 400: about 380 fewer waves, a theoretical 11.4/57 seconds at 30/150 ms. The full 400-item board repeats this across pages. Risk: archived or inaccessible issue handling must match the existing per-issue path; the new index adds write/storage cost. Invariants: public-only dependency, admission-time authorization, static SQL, tenant predicate, 100-bind cap and additive migration remain intact.

2. **Make the default issue list query indexable and avoid the duplicate scan.** `modules/issues/storage/queries.ts:148-154` uses one SQL expression with many `(? IS NULL OR ...)` conditions, recursive JSON arrays and label checks for every filter shape. `gateway/ui/index.ts:1279-1280` runs `queryIssues` and `countIssues` sequentially. SQLite `EXPLAIN QUERY PLAN` on the catalog shows `queryIssues` using `issues_created_order (workspace_id=?)` and `countIssues` using `issues_project_number (workspace_id=?, project_id=?)`; neither exploits a project+date leading key for the default list. On 2,000 issues, the five-request issue list reads over 200,000 rows; the project landing reads over 40,000. Add static catalog entries for the common unfiltered workspace and project list/count shapes, with direct tenant/project/archived predicates, ordered by `created_at,id`; add an owner migration for `(workspace_id,project_id,archived,created_at DESC,id DESC)` if its measured plan beats the existing indexes. Keep the general catalog for uncommon combinations. Parallelize count and page *only after* both are authorized against the same admission snapshot. Expect at least one sequential trip removed (30/150 ms) and a large reduction in rows read; the exact CPU/D1 execution saving needs a C8b before/after probe. Risk: cursor ordering, optional filters, and total counts must remain byte-for-byte compatible. Invariants: only static catalogs, additive migration, tenant keys, and no authorization weakening.

3. **Bulk authorize child rollups.** `modules/issues/internal/factory.ts:1986-1991` calls `issue(scope,id)` once per parent before one `childCounts` query. The issue detail uses one parent; `includeRollups=true` for 100 parents measured 721 trips in a separate diagnostic run. Add `issues/storage/queries.ts:parentsByIds` to read all requested parent IDs and their project IDs, require that every requested ID was found, and authorize each distinct project through `projects.public.ts`; then run `childCounts`. Do not accept caller-supplied project IDs as proof. About 700 trips on a 100-item rollup call can become fewer than 20, a theoretical 21/105 seconds if serialized. Risk: hidden/archived parent semantics. Invariants: two-workspace isolation and project authorization remain; JSON array is bounded at 100 IDs.

4. **Reduce gateway repetition and sequential awaits.** `gateway/ui/index.ts:83,155-173,1206-1288,1370-1379` resolves workspace membership per request and repeatedly reads visible projects, all members, statuses, types, issue page, total, sprint IDs, and rollups. `issueRef` at `:210-215` scans all visible projects to resolve `KEY-N`; add `projects/storage/queries.ts:projectByKey` using the existing `projects_key_unique(workspace_id,project_key)` index and expose an authorized `getProjectByKey` public query. Comments already use one member map per request (`gateway/ui/index.ts:1471`), so the hypothesized per-comment member N+1 is **refuted**; links instead authorize each linked project in `modules/issues/internal/factory.ts:1571-1590`, and should authorize distinct projects once while preserving visibility filtering. Feedback at `gateway/ui/index.ts:175-198` walks source/feedback cursors until exhausted; bound its UI response with an explicit page contract before optimizing it. The 7-request issue detail uses 78 trips; project list uses 18 for only two HTTP requests. Pass a request-local, immutable admission snapshot to helpers and reuse fetched project/member maps within that request. After authorization, issue list metadata calls with no dependencies may run concurrently using `Promise.all`; preserve one response and one admission-time check per request. A request-local cache saves repeated reads but **must not** survive requests or substitute for a command's authorization. Target 5-15 fewer critical-path trips on detail/list (150-450 / 750-2,250 ms at 30/150 ms). Risk: accidental stale authorization if cached across requests. Invariants: Access JWT and per-request membership check stay; no SQL in Gateway.

5. **Search once across authorized projects.** `gateway/ui/index.ts:1141-1170` invokes `issues.searchIssues` once per visible project and truncates the concatenated results. At five projects search costs 20 D1 trips and reads 14,027 rows. Add an Issues public `searchVisibleIssues` query that accepts the already authorized project IDs or obtains the visible set itself, uses one FTS catalog query with bounded JSON IDs, and imposes the global `LIMIT`/order in SQL. The current per-project merge can privilege the first project, so define a stable global rank/tie break matching intended UI relevance before changing ordering. Estimated savings: 4 FTS calls and several repeated authorization trips, 120/600 ms for four sequential calls; actual calls currently overlap (`Promise.all`), so critical-path gain may be much smaller. Risk: cross-project result ordering. Invariants: authorize every selected project, tenant FTS predicate, static SQL, no more than 100 binds.

6. **Keep writes correct while reducing safe pre-reads.** The UI PATCH takes 25 trips/32 statements; comment/create take 19 trips/27 statements. `gateway/ui/index.ts:1311-1435` reads a version before update; `modules/issues/internal/factory.ts:988-1040,1140-1230,1337-1373` verifies receipt, issue and project before the guarded batch. Do not move admission checks or receipt/CAS decisions onto a replica. In C8b, trace the individual catalog calls and combine only *independent reads from the same owner* in a D1 batch, or replace repeated lookup reads with one static joined query in that owner. Keep the guard, row/history/receipt/event as one write batch. Target 2-5 serial trips per write (60-150 / 300-750 ms). Risk: a pre-read folded into the write batch may change idempotent retry or CAS behavior; reject that change unless tests prove identical outcomes. Invariants: receipt fingerprint, CAS, guard, authorization and atomic batch all remain.

7. **Tune placement after structural fixes.** `wrangler.jsonc:1-17` has no `placement`; the Worker normally starts near the user, while D1 has one primary. With many serial D1 calls, distance can dominate. [Smart Placement](https://developers.cloudflare.com/workers/configuration/placement/) is available on Free and Paid (it may take 15 minutes and enough multi-location traffic to choose a location) and can be tested with `"placement": {"mode":"smart"}` in the generated deployment config or base config. Measure Japanese browser TTFB and D1 latency before/after; Cloudflare warns that one Worker is placed as a unit even with selective `run_worker_first` ([routing note](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)). Exact static assets still use the assets layer first, so their path need not move. Read replication is a later experiment: enable it in D1 Settings, use [Sessions API](https://developers.cloudflare.com/d1/best-practices/read-replication/) with `withSession("first-primary")` for command pre-reads, CAS, and receipts, and a bookmark carried across requests to preserve read-your-writes for eligible reads. `withSession()` unconstrained can be stale at the start. D1 [is available on Free and Paid and does not charge extra for replicas](https://developers.cloudflare.com/d1/platform/pricing/), but row charges and limits remain: Free includes 5 million rows read and 100,000 rows written per day; Paid includes 25 billion rows read and 50 million rows written per month before overage. Placement saves **zero** D1 trips; if it cuts a trip's network portion by *d* ms, a 428-wave My Issues response could improve by up to `428 × d` ms, offset by extra user-to-Worker travel. Neither *d* nor net gain is known until the owner checks location and measures production. Risk: a stale initial read or missing bookmark could violate UI consistency. Invariants: primary command decisions and client read-your-writes are mandatory.

8. **Let hashed Astro assets stay fresh in the browser.** `apps/web/scripts/gen-csp-headers.mjs:66` emits only CSP, leaving `/_astro/*` on Cloudflare's revalidate-every-time default. Add a `/_astro/*` `_headers` rule with `Cache-Control: public, max-age=31536000, immutable` after confirming content hashes in every filename; keep HTML on revalidation and API `no-store`. This saves zero D1 trips (0/0 ms at 30/150 ms), but can remove repeat asset revalidation round trips, whose ms benefit needs an authenticated browser waterfall. Risk: a non-content-hashed file matched by the rule would be stale for a year. Invariants: no tenant data is cached; no command, SQL or auth path changes.

9. **Remove payload and CPU waste where measurements confirm it.** The 400-item board set returns 324 KiB of JSON; issue list returns about 27 KiB and MCP `tools/list` 32.5 KiB. The list catalog `modules/issues/storage/queries.ts:152` selects full descriptions even though `gateway/ui/index.ts:1289-1309` omits `body` unless requested. A summary catalog selecting only list fields can reduce D1 bytes and JSON work without changing the response. `apps/web/src/islands/board-utils.ts:21-52` declares a smaller set of fields than `issueShape` emits; if browser payload is material, add an **opt-in** `fields=summary` UI API form and use it only from the board, preserving the original default response shape. This saves **zero** D1 trips; at 30/150 ms per trip its network round-trip saving is 0/0 ms, while transfer/parse saving needs a measured byte delta. The metrics page is 21 D1 trips/about 440 rows; `modules/insights/internal/factory.ts` consumers are invoked from `apps/worker/index.ts:339-341` scheduled work, not the UI request path, so projection maintenance is not the load bottleneck. MCP `tools/list` costs 12 trips but only about 7 ms local CPU warm; its catalog is bundled, not rebuilt from storage on every call. Bundle `dist/worker.js` is 730,773 bytes raw / 113,304 gzip, imports every module at `apps/worker/index.ts:1-25`, embeds catalogs at build time (`tools/build.mjs:9-44`), and constructs the MCP operation registry at module scope (`gateway/catalog.ts:65`). Service composition is lazy (`apps/worker/index.ts:321-325`); no D1 query runs at module evaluation. Cold first requests typically added tens of local milliseconds, but include JWT/JWKS and D1; isolate startup alone was not isolated. Keep code splitting as a low-priority experiment only if dashboard startup CPU is high. Risk: summary fields missing on a UI variant; compare browser access to each field. Invariants: public DTOs and event/projection behavior remain.

## Query-plan notes

`EXPLAIN QUERY PLAN` was run against all migrations in an in-memory SQLite schema using catalog SQL and null binds: 204 read catalog plans compiled, none failed, 17 used a temp B-tree, and none showed a full scan of the four large base tables (`issues_issues`, `planning_items`, `wiki_pages`, `projects_projects`). An index used only on `workspace_id` can still examine most tenant rows. Null parameters and an empty schema cannot predict production cardinality. Hot catalog results: `access.listMembers`, `projects.visible` and `projects.project` use tenant indexes; `issues.byNumber` uses `issues_project_number` on workspace/project/number; `issues.queryIssues` reaches `issues_created_order` on workspace only; `issues.queryIssuesDueDate` uses `issues_project_number` then a **TEMP B-TREE FOR ORDER BY**; `issues.countIssues` uses `issues_project_number`; `issues.search` uses FTS virtual table index `M6` then rowid lookups and a temp B-tree for rank ordering; `issues.searchShort` uses `issues_project_number` but its short-token matcher scans terms; `issues.childCounts` uses `issues_parent` then a temp B-tree for grouping; `issues.listComments` and `issues.listLinks` use only a workspace-leading index plus a temp B-tree for ordering. `planning.issueSprint` uses only the workspace portion of its primary key, whereas `planning.sprint` and `activeSprint` use appropriate indexes. `wiki.search` uses FTS index `M6` plus a temp B-tree; `wiki.list` uses `wiki_workspace_slug`. The large filter expressions use recursive JSON sequences, not `json_each`; either form adds work when a filter is active. C8b should rerun plans with representative bound values and seeded statistics before adding indexes. Static shape-specific entries are preferable to dynamic SQL. For comment/link detail, test owner-local indexes on `(workspace_id,issue_id,created_at)` or the actual source/target and order columns before adding them; their write and storage overhead may exceed the gain at current sizes.

## Static assets and external observation

Generated deploy config in `tools/github-deploy.mjs:95-136` copies `wrangler.jsonc`: compatibility date `2026-07-30`, no flags, no placement, `assets.directory=dist/assets`, `run_worker_first` only for API/MCP/OAuth/auth/integrations/health; `not_found_handling` is absent. Exact Astro HTML and hashed `/_astro/*` asset requests can be served by the assets layer without Worker execution. Dynamic deep links have no matching file (for example only `dist/assets/projects/view/index.html` exists) and therefore fall through to `apps/worker/index.ts:344-357` for its HTML fallback; [Cloudflare's routing documentation](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/) confirms the Worker receives asset misses. Keep the existing fallback when tuning placement.

`dist/assets/_headers` currently sets CSP only. Cloudflare's [static assets headers](https://developers.cloudflare.com/workers/static-assets/headers/) default to `Cache-Control: public, max-age=0, must-revalidate` plus an ETag. In C8b, add `/_astro/*` to `apps/web/scripts/gen-csp-headers.mjs` with a long immutable **browser** cache lifetime after verifying names are content hashed; leave HTML revalidating and preserve CSP. This reduces repeated asset revalidation without a paid application cache. No `_headers` rule affects Worker-generated API responses, which remain `no-store`.

From codexvm, five unauthenticated `curl -w '%{time_starttransfer}'` samples to `/health` were 95.9, 52.7, 48.8, 49.3 and 57.2 ms; five to `/_astro/LazyMarkdownEditor.B_hiEcYt.js` were 58.9, 72.6, 59.3, 62.1 and 60.8 ms. All ten returned **302 Cloudflare Access redirects**. They measure the Access gate, not the app's TTFB. No Access bypass was attempted.

## Owner checks

- Cloudflare dashboard **Billing → Subscriptions**: whether Workers Paid is active. Then **Workers & Pages → projektor → Metrics**: request CPU p50/p95/p99, startup time, invocation latency, error rate and subrequests, ideally filtered to the page/API paths above. The plan is not recorded in the repository. [Current Workers limits](https://developers.cloudflare.com/workers/platform/limits/) list 10 ms CPU per request on Free and up to 5 minutes on Paid; [Paid starts at $5/month](https://developers.cloudflare.com/workers/platform/pricing/). Local `cpuApproxMs` cannot establish whether Free would exceed 10 ms, especially for flow metrics, search, or MCP catalog serialization.
- Dashboard **Storage & databases → D1 → projektor → Settings**: primary location and whether read replication is enabled; **Metrics → Row Metrics**: rows read/written and query latency. Do not infer Japan-to-primary latency without this.
- Dashboard **Workers & Pages → projektor → Settings → General → Placement** (or deployment config/API): whether Smart Placement is already enabled in production despite its absence from source. Record the placement location before a C8b trial.
- Browser DevTools Network after Access login: compare first and repeat navigation waterfalls, payload bytes for list responses, `CF-Cache-Status`, `Cache-Control`, `ETag`, and the status of dynamic deep links. Use these to decide whether the asset header change is material.

## Caching (last resort)

Only after the bulk reads, query shapes, and placement trials should the owner consider KV or Cache API for authenticated read snapshots. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) starts Paid at $5/month, and cache use brings invalidation, tenant scoping and stale authorization risk. A cache key would need workspace, principal/role and filter shape, short TTL, and a write invalidation strategy; authorization must still run at admission. There is no evidence yet that this cost and complexity outperform the structural fixes.
