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

## Access and Wiki independent test audit — 05a

Reviewed merged main `b8e4791` independently of the implementation, using §7.1,
the public APIs, storage predicates and owner Q1/Q2 decisions. Access originally
had 24 test blocks and Wiki ten. Each suite uses only its owner's migrations on
Miniflare D1 (and Access KV), plus Platform's migration ledger. Access's external
identity provider is a local RSA signer and a fake JWKS fetch port; Wiki calls a
Projects public-contract fake, with no Projects/Issues tables. These are bounded
local workerd experiments, not deployed D1 or HTTP/MCP security acceptance.

### Access contract-to-test map

Names below are prefixes in `tools/access.test.mjs`. The ten generated
`audit <command>: complete rollback…` tests snapshot **all 13 Access tables**,
inject a final-event NOT NULL failure after the business change, check exact
rollback, then commit with a lost response and verify durable receipt/event
contents. Versioned commands additionally exercise stale CAS with no changes;
creations have no expectedVersion contract. Retries, changed fingerprints and
fresh-factory recovery are verified except archive, which intentionally denies
post-archive reads/retries. The existing concurrency/Q1 tests remain necessary.

| Public command/query | Required behavior/invariants | Executable evidence |
|---|---|---|
| `authenticate` human | RS256 signature, configured issuer/audience, expiry/iat/nbf, human claims; no provisioning; no untrusted key source | `human JWT…`; `JWKS attacker kids…`; **new** `audit JWKS…` demonstrates forged KV acceptance before fix and rejection after fix/restart |
| `authenticate` machine | Hash-only secret, revoked/expired credential rejected, principal kind/issuer, live workspace membership | `machine credentials…`; `machine removal…`; `audit errors…` |
| `authenticate` OAuth | Access-token kind, exact resource, live family/client/member version; same human and client attribution | `OAuth public API…`; `OAuth live admission…`; `OAuth limits…`; `OAuth refresh…` |
| `requireMembership` | Principal WeakMap identity, live credential/expiry/membership, explicit workspace, viewer and credential ceilings | `public provider contract…`; `machine credentials…`; `OAuth public API…`; **new** `audit confinement…` with an extra machine membership |
| `authorize` | Factory-local scope provenance and fresh admission on every call; copied/inherited/foreign scopes denied; role/credential revocation effective | `public provider contract…`; `machine removal…`; `Q1 admission race…`; **new** `audit provenance…`; live-membership mutation |
| `listWorkspaces` | Only active memberships/nonarchived workspaces, token workspace confinement, no creation as authentication side effect | `human JWT…`; `machine credentials…`; `OAuth public API…`; `concurrent last-owner changes…`; `audit confinement…` (100-row cap is documented; pagination is deferred) |
| `getPrincipalSummary` | Live caller, active same-workspace target, foreign/absent indistinguishable | Real `accessConsumerContract` via `public provider contract…`; **new** `audit errors…` |
| `getMembership` | Live caller, same-workspace target including inactive tombstone/version, foreign/absent indistinguishable | `public provider contract…`; **new** `audit errors…`; removal/restore tests |
| `getCredential` | Interactive manager only, current workspace, no secret/hash in DTO, version/revoked status | `machine credentials…`; `machine removal…`; **new** `audit management matrix…`, `audit errors…` |
| `bootstrap` | Exact operator capability and global one-time latch, concurrent winner, no implicit login provisioning, atomic workspace/owner/principal/receipt/event | `bootstrap…`; **new** `audit bootstrap…` |
| `createWorkspace` | Interactive human only; atomic owner+workspace creation; operation fingerprint/recovery | `OAuth public API…`; `public commands reject…`; **new** `audit createWorkspace…` |
| `inviteMember` | Trusted issuer, owner/admin role policy, first invite version 0, restore tombstone CAS, no duplicate active invite; atomic global principal plus tenant membership | `public provider contract…`; `CAS, concurrent…`; `atomic rollback…`; **new** `audit inviteMember…`, `audit management matrix…` |
| `changeRole` | Role matrix, machine cannot become admin/owner; last owner preserved under races, SQL target role rechecked; stale CAS/retry/event | `public provider contract…`; `machine removal…`; `concurrent last-owner changes…`; `admin cannot race…`; **new** `audit changeRole…`, management matrix |
| `removeMember` | Manager policy, last-owner guard; inactive tombstone and credential revoke in same batch; no stale receipt | `public provider contract…`; `machine removal…`; **new** `audit removeMember…`, management matrix |
| `provisionMachine` | Interactive owner/admin, member/viewer only, workspace-derived stable identity; atomic membership/receipt/event | `machine credentials…`; `Q1 admission race…`; **new** `audit provisionMachine…`, management matrix |
| `issueCredential` | Same-workspace active machine, 32-byte caller-retained secret, hash-only storage and fingerprint; scope/expiry, retry does not leak plaintext | `machine credentials…`; **new** `audit issueCredential…`, management matrix |
| `revokeCredential` | Interactive manager, workspace+credential CAS, live held handles rejected; atomic record/receipt/event | `machine credentials…`; **new** `audit revokeCredential…`, management matrix |
| `archiveWorkspace` | Owner only, CAS; new admissions/list visibility/replay denied; retained data and internal events | `concurrent last-owner changes…`; **new** `audit archiveWorkspace…`, management matrix |
| `readOperation` | Live caller; workspace+principal+operation partition; null is not proof of no in-flight commit; restart recovery; revoke/archive denial | `CAS, concurrent…`; `atomic rollback…`; `Q1 admission race…`; all new per-command recovery tests |
| `readEvents` | Exact factory reader identity, default disabled, workspace-local increasing cursor, bounded pages and versioned envelope; no duplicate retry event | `CAS, concurrent…`; **new** per-command event assertions, `audit management matrix…` foreign reader |
| `getAuthorizationServerMetadata` | Configured issuer/endpoints; only supported grants, public clients, S256 and scopes advertised | `OAuth metadata…` |
| `getProtectedResourceMetadata` | Exact configured resource and AS, header bearer only | `OAuth metadata…` |
| `registerOAuthClient` | Bounded redirect/metadata, no client secret, public code clients; atomic 100/hour and 10,000 total quota | `OAuth rules…`; `OAuth metadata…` hourly race; **new** `audit DCR…` total cap race and later-hour refusal |
| `getOAuthConsent` | Interactive principal matches live selected workspace scope; registered exact redirect, S256, resource/scope/state bounds; viewer ceiling; redirect errors safe | `OAuth metadata…`; `OAuth consent…`; `OAuth public API…`; `OAuth limits…` |
| `approveOAuthConsent` | Unforgeable unexpired consent bound to principal/workspace; recheck live role, idempotent input, hashed one-use code, atomic receipt/event/binding/code | `OAuth consent…`; `OAuth D1 atomicity…`; `OAuth limits…` |
| `exchangeOAuthToken` code | Correct client, redirect, resource, verifier; no consumption on wrong inputs; one use/expiry, concurrent consumption guarded; replay retires issued family | `OAuth code security…`; `OAuth D1 atomicity…`; `OAuth refresh rollback…`; PKCE/code-reuse mutations |
| `exchangeOAuthToken` refresh | Rotation with used-token tombstone; no scope escalation; live client/member/resource; expiry and absolute family lifetime; replay revokes entire family; atomic recovery policy | `OAuth refresh…`; `OAuth limits…`; `OAuth D1 atomicity…`; `OAuth refresh rollback…`; refresh-family mutation |
| `revokeOAuthToken` | RFC7009 unknown/foreign token success, hints advisory, both token types retire family, repeated revoke safe | `OAuth RFC7009…`; `audit errors…` |
| `getOAuthClient` | Interactive manager, workspace-bound consent record; foreign/absent same error | `OAuth public API…`; **new** management matrix and error equivalence |
| `revokeOAuthClient` | Interactive manager; workspace-local CAS and idempotent receipt/event, immediate family invalidation in that workspace | `OAuth live admission…`; **new** `audit revokeOAuthClient…`, management matrix |

