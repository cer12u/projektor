# Projects and Issues independent test audit — 04a

Audited the merged implementation at `2bd393d` against public contracts, the
rewrite plan §7.1, and the owner's Q1 admission-time decision. The original
Projects suite had four test blocks; Issues had five. Passing those suites did
not establish all the invariants below. Tests use each owner's real Miniflare
D1 storage with only that owner's migrations and public dependency fakes.
“Covered” below means the stated scenarios execute, not a proof for every input
or a deployed-D1 claim. The specific surviving mutations are recorded separately.

## Projects audit

Reviewed every `ProjectsApi` entry independently against rewrite-plan §5.1–5.4/§7.1,
Projects public docs, Access public provider implementation, and Q1 admission-time
revocation. The original four Projects tests did not exercise the full permission
matrix, each command's rollback/retry/CAS behavior, event capability identity,
no-op grant/revoke guards, complete paging, or most input boundaries. The revised
suite has 20 test blocks and still migrates only Projects tables in Miniflare D1.

| Behavior / invariant | Executable test in `tools/projects.test.mjs` (unless noted) | Audit status |
|---|---|---|
| `createProject`: live Access write + owner/admin; denied members/viewers, copied/revoked scopes; uppercase key, trimmed bounded name, bounded IDs; tenant key uniqueness | `project role matrix…`; `every scope-bearing entry…`; `validation covers…`; original `DB key uniqueness…` | Original partial → covered; original concurrent create/rename uniqueness retained |
| `createProject`: one durable result, receipt and event; same-input retry, changed fingerprint and cross-command operation ID conflict; duplicate concurrent operations; response loss/restart | `createProject: rollback, replay fingerprint…`; `concurrent duplicate operations…` | Original partial → explicit per-command snapshots and durable recovery |
| `renameProject`: manager and write scope; existing visible active project; optional key; positive bounded expectedVersion; stale/concurrent CAS; fingerprint binds target/version/name/key; retry, atomic row/receipt/event | `renameProject: rollback, replay fingerprint…`; `all CAS commands…`; `project role matrix…`; `validation covers…`; `concurrent duplicate operations…`; original uniqueness race | Original partial → covered |
| `grantProjectRole`: manager/write; active target membership in caller workspace; allowed role; CAS, no unchanged grant with new operation ID; complete rollback of version+grant+receipt+event; retry/recovery | `grantProjectRole: rollback, replay fingerprint…`; `unchanged grants…`; `assignee checks…`; `all CAS commands…`; role/validation matrices | Original successful path only → covered |
| `revokeProjectRole`: manager/write; active existing grant; CAS; absent/already-inactive grant conflicts without project version/receipt/event; regrant activates; retry/recovery | `revokeProjectRole: rollback, replay fingerprint…`; `unchanged grants…`; `all CAS commands…`; role/validation matrices | Original successful path only → covered, including surviving guard mutation |
| `archiveProject`: manager/write and CAS; archive removes normal visibility; new edits denied; same-operation archive retry works; no destructive deletion; atomic state/receipt/event | `archiveProject: rollback, replay fingerprint…`; `keyset pagination…`; original `two tenants…`; `all CAS commands…` | Original partial → covered |
| `getProject` / `authorizeProject`: live Access, direct manager/editor/viewer matrix capped by workspace role and credential scope; owner/admin implicit manager; missing/foreign/nonparticipant/archived → `not_found`, insufficient known-project role → `forbidden` | `project role matrix…`; `tenant, project and actor scope…`; `keyset pagination…`; `every scope-bearing entry…`; shared `projectsConsumerContract` | Original partial → covered; same contract now runs for real Projects and Issues' Projects fake |
| `listVisibleProjects`: live admission, workspace/direct grant filtering, archived exclusion, ordered ID keyset, exact full-page/end-page cursor, no duplication, 1–100 limit | `keyset pagination…`; `tenant, project and actor scope…`; `every scope-bearing entry…`; `validation covers…` | Gap found: null/0/false cursor silently accepted. Fixed string type validation; regression covers all three |
| `authorizeProjectPrincipal`: caller write permission; target live active membership, owner/admin implicit visibility or active project grant; missing/inactive/foreign/ungranted target → `not_found` | `assignee checks…`; `every scope-bearing entry…`; shared `projectsConsumerContract` | Original partial → covered |
| `readOperation`: live admission; workspace+actor operation partition; current project visibility required after grant revoke; archived command's recovery preserved; absent receipt returns null; restart durable | `tenant, project and actor scope…`; every per-command recovery test; `every scope-bearing entry…`; Q1 test | Original partial → covered |
| `readEvents`: exact composition reader identity, no-reader factory and other factory denied; workspace-local strictly advancing cursor and bounded pages; complete envelope, actor/time/type/project version match command; retry does not duplicate | `event readers are…`; `tenant, project and actor scope…`; every per-command consistency test; `validation covers…` | Original count/type only → covered; capability mutation killed |
| Q1: admitted write may commit after revoke, new command and receipt read denied | `Q1 admitted write may commit after revoke…` uses a controlled batch barrier | Previously missing → covered without claiming stronger cross-module transaction semantics |
| CAS and atomicity across all five commands | Per-command final-event failure snapshots all five owned tables; `all CAS commands…` checks stale results and concurrent winner; `unchanged grants…` | Original create rollback/rename CAS only → full command coverage |
| Access fake versus provider contract | `accessConsumerContract` now checks scope provenance, self principal/membership consistency and absent principal/membership; run by Projects fake test and `tools/access.test.mjs` → `public provider contract…` | Original helper only checked copied-scope rejection and was never run on Access → shared execution now verified |

