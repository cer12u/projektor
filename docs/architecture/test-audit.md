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