### Wiki contract-to-test map

Names below refer to `tools/wiki.test.mjs`. The newly extracted minimal
`projectAuthorizationContract` executes unchanged expectations against Wiki's
Projects fake and, through the existing full contract, real Projects and Issues'
fake. It exercises write/read, direct project viewer, copied scopes and absent
projects. The Wiki fake now models project viewer denial as well as Access's
workspace/credential ceiling. It imports no provider implementation.

| Public command/query | Required behavior/invariants | Executable evidence |
|---|---|---|
| `createPage` | Live project write, bounded IDs/slug/title/Markdown, tenant/project slug uniqueness, immutable v1 revision, attribution; atomic FTS/revision/receipt/event | `rules validate…`; `create, edit, archive…`; `case-insensitive slug…`; `failed final event…`; **new** `audit every Wiki entry…` |
| `editPage` | Live write, CAS/concurrent single winner, preserve prior Markdown revision, replace FTS atomically; fingerprint/retry | `concurrent edits…`; `stale CAS cannot mint…`; `same operation retries…`; `failed final event…`; `Japanese, English…`; **new** `audit archive CAS…`, entry matrix |
| `archivePage` | Live write/CAS, terminal ordinary visibility, retained revisions/operation recovery, atomic FTS removal and event; retry not duplicated | `create, edit, archive…`; `same operation retries…`; `failed final event…`; **new** `audit archive CAS…` stale archive/fingerprint/tenant checks |
| `getPage` by ID | Same-workspace row; live project read; archived/foreign/absent denied | `two workspaces…`; `create, edit, archive…`; **new** entry matrix |
| `getPage` by slug | Workspace+project+slug predicate before return, live selected project, archived exclusion | `two workspaces…`; **new** entry matrix; slug-project mutation |
| `listPages` | Live project, workspace/project predicates, archived exclusion, ordered slug keyset/limit/end cursor | `two workspaces…`; `case-insensitive slug…`; **new** entry matrix and archive visibility |
| `searchPages` | Live project, tenant/project-confined literal FTS or short-term escaped LIKE; Japanese/English/mixed terms, edit/archive consistency | `Japanese, English…`; `two workspaces…`; **new** entry matrix; FTS-update mutation |
| `getRevision` | Live parent project even for archived pages, exact tenant/page/version; immutable original content/actor/client/time | `create, edit, archive…`; **new** entry matrix and distinct tenant revision content in `audit archive CAS…` |
| `listRevisions` | Same admission, descending version cursor/limit and immutable snapshots | `case-insensitive slug…`; `create, edit, archive…`; **new** entry matrix and distinct tenant contents |
| `authorizePage` | Live project read/write with credential/workspace/direct project ceiling; row belongs to caller tenant | **new** `audit every Wiki entry…` tests both modes under project revoke/archive, copied/revoked scopes and three credential/role ceilings |
| `readOperation` | Workspace+actor partition, current project visibility of saved result, archive/restart recovery, null for missing receipt | `two workspaces…`; `same operation retries…`; `Q1 admitted write…`; **new** entry matrix |
| `readEvents` | Factory-issued reader only, workspace/cursor/order, complete immutable envelope; no retry duplicates | `create, edit, archive…`; `case-insensitive slug…`; **new** `audit archive CAS…` foreign-factory/default-disabled capabilities and exact actor/version/tenant envelope |
| Q1 / public dependency fake | Admitted edit can commit after revoke; returned receipt reauthorizes, subsequent admission denied; fake matches provider's consumed contract | `Q1 admitted write…`; **new** `audit Wiki provider fake…`, shared contract on real Projects |

### Access attacker review

- **Fixed: KV JWKS poisoning.** A validly structured cache entry containing an
  attacker RSA key let that key authenticate a claimed existing subject. The new
  regression failed with `Missing expected rejection` before the fix. The
  verifier now only uses keys obtained from the configured HTTPS origin, retained
  locally for 300 seconds. JWT-controlled `iss`, `jku`, `x5u` or `kid` never select
  a fetch URL. KV contains only a cooldown hint. Cold starts fetch independently;
  normal refresh coalescing/cooldown, rotation, expiry and outage failure remain
  tested. This is a conditional KV-write-compromise attack, not an exposed HTTP
  exploit in the current placeholder Worker. No production KV was accessed.