### Executed mutation probes

Each mutation was applied to `modules/projects/internal/factory.ts`, tested,
then restored. “Before” ran the original four-test Projects suite. “After” ran
the named focused regression from the expanded suite. Exit 0 means a survived
mutation; exit 1 means a behavioral assertion failed. These are six specific
probes, not a comprehensive mutation score or a claim about deployed D1.

| Mutation | Before | After / detecting test |
|---|---|---|
| Replace viewer write-role rejection with `false` | Survived (exit 0) | Killed (exit 1), `project role matrix…` |
| Remove project name `> 512` rejection | Survived (exit 0) | Killed (exit 1), `validation covers…` |
| Remove reader capability identity comparison (keep configured-reader check) | Survived (exit 0) | Killed (exit 1), `event readers are…` |
| Execute `revokeRole` without its changed-row guard | Survived (exit 0) | Killed (exit 1), `unchanged grants…` |
| Bypass `access.authorize(scope,"read")` in `authorizeProject`, trusting incoming scope | Killed (exit 1) | Killed (exit 1), `every scope-bearing entry…` |
| Filter all guard statements from commit batch | Killed (exit 1) | Killed (exit 1), `all CAS commands…` |

### Changes and limits

The only Projects runtime change is explicit string validation of the project
list cursor. No Projects public interface, query catalog, migration, table or
owner dependency changed. Access's consumer contract now includes
`getMembership` and actually runs against the real Access provider. Final module verification uses the established shared test bundle and sequential
runner, preserving the existing generated-import exception.

Projects continues owning `projects_projects`, `projects_grants`,
`projects_receipts`, `projects_events`, and `projects_guards`. Events also serve
as immutable history/outbox; Projects exposes no separate `getHistory`.

Real Cloudflare smoke and HTTP/MCP error translation remain later-step evidence.

Validation evidence: `node --test tools/projects.test.mjs` passed 20/20; after
adding only extra principal-ID/trim normalization assertions to that validation
block, the targeted `--test-name-pattern='validation covers'` run passed 1/1.
`node --test --test-name-pattern='public provider contract:' tools/access.test.mjs`
passed 1/1 against the real Access implementation. Every after-mutation failure
was an `ERR_ASSERTION` “Missing expected rejection”, not an unrelated build,
freshness, or setup failure. Formatting was checked with Biome; unchanged
optional-chaining warnings remain warnings. Parent performs aggregate required
verification and MR pipeline checks.

## Issues audit

Every command must admit a live write scope and visible active project, bind the
receipt to workspace/principal/operation ID plus canonical command input, and
commit its business change, counter/comment where applicable, FTS, history,
receipt and event atomically. Every existing-issue command additionally needs
CAS. Every ordinary query needs current project visibility. `readEvents` instead
uses a composition-issued identity capability. The following table names test
prefixes in `tools/issues.test.mjs`; per-command generated test names are exact.