- **Timing comparisons:** RS256 uses Web Crypto verification. Machine credential
  comparisons are SHA-256 digests of fixed 256-bit secrets, including the saved
  handle check; PKCE compares SHA-256 verifier challenges. These string comparisons
  are **not claimed constant-time**. Unlike a plaintext-password prefix oracle,
  digest-prefix timing does not enable incremental recovery of the input secret;
  chosen inputs still require SHA-256 preimages. OAuth lookup keys hash the entire
  token. Operation fingerprints are not authentication secrets. No exploitable
  plaintext secret comparison was found. Accepted here: residual lookup/existence
  timing is not equalized; no statistical timing-resistance claim is made.
  [Workers timingSafeEqual](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/#timingsafeequal)
  is available if a future plaintext secret comparison is introduced; do not
  replace it with a JavaScript loop advertised as constant-time.
- **Token format disclosure:** `pt1` exposes workspace and credential IDs; `pa1`,
  `pr1`, `pc1` expose workspace ID. These are routing identifiers, not authorization
  secrets; OAuth's user explicitly chose that workspace. Principal subject/email,
  role and membership are not embedded. Secrets are 32 random bytes and only hashes
  are persisted. Accepted metadata disclosure avoids a global cross-tenant token
  index. Treat the whole value as secret in logs/referrers; format alone never
  authorizes a workspace. A token holder already knows its workspace.
- **Errors/enumeration:** authentication uses `forbidden / Access denied` for
  absent, invalid, revoked and foreign credentials. Foreign/absent workspace,
  principal, membership, credential and workspace-client cases have exact matching
  code/message regressions. Known same-workspace memberships are intentionally
  visible to members, including inactive tombstones through `getMembership`.
  OAuth client IDs are public registration identifiers: `invalid_client` versus
  `invalid_grant` reveals client existence by design, while valid public clients
  still learn no principal/workspace from a bad grant. RFC7009 unknown/foreign
  tokens are indistinguishable successes. Gateway must sanitize raw storage
  errors; HTTP body/status/timing behavior is not yet tested here.
- **DCR abuse:** registrations are not unbounded: one SQL INSERT enforces 100 per
  rolling hour and 10,000 total, with metadata/redirect-size limits. Both last-slot
  races are tested. An attacker can exhaust the shared quota and deny new
  registrations; caps protect storage, not fair availability. Accepted for the
  unexposed module only: Gateway source/client request rate limits are required
  before public exposure; maintenance/cleanup must preserve live bindings and
  reuse tombstones. No background deletion or new operator service is added.
- **Consent CSRF:** the opaque consent handle is an intra-instance integrity
  capability, **not browser CSRF protection**. PKCE prevents unauthorized code
  redemption but does not establish the user's intent to approve a malicious
  client. Gateway must enforce the existing short-lived subject/CSRF-cookie-bound
  envelope, origin validation, fresh human assertion, explicit workspace and
  POST-only approval; never trust hidden redirect/client/scope fields, serialize
  the WeakMap handle, or issue a code on GET. These remain step 06 HTTP/E2E gates,
  consistent with [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html).

### 05a scope and remaining work

No public commands, queries, DTOs or event schemas are added. No tables,
migrations, owner dependencies, SQL catalogs, boundary checks or allowlists are
changed. Access still owns the eight core tables and five OAuth tables listed in
`architecture/modules.json`; Wiki owns pages/revisions/receipts/events/guards plus
its FTS virtual table and five shadow tables. The only runtime change is Access's
JWKS trust/cache policy; Wiki changes are tests only. The plan and Access operating
contract record that cache change and its cold-start fetch tradeoff.

Later evidence: Gateway browser CSRF/consent envelope, response sanitization,
source/client/authentication rate limits, actual OAuth/MCP client flows; real
Cloudflare smoke; expired OAuth-state retention/cleanup and availability under
quota exhaustion. No merge or deployment is part of this audit.

### 05a executed mutation probes

Run `node tools/audit-access-mutations.mjs [case-id]` and
`node tools/audit-wiki-mutations.mjs [case-id]` sequentially, without other source
writers or test bundles. Each probe first executes its healthy regression, then
mutates one target, regenerates catalogs for SQL changes, and requires a real
`ERR_ASSERTION` failure. Build/generation/setup failures and timeouts are invalid,
not kills. Source/catalogs are restored in `finally`; each script holds an
exclusive module lock and writes logs plus `reports/{access,wiki}-mutations.json`.
The two scripts share a generated catalog/test bundle, so do not run them together.

| Access mutation ID / injected defect | Detecting test prefix | Result |
|---|---|---|
| `live-membership`: return the old scope without fresh admission | `public provider contract…` | Killed |
| `revoked-credential`: ignore the revoked bit when reauthorizing a held machine identity | `machine credentials…` | Killed |
| `expired-assertion`: omit exp cutoff | `human JWT…` | Killed |
| `wrong-issuer`: omit issuer comparison | `human JWT…` | Killed |
| `wrong-audience`: accept arbitrary audience | `human JWT…` | Killed |
| `pkce`: bypass challenge comparison | `OAuth code security…` | Killed |
| `code-reuse`: issue a token response for a consumed code instead of rejecting/retiring it | `OAuth code security…` | Killed |
| `refresh-reuse-family`: reject reused refresh but leave its family live | `OAuth refresh…` | Killed; verifies family retirement, not just rejection |
| `oauth-confinement`: exempt OAuth identities from workspace bound | `OAuth public API…` | Killed with one person belonging to both workspaces |
| `machine-confinement`: exempt machines from workspace bound | **new** `audit confinement…` | **Survived original machine test**, killed after adding second-workspace membership |
| `viewer-write`: remove viewer write ceiling | `public provider contract…` | Killed |
| `admin-owner`: permit admin to manage existing owner in role rules | `public provider contract…` | Killed; SQL still prevents commit, but public forbidden contract detects missing role check |
| `last-owner`: remove transactional last-owner removal guard | `public provider contract…` | Killed |
| `last-owner-demotion`: allow demoting the sole owner | `concurrent last-owner changes…` | Killed |
| `scope-provenance`: fall back to caller-supplied identity fields for unissued scopes | **new** `audit provenance…` | Killed by direct rejection assertions |
| `jwks-kv-trust`: reintroduce trust in KV-supplied signing keys | **new** `audit JWKS…` | Killed; original unmodified runtime also failed the poisoning regression |

The initial scope-provenance probe was rejected by the existing provider-contract
helper with a plain Error, which the strict mutation runner classified as invalid.
A direct assertion regression now records a behavioral kill; it was not counted
as a surviving implementation. The machine confinement survivor was real: without
an extra membership, the unrelated membership check masked loss of token bounds.
The deliberately seeded extra membership is a defense-in-depth state, not a new
public way to assign a workspace-specific machine to another workspace.

| Wiki mutation ID / injected defect | Detecting test prefix | Result |
|---|---|---|
| `page-tenant`: remove page-by-ID workspace predicate | `two workspaces, project predicates…` | Killed |
| `slug-project`: remove slug lookup's project predicate | `two workspaces, project predicates…` | Killed |
| `live-write`: downgrade page write admission to read | `two workspaces, project predicates…` | Killed |
| `live-authorize`: remove page's live Projects authorization | `two workspaces, project predicates…` | Killed |
| `edit-cas`: remove expected version predicate | `stale CAS cannot mint…` | Killed |
| `changed-guard`: omit changed-row guard | `stale CAS cannot mint…` | Killed |
| `fts-update`: omit FTS insertion on edit (creation still indexes) | `Japanese, English, mixed…` | Killed |

All **23 selected mutants were killed by assertions** and each paired healthy
regression passed. Access has 40 tests (16 added); Wiki has 13 (three added).
This is a specific mutation campaign, not an exhaustive score. No test/boundary
allowlist was relaxed. The existing JWKS restart fetch-count expectation changed
because restart now obtains keys from trusted HTTPS instead of KV; it still checks
unknown-key denial, healthy cold-start login, bounded subsequent misses, rotation
and failure behavior. The reason is the independently reproduced trust defect,
not a need to pass CI.

## Gateway and Coordination independent test audit — 08a

Reviewed merged main `3bf12fa` against the owner decisions and rewrite-plan
§5/§7.1. Gateway covers both 06a REST/MCP and 06b OAuth HTTP. Coordination
uses only its own migrations in the isolated Miniflare suite; transport tests
use the real Worker, all provider schemas, and the official MCP SDK. These are
local workerd results, not deployed D1 or live third-party client certification.

### Behavior → test map

Names below identify executable tests in `tools/gateway.test.mjs` (G),
`tools/gateway-oauth.test.mjs` (O), `tools/gateway-oauth-rules.test.mjs` (R), and
`tools/coordination.test.mjs` (C). A row records the exercised scenarios, not an
exhaustive proof over the entire public input space.

| Surface / invariant | Executable evidence |
|---|---|
| REST/MCP catalog dispatch, errors, input rejection, retry/CAS and two tenants | G `REST/MCP parity…`; `official MCP SDK…`; generated descriptions in `transport limits…` |
| Human assertion and machine bearer are mutually exclusive; URL/header workspace must agree; Origin and JSON MIME enforced before provider dispatch | R **new** `audit Gateway guards…` asserts zero reads/writes on rejection; G `transport limits…` covers body size, request IDs and unknown fields |
| MCP write tools require write admission independently of owner enforcement | R **new** `audit Gateway guards…` uses an accepting Issues fake so a missing Gateway admission cannot hide behind the real owner's check; O `PKCE and redirect mismatches…` proves real read-only OAuth step-up |
| Ordinary exceptions and `PlatformError(unknown)` cannot expose internal details on REST/MCP | R **new** `audit Gateway guards…` injects both errors and checks exact sanitized responses; OAuth uncertainty independently covered by `provider-contract fake: backend uncertainty…` |
| OAuth credentials only on MCP; missing/invalid credentials produce WWW-Authenticate | R **new** guards; O `SDK discovery/DCR/consent/token…` uses actual OAuth tokens, SDK challenge parsing, discovery and DCR |
| OAuth browser envelope: exact Origin, cookie binding, signed form, subject binding, single consumer, safe redirect and denial | O `CSRF origin/cookie/signature/subject checks…`, **extended** with a present but wrong CSRF cookie; concurrent approval requires exactly one 303; unregistered redirect returns 400 without Location |
| OAuth token endpoints: PKCE, exact redirect, refresh rotation/replay, revoke, live workspace and scope | O `SDK discovery…`; `PKCE and redirect mismatches…`; metadata/CORS/rate limits in `metadata aliases…`; R parser/limiter fakes test fail-closed provider calls |
| `startSession`, `heartbeat`, `endSession`: ownership, liveness, terminal expiry/end, release related claims/leases | C `concurrent acquire…`, `limit CAS…`, `heartbeat keeps…`, `endSession releases…`; **new** every-command rollback/retry/restart matrix |
| `acquireLease`: exactly one holder and monotonic fence across release/reclaim/restart | C `concurrent acquire…`, `stale lease reclaim…`; **new** `audit live holder…` uses live competing sessions and same-session reacquisition |
| `renewLease`, `releaseLease`, `reportProgress`, linked `claimFiles`: stale token rejected while session is live | C **new** `audit live holder…` asserts no receipt, report, claim or lease change; four **new** `audit SQL fence survives admission race…` tests advance the stored token immediately before batch execution, proving SQL guards independently of prechecks |
| `setProjectLimit`: manager policy, CAS, capacity at exact boundary, race | C `WIP cap…`, `limit CAS…`; every-command matrix verifies receipt failure/replay; off-by-one mutation must kill the competing-acquire test |
| `claimFiles` / `releaseFiles`: exact paths, whole-call atomicity, force requires project manager | C `WIP cap…`, `endSession…`; **new** `audit claim race…` inserts a competitor after preflight and conflicts on the second path, checking the first path rolled back; **new** `audit claims reject…` denies a normal member force even with a valid current lease |
| `getLease`, `listLeases`, `listClaims`: tenant filtering with visible nonempty datasets | C **new** `audit claims reject…` populates both workspaces with distinct lease/claim contents and checks both directions; existing tests cover live revocation and missing lease |
| `reportProgress`: latest and bounded immutable history are atomic with receipt/event; never changes Issues | C **new** history order/retention/rollback tests; G `two MCP SDK agents…` checks real Issues remains `todo`, and REST/MCP history parity |
| `getProgress`, **new** `listProgress`: live issue authorization, workspace/issue isolation, newest-first keyset, no timestamp ambiguity | C **new** `audit report history preserves…` writes equal-timestamp reports, interleaves a new report between pages, checks restart/replay, invalid bounds, another issue/workspace and revoke |
| History retention / migration | C **new** `audit history retention…` checks exactly 1,000 rows and rollback of pruning; `audit progress migration…` builds immutable 0001, inserts a legacy latest row, then applies 0002 and checks preservation |
| Every command: failed receipt rolls back owned state; replay has no repeated effects; restart recovery | C **new** `audit every command…` injects failure in the receipt INSERT for all ten commands and snapshots all nine owner tables before/after; then runs healthy command, restart retry and `readOperation` |
| `listSessions`, `readOperation`, `readAgentEvents`, internal `readEvents` | C **new** `audit session visibility…` checks own versus admin visibility, actor/workspace receipt partition, concurrent report retry, exact event envelope/order, tenant/principal filtering, copied/foreign-factory reader denial and invalid cursors/limits; G `two MCP SDK agents…` checks event REST/MCP parity |
| Consumed dependency contracts | **new** `coordinationProviderContract` runs on C's isolated Access/Projects/Issues fakes and G's real providers; tests copied-scope rejection, read/write ceiling, manager versus editor, missing issue and returned issue/project identity |

### Findings and changes

1. **Overwritten progress (owner finding):** retain `coord_reports` for a fast
   latest read, add `coord_report_history` with tenant/issue/sequence primary key.
   Reports append and prune to the most recent 1,000 entries in the existing
   guarded transaction. New `listProgress` returns newest-first keyset pages
   (default 50, maximum 100). Migration 0002 preserves the old latest row;
   already overwritten reports are unrecoverable. Same-operation retry does not
   duplicate history. Fencing, event schema and provider edges are unchanged.
2. **Internal error leakage:** Gateway previously returned the message of every
   PlatformError, including `unknown`. It now sanitizes that code as well as
   ordinary exceptions; known actionable error messages retain their mapping.
3. **Test blind spots:** stale-session rejection could hide missing fencing;
   claim preflight could hide partial transaction commits; real owner admission
   could hide missing MCP admission; an absent cookie did not test comparison
   of a present incorrect cookie. Dedicated negative fixtures isolate each check.

The 1,000-report retention limit is a bounded operational history decision for
this owner request, documented in [Coordination](coordination.md). Paging does
not pin rows against pruning. Only this new oldest-tail retention deletes rows;
retained reports are never updated. No existing migration, boundary checker,
allowlist, dependency edge or assertion was relaxed. Plan §4 and §8 now record
the history query/table and this audit step.

### Executed mutation probes

`node tools/audit-gateway-coordination-mutations.mjs [case-id]` runs one/all
probes sequentially, first requiring the matching healthy test to pass. It
refuses an existing lock, checks exact source targets, regenerates catalogs for
SQL changes, and restores source/catalogs in `finally`. Never run it alongside
other source writers or test bundles. A crashed process requires inspection
before deleting the lock. Detailed healthy/mutated logs and machine-readable
results go to `reports/08a-*` and `reports/gateway-coordination-mutations.json`.
Use `--original case-id...` to run the original suites from `3bf12fa`; these
results/logs have an `original-` marker and survivors are expected audit evidence.
Only a failing behavioral assertion counts as killed, not a setup/build error.

| Mutations | Detecting regression |
|---|---|
| `dual-credentials`, `workspace-header`, `origin`, `non-json`, `internal-error`, `mcp-write-scope`, `oauth-on-rest`, `www-authenticate` | R `audit Gateway guards…` |
| `form-replay`, `csrf-cookie`, `unregistered-redirect` (unsafe fallback redirect after consent validation fails) | O `CSRF origin…` |
| `two-live-holders` (remove precheck and SQL vacancy condition) | C `audit live holder…` |
| `stale-reportProgress`, `stale-renewLease`, `stale-releaseLease`, `stale-claimFiles` (remove both token precheck and corresponding SQL token predicate) | C `audit live holder…` |
| `sql-fence-reportProgress`, `sql-fence-renewLease`, `sql-fence-releaseLease`, `sql-fence-claimFiles` (SQL-only removal) | C four `audit SQL fence survives admission race…` |
| `wip-off-by-one` | C `WIP cap…` |
| `partial-claim` (commit each guarded claim separately) | C `audit claim race…` |
| `force-non-manager` | C `audit claims reject…` |
| `tenant-lease`, `tenant-leases`, `tenant-claims` | C `audit claims reject…` |
| `issues-state` (report calls real Issues transition API) | G `two MCP SDK agents…` |

The campaign is a bounded list of specific faults, not an exhaustive mutation
score. Remaining later-step evidence: real Cloudflare smoke/resources, live
Claude Code/Dots interoperability, Web timeline usability, and any future
permanent audit retention or export policy. The existing 100-row session/lease/
claim list limits and event/receipt lifecycle remain unchanged.

08a executed result: **27/27 mutants killed**, each paired healthy regression
passed. Five selected probes were additionally run against the unchanged test
files from `3bf12fa`: `mcp-write-scope`, `csrf-cookie`,
`sql-fence-reportProgress`, `partial-claim`, and `force-non-manager` all
**survived the original suites** and were killed by the added regressions.
The partial-claim probe splits only guarded claim groups, preserving each local
CAS guard, so the result specifically tests cross-path atomicity rather than
breaking all guarded commands during setup.

## Web, 07b contracts and 06c smoke independent audit — 07c

Baseline: merged `5a5f94a`. Reviewed the owner contracts and observable behavior
before extending tests. Access and Coordination still use only their own
migrations with public provider fakes; Gateway tests use the composed Worker.
Browser verification is headless Chromium only, as explicitly required for this
VM audit. All heavy processes and mutation probes run sequentially.

Three runtime corrections were necessary: REST had started accepting MCP-resource
OAuth tokens; OAuth-derived owners could change WIP policy; aborted queries could
still paint a decoded response after workspace switching. The latter two were
reproduced by new behavioral tests before fixing them. REST rejection restores
the previously documented resource boundary, including `/api/me`, `access.create`
and workspace listing. OAuth agents discover identity through MCP `access.me`.
The earlier 08a `oauth-on-rest` probe's source anchor had drifted; it is updated
and its original rejection assertion restored. No checker is relaxed.

### Behavior → test map

A = `tools/access.test.mjs`, C = `tools/coordination.test.mjs`,
G = `tools/gateway.test.mjs`, O = `tools/gateway-oauth.test.mjs`,
R = `tools/gateway-oauth-rules.test.mjs`, U = `tools/web-unit.test.mjs`,
B = `tools/web-e2e/{core,audit}.spec.mjs`, S = `tools/smoke.test.mjs`.
Names below are test-name prefixes.

| Behavior / invariant | Executable evidence and what it proves |
|---|---|
| Markdown retains safe markup, removes scripts, event attributes and `javascript:` links | B `project, issue…`: real Wiki rendering checks DOM attributes/elements and absence of script side effects; sanitizer bypass and separate allow-script/event/URL probes |
| Workspace switch rejects late responses, including already fetched/delayed JSON | B `07c late decoded…`: holds old response decoding until new workspace is visibly loaded, releases it and checks the new view remains; original delayed project-response scenario retained |
| Unknown outcome retries exact operation ID, version and payload | U `unknown retries…`, `server unknown…`, `OAuth client revoke retry…`; B `project, issue…` lets create/revoke commit then loses the response and compares retry bytes |
| Conflict, validation error and unknown outcome preserve typed drafts | B `project, issue…` (real Wiki CAS conflict and lost issue response); B `07c validation error keeps…` (project form validation failure) |
| One-time credential is never stored in localStorage or shown after leaving Admin | B `07c validation error keeps…`: issues a real credential, checks token and secret suffix absent from storage, navigates away/back and reloads |
| No test assertion injector/route in production artifacts | `tools/artifact.mjs`: all executable bundles scanned; probes insert a test route or issuer and recompute the artifact checksum so the intended exclusion assertion must detect it |
| Browser operation path/method comes from OpenAPI; unpublished operation fails before a business request | U `OpenAPI-derived…`, `07c unpublished…`: missing operation produces unsupported/no request; relocated published operation uses its new path |
| `/api/me` is read-only discovery; humans/machines allowed, OAuth REST denied | G `07c /api/me…` verifies empty discovery and unchanged membership count for an unjoined signed human; original G human/machine discovery; R `audit Gateway guards…` and O SDK/PKCE tests reject valid OAuth on REST |
| OAuth `access.me` works through MCP; machine/OAuth credentials cannot expand workspace discovery | O `PKCE and redirect…`; A `07c discovery…` seeds extra machine membership; A `07c OAuth discovery…` gives the underlying human two workspaces and tests both principal/scope APIs |
| Member/client lists are tenant confined and use bounded exclusive keysets | A `07c discovery…`: populated foreign workspace, exact ordered identities across one-row pages, terminal cursor; original viewer denial and limit validation remain |
| Viewer and OAuth-derived principal cannot revoke a client | A original management matrix, `07c discovery…`, `07c client revoke…`; real public Access authorization and no client state change |
| Client revoke retires access and refresh, preserves other client, CAS/retry semantics | A `07c revoke invalidates…` independently tests each token; A `07c discovery…` checks same-operation replay, stale conflict and second client's authentication/refresh; O `PKCE and redirect…` revokes through human REST, then verifies MCP 401 and refresh invalid_grant |
| Project reads isolate both workspace and project; exact page limit and compound cursor | C `07c project pages…`: two tenants, two projects, three local rows, exact ID order, tied progress timestamps and different claim repositories, one-row pages and terminal cursors, live provider denial on every read |
| Expired sessions/leases never appear as live project work | C `07c project pages…`: independent session and lease deadlines at equality; claims enforce their own and lease expiry. Progress remains historical by design |
| Viewer/OAuth owner cannot set WIP cap; human owner can, with CAS/retry | C original `project pages expose…`, new `07c OAuth owner…`; O `PKCE and redirect…` exercises real OAuth over MCP |
| Missing either smoke credential is nonzero; API token is not printed | S `07c smoke missing either…` requires exit 78 for three combinations; S `07c smoke successful…` exercises script orchestration with only subprocesses stubbed, using a fake sentinel |
| Smoke Worker protects probes and performs real local storage checks | S `07c smoke Worker…`: missing/wrong secret rejected; existing `checkSmoke` executes migrations twice, D1 rollback/bind limit, R2 cleanup, REST/MCP retry/CAS/search |

### Reproducible mutation evidence

`node tools/audit-web-contract-mutations.mjs` runs the bounded campaign; optional
`--group=server`, `--group=browser`, `--group=artifact` or exact case IDs select a
subset. Each distinct command must pass healthy first. Source targets must match
exactly, SQL catalogs regenerate, and a lock plus `finally` restore source and
catalogs. Artifact probes repair hashes before validation. Only behavioral
assertion failures count as kills; setup/compiler errors are invalid. Logs and
JSON results are under `reports/07c-*` and `reports/web-contract-*-mutations.json`.
Do not run alongside another build/test/source editor.

No public command/query/event or table was added. Owner registry/dependencies and
migrations are unchanged. The plan now explicitly restricts WIP policy changes
to interactive owners/admins, matching the owner's audit requirement. Remaining
later-step evidence: protected-main real Cloudflare smoke and live client/provider
interoperability; local workerd and subprocess stubs do not establish those.

Executed result: **58/58 current mutants killed**, with healthy regressions
passing. The original `5a5f94a` tests **survived all three** selected probes:
`unpublished-route`, `projectClaims-cursor`, and `projectProgress-cursor`. Reproduce
that comparison with `--original` followed by those IDs. The same probes are
killed by the added regressions. Removing unrelated-client confinement initially
produced an unwrapped domain error; the regression now explicitly asserts that
the second client's authentication/refresh must succeed, and the rerun is an
assertion kill. No setup failure is counted in the 58 results. This is a bounded
campaign, not an exhaustive mutation score.

Final local verification: the single `pnpm verify` run exited 0 (133 module tests,
Gateway, Web unit, smoke, boundary/schema/type/lint checks, build and artifact
validation). The three affected headless browser scenarios passed healthy before
their mutations; GitLab's browser job also runs the unchanged discovery/mobile
scenarios. No GUI browser, real Cloudflare deployment or production credential
was used for this audit.

## Assets independent audit — 09a

Reviewed merged step 09 at `e74f4cb`, the Assets contracts, §7.1 and owner Q1.
Scope is `modules/assets`, Platform `createScopedBucket`, Worker `scheduled`,
and Assets Gateway/Web operations. The original seven module tests are retained.
The audit uses Assets-only migrations in Miniflare D1/R2 with public dependency
fakes; `assetsProviderContract` also runs against real Access/Projects/Issues/Wiki
in the HTTP integration fixture. No foreign migrations enter the isolated suite.
All heavy processes/probes run sequentially; browser evidence is headless only.

In the table, A = `tools/assets.test.mjs`, G = `tools/gateway.test.mjs`,
O = `tools/gateway-oauth.test.mjs`, B = `tools/web-e2e/core.spec.mjs`.
Names starting with `09a` are new regressions. A row describes executable
scenarios, not coverage of every possible input or deployed Cloudflare evidence.

| Behavior / invariant | Executable test prefix | Finding / evidence |
|---|---|---|
| Scoped R2 `get/open/put/delete` rejects foreign owner/workspace, empty suffix, dots and slashes; valid keys still work | A `09a R2 every method…` | Seeds actual forbidden objects and proves rejection without overwrite/delete; tests `open` and all invalid forms, previously missing |
| `completeUpload` independently checks stored size, SHA-256 and presence | A `09a complete independently rejects size/sha256/missing…` | Wrong-size object deliberately has the correct digest; original mismatches let the size-check mutation survive. Every rejection preserves all seven owned tables |
| R2 put failure and complete D1 failure remain recoverable | A `stored bytes are checked…` | Original fault test retained, including pending GC job and successful completion retry |
| Two tenants cannot read/link one another's metadata | A `begin, R2 verification…`; G `Assets binary REST…` | Original module/HTTP isolation tests retained; new adapter and scheduled tests exercise both workspace prefixes |
| Download requires at least one visible link; last unlink prevents future download | A `begin, R2 verification…`, `unlink schedules GC…`; G `Assets binary REST…`; B `09a attachment…` | Denies unlinked completed and retired objects; cached relative URL stops working after unlink |
| Project archive, membership revoke and another project's viewer cannot download | A `archive or membership revoke…`, `09a download after membership revoke…`, `09a download checks…` | Dedicated membership regression reaches revoke independently; outsider can view p2 but cannot download p1 |
| Metadata/URL lookup is not a grant to stream bytes | A `09a download checks…`; G `09a issued download URL…` | Archive the target after resolving the URL; actual subsequent GET must reject before streaming |
| HTML and SVG always download as attachments, with nosniff/no-store | G `09a HTML and SVG…`; B `09a attachment…` | **Runtime defect:** nosniff was absent. Regression failed with null header before fix; browser receives a download and does not execute HTML |
| MCP is metadata/URL-only; binary operations are REST-only | G `09a HTML and SVG…`, original `Assets binary REST…` | Exact text payload contains only the relative URL; no binary tools advertised; raw-byte mutation is rejected |
| Read-scoped machine, OAuth viewer and OAuth owner with read-only consent cannot write | G `09a read-scoped machine…`; O `09a OAuth viewer…` | Exercises begin/complete/link/unlink over MCP and binary PUT; OAuth uses SDK discovery, consent and token exchange, checks insufficient_scope |
| Every command's operation ID binds each input and replays one durable result | A `09a beginUpload/completeUpload/linkAsset/unlinkAsset retry binds…` | Each input field varied independently; restart replay and receipt lookup preserve snapshots of all seven tables; catches duplicate blob on retry |
| Link/unlink stale CAS and concurrent contenders produce no loser receipt | A `09a linkAsset/unlinkAsset stale CAS…` | Stale snapshots unchanged, including a fault-injected missing current history row; concurrent distinct operations produce one winner/version increment and one receipt. Removing the guard originally survived because the history primary key accidentally rejected stale writes |
| GC job is committed atomically with begin/last-unlink metadata | A `09a beginUpload/unlinkAsset cannot change metadata…` | Inject an INSERT trigger failure on the GC job: all business/history/receipt/event rows must roll back, then retry succeeds. Same-transaction statement order is not treated as a defect |
| GC preserves still-linked objects | A `09a GC preserves…` | Link both issue and wiki; unlink only one, drain its stale job, then verify actual R2 bytes and remaining link |
| GC resumes after R2 delete but before D1 commit | A `09a GC preserves…`; original `unlink schedules GC…` | Inject D1 failure after successful delete; assert absent R2, retained job/blob; fresh factory drains twice safely and receipt remains |
| Never-completed and completed-but-unlinked uploads expire | A `unfinished upload expires…`, `completed but never linked…`; G `09a Worker scheduled GC…` | Before-expiry negative control; real Worker scheduled event removes actual R2 bytes, blob and job in two workspaces; repeat event is safe |
| Expired pending upload cannot complete/link during collection | A `09a expired pending GC…` | **Runtime defect:** completion/link succeeded immediately before R2 deletion. Regression now proves pending state is closed before deletion; late completion conflicts without receipt/link |
| Size cap includes exactly 10 MiB and excludes one byte more | A `09a begin size boundary…`; G `09a binary PUT…` | Checks oversized begin leaves no rows; exact-cap begin, put and stored-byte completion succeed. HTTP rejects cap + 1 without replacing the completable object |
| Dependency fakes follow consumed authorization contracts | A `09a Assets dependency fakes…`; G `09a real Access Projects Issues Wiki…`; `tools/assets-provider-contract.mjs` | Shared editor/viewer, copied scope, missing ID and project association assertions run on fakes and real providers |
| Web retains the completion operation ID after a lost response and unlinks correctly | B `09a attachment…` | Commit completion, abort its response, retry through UI; assert same input, one attachment, safe downloaded filename, then removal and stale URL 404 |
| Event and receipt queries remain tenant/capability scoped | A original `begin, R2 verification…`; per-command snapshot/replay cases | Existing three-event/receipt assertions retained; snapshots detect duplicate audit rows. Full event paging/capability matrix is not claimed by this audit |

### 09a reproducible mutation evidence

Run `node tools/audit-assets-mutations.mjs [case-id ...]` alone. It validates a
healthy regression once per selected command, injects the named defect, captures
logs under `reports/09a-*`, writes `reports/assets-mutations.json`, and restores
source/generated files in `finally`. It uses an exclusive audit lock. A kill
requires an assertion failure; build/import/runtime errors without an assertion
are invalid, and a missing regression cannot count as success. Selected reruns
replace only those case records in the JSON report; a full run replaces all.
Early GC/cap probes exposed non-assertion failures (null decode, proxy failure
serialization, or an unwrapped success-path rejection); assertions were made
explicit and those probes rerun, rather than counting those failures as kills. The browser probe
uses the same headless fixture as CI. ANSI formatting is stripped before
classifying its assertion log; the recorded Web failure was reclassified from
that existing log, without rerunning the already executed browser mutation. These are bounded faults, not an exhaustive
mutation score. Redundant admission checks are removed together only for the
explicit authorization-bypass probes, so their outcome is an observable defect.

Original-suite probes are reproducible with:

```sh
node tools/audit-assets-mutations.mjs complete-size complete-missing \
  unlinkAsset-cas beginUpload-gc-job gc-still-linked size-exclusive --original
```

`--original` substitutes only the original test file from `e74f4cb` and restores
it afterwards. The original suite **survived** complete-size, complete-missing,
unlinkAsset-cas, gc-still-linked and size-exclusive; beginUpload-gc-job was
already killed. The new regressions distinguish these cases instead of relying
on unrelated checks or a checker freshness failure.

| Injected defect IDs | Detecting regression |
|---|---|
| `r2-{get,open,put,delete}-prefix`, `r2-prefix`, `r2-dot`, `r2-slash` | A `09a R2 every method…` |
| `complete-size`, `complete-hash`, `complete-missing` | A independent stored-object checks |
| `download-unlinked`, `download-project`, `download-membership`, `download-other-project` | A last unlink, archive, dedicated revoke and other-project viewer cases |
| `download-stream-permission` | G issued URL followed by target archive and denied binary GET |
| `download-attachment`, `download-nosniff`, `mcp-raw-bytes` | G HTML/SVG response headers and exact MCP URL-only content |
| `retry-input`, `retry-duplicate-blob` | A changed-input matrix and full-table replay snapshot |
| `{linkAsset,unlinkAsset}-{cas,guard}` | A stale version and all-table rollback |
| `{beginUpload,unlinkAsset}-gc-job` | A failed job insertion must roll back metadata |
| `gc-still-linked`, `gc-job-early-remove`, `gc-not-idempotent` | A real R2 bytes, durable crash recovery and second drain |
| `gc-pending-leak`, `scheduled-no-gc` | A expiry; G scheduled event removes real data |
| `gc-pending-completion-race` | A deterministic completion/link attempt before deletion |
| `size-exclusive`, `size-extra-byte`, `put-size-exclusive`, `gateway-size-exclusive`, `gateway-body-size-exclusive` | A/G exact maximum and maximum + 1 across begin, PUT and HTTP header/body checks |
| `mcp-write-scope`, `oauth-write-scope` | G read machine / O OAuth read grant cannot begin an upload |
| `web-retry-new-id` | B response-loss retry retains the same completion operation ID |

Final mutation result: **40/40 killed**, with no survivors or invalid cases.
Original baseline: five of the six specified historical probes survived; the
GC-job omission was already detected. The two runtime fixes each failed a new
behavioral regression before repair. Focused headless Web acceptance passed.

### 09a changes and limits

Runtime fixes are the download nosniff header and retiring pending as well as
ready unlinked uploads before GC deletes R2. The latter updates the existing
static `retire` query and its generated catalog; it adds no schema migration.
There are no new commands, queries, events, owner resources, dependencies or
plan deviations. The unchanged Assets tables are `assets_blobs`, `assets_links`,
`assets_gc_jobs`, `assets_history`, `assets_receipts`, `assets_events`,
`assets_guards`. Public commands remain begin/complete/link/unlink plus binary
PUT; queries remain metadata/list/download/operation/events, with private
composition-driven maintenance GC.

Authorization evidence concerns new download requests (Q1), not revocation of
bytes already delivered or per-chunk reauthorization. Local Miniflare evidence
is not deployed R2/D1 evidence; main-only Cloudflare smoke remains separate.
The controlled GC race covers completion/link versus collection, not arbitrary
process scheduling or every in-flight upload/R2 failure interleaving. No
production bindings or deployment settings changed.


Validation: `pnpm verify` was invoked once. Its first formatting gate found one
Web test formatting difference; after correcting and checking that file, the
not-yet-run steps from the same script were executed sequentially. All passed:
type checks, owner/public/SQL boundaries, 62 boundary-checker tests, 158 module
tests, migration checks, build, artifact smoke, Gateway/OAuth, Web unit and smoke
tests. The focused headless attachment test passed separately; CI also runs the
whole browser suite. No check, allowlist or expected error was relaxed.