| Behavior / invariant | Executable test | Audit status |
|---|---|---|
| `createIssue`: live write authorization including workspace/project viewer and read-only machine/OAuth; nonparticipant/archived project concealed; invalid IDs/title/description/priority/operation ID rejected | `all public operations…`; `every write rejects…`; `public inputs…` | Partial → covered; original fake omitted live Access and incorrectly returned forbidden for missing project grants |
| `createIssue`: workspace/project counter, concurrent allocation, duplicate ID and retry races, fingerprint conflict, counter rollback with failed event | original `concurrent counter allocation…`; `create rollback restores counter…`; `distinct tenant data…` | Partial → explicit counter rollback and concurrent identical retry coverage |
| `editIssue`: write/CAS, bounded title/description/priority, atomic content and FTS replacement, history detail, replay/fingerprint, durable recovery | `editIssue: stale CAS…`; `public inputs…`; original `failed batch…`; `actor and acting client…` | Partial → all-store snapshots, restart and per-command failure injection |
| `transitionIssue`: fixed directed graph, invalid/forbidden transitions, write/CAS, state/history/event/receipt atomicity and retry | `fixed state graph…`; original `rules, fixed transitions…`; `transitionIssue: stale CAS…`; `public inputs…` | Partial → per-command CAS, atomic failure, fingerprint and restart |
| `assignIssue`: write/CAS; active same-workspace assignee and live project access through public providers; null unassign; invalid ID; original result recovery | original `rules, fixed transitions…`; `assignIssue: stale CAS…`; `public inputs…`; `pagination applies…` | Partial → per-command recovery/failure and negative target cases |
| `addComment`: bounded nonblank body/comment ID, write/CAS, one comment/history/event/receipt despite retry or response loss, full rollback | `addComment: stale CAS…`; `unknown outcomes recover…`; `public inputs…`; `actor and acting client…` | Partial → comment storage and durable recovery verified |
| `archiveIssue`: write/CAS; terminal new writes, retained receipt recovery, excluded list/search, event type/version, exact retry | `archiveIssue: stale CAS…`; original `failed batch…`; `Japanese, English…` | Partial → per-command rollback, restart and fingerprint |
| `getIssue`: all three selectors (ID, project/number, project/reference); correct project key and tenant; archived/missing/foreign/nonparticipant return not_found; live authorization | original `rules, fixed transitions…`; `distinct tenant data…`; `all public operations…`; `public inputs…` | Original equal tenant payloads hid wrong-row reads → distinct titles/history and cross-project number-1 collision |
| `authorizeIssue`: same visibility as get; write capped by workspace role/project grant/credential scope | `all public operations…`; `every write rejects…` | Missing explicit permission/capability matrix → covered |
| `listIssues`: active authorized project; tenant/project predicates; state/priority/unassigned/specific assignee filtering before limit; descending number keyset, exact last cursor, no duplicates on new insertion | original `two workspaces…`; `pagination applies…`; `public inputs…` | Partial → combined filters/terminal page; found and fixed numeric/coercible cursor and non-string assignee acceptance |
| `searchIssues`: same live scope/project; Japanese/English/mixed literal substrings, 1–2 Unicode characters; injection-safe FTS and escaped LIKE; limits; updated/archived consistency | `Japanese, English…`; `all public operations…`; `public inputs…`; original `failed batch…` | Confirmed unicode61 gap → trigram plus short-term fallback, explicit 12-term cap |
| `getHistory`: current project visibility, workspace+issue key, version order, action/detail/actor/time, client attribution | `distinct tenant data…`; `actor and acting client…`; `all public operations…`; original `rules, fixed transitions…` | Partial → tenant-distinct content and acting-client persistence |
| `readOperation`: current authorization, principal/workspace partition, no receipt for failed CAS, saved version after restart/archive, absent returns null | `distinct tenant data…`; five `…: stale CAS…` tests; `unknown outcomes recover…`; `Q1 admission…` | Partial → actor partition, restart and revoked recovery |
| `readEvents`: exact factory capability, no-reader disabled, workspace cursor and complete ordered pages, immutable ID/version/type/actor/client, no retry duplicates | `distinct tenant data…`; `actor and acting client…`; five `…: stale CAS…`; `public inputs…` | Original only event types → capability, tenant and cursor checks |
| Q1 revoke race | `Q1 admission permits in-flight commit…` revokes after admission before batch execution | Missing → admitted data can commit; post-commit recovery reauthorizes and denies the now-revoked caller; no stronger distributed transaction promised |
| Unknown committed outcome, restart, no duplicate side effects | `unknown outcomes recover…` injects lost batch response and failed receipt read | Original recovered response-loss only → genuine unknown then fresh factory recovery |
| Historical schema upgrade and index rebuild | `trigram upgrade rebuilds existing indexed rows…` seeds v1 then migrates twice | New → old issue searchable with trigram; history client stays null; index/migration receipt not duplicated |
| Provider fakes conform to public provider semantics | `Projects fake satisfies…` plus `projectsConsumerContract` on real Projects; `accessConsumerContract` on real Access and fake | Missing shared execution → added; no provider tables or private helpers imported by runtime Issues |

### Executed mutation probes

Before: temporarily changed one line in the merged implementation and ran all
five original Issues tests, regenerating SQL catalogs for SQL mutations. After:
ran the regression once healthy and once with the same mutation; generation
must succeed and an actual assertion must fail. All mutations were restored.
`node tools/audit-mutations.mjs` reruns the Issues campaign and writes per-probe
logs plus `reports/issues-mutations.json`; it is an explicit audit tool, not a
second copy of normal CI. Run without concurrent source edits. The tool refuses
an existing audit lock, fails on target drift, and restores source/catalogs in
`finally`. A crashed process must be inspected before removing the lock.

| Mutation | Original five tests | Expanded regression |
|---|---|---|
| Remove workspace predicate from issue-by-ID | **Survived** | Killed: `distinct tenant data…` |
| Downgrade existing issue write admission to read | **Survived** | Killed: `every write rejects…` |
| Remove edit version predicate | Killed, original concurrent/CAS test | Killed: `editIssue: stale CAS…` |
| Skip receipt fingerprint comparison | Killed, original concurrent/CAS test | Killed: `concurrent counter allocation…` |
| Remove events workspace predicate | **Survived** | Killed: `distinct tenant data…` |
| Remove history workspace predicate | Additional audit probe | Killed: `distinct tenant data…` |
| Remove by-number project predicate | Additional audit probe | Killed: `distinct tenant data…` |
| Downgrade create admission to read | Additional audit probe | Killed: `every write rejects…` |
| Remove changed-row guards from batch | Additional audit probe | Killed: `editIssue: stale CAS…` |

Final execution: all nine Issues probes were **killed by behavioral assertions**
(exit 1); every paired unmutated regression passed (exit 0). Together with six
Projects probes, all 15 selected mutants were killed after this audit. Seven of
the eleven probes run against the original suites had survived (four Projects,
three Issues). These bounded probes are not an exhaustive mutation score.

Issues ends with 23 test blocks, Projects with 20 (nine before this audit, 43
now). `unassignment, duplicate comment IDs…` additionally proves null assignment,
comment uniqueness rollback, terminal archive for all selectors and writes,
and writes leaving the other workspace's same-ID issue unchanged. The pure
state-graph test checks all 16 directed state pairs.

## Scope of fixes and remaining evidence

- No module ownership edges, table ownership, cross-owner access rules, or public
  factory boundaries change. Projects/Issues keep their own transactions.
- Issues adds nullable `client_id` to its history/comments/events and exposes
  `clientId` in `IssueHistory` and schema-v1 event payloads. Existing entries stay
  null; retries by the same principal through another client preserve the
  original committed attribution. Machine actor kinds are never relabeled.
- Migration 0001 stays immutable. 0002 rebuilds the FTS index from Issues' own
  canonical rows with trigram, preserving rowid joins. No production data or
  Cloudflare resources were accessed.
- The schema validator falsely rejected FTS DROP's internal `data_version` and
  Python sqlite3's implicit BEGIN on INSERT migrations. It now recognizes only
  exact owned-virtual-table DROP for the existing FTS internal introspection
  exception and uses autocommit connections so Python does not inject BEGIN.
  Explicit PRAGMA/BEGIN, foreign FTS DROP and runtime DDL have negative tests;
  ownership/DDL/transaction restrictions remain enforced.
- Main-only real D1 smoke must verify trigram creation, populated-index rebuild,
  short-term LIKE, and atomic FTS rollback on deployed SQLite. Local workerd
  success does not establish that gate. Short-term searches scan the authorized
  project subset (indexed workspace/project prefix); result count is bounded,
  not a constant CPU/read-cost guarantee. Benchmark actual project sizes later.
- HTTP/MCP error mappings, OAuth login through real clients, UI rendering of
  “via client” labels and history pagination are later Gateway/Web decisions.
  No browser or transport implementation was added here.
