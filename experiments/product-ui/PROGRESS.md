# I5 product UI, 2026-10-08

## Current checkpoint

- Owner scope: React/TypeScript/Vite UI only. No Store, schema, issuer, credential, production config, deploy or merge edits.
- Reviewed I2 source baseline: PR7 head 5c76a7ac3770f2b9d88cf696eca0a58e91780b0d; four client/browser modules remain byte-identical to projektor_agent_workflow_20261008; client/issue-content.mjs is the reviewed manual-recovery patch 5881771e1d14a42a8c9d5073947bf34b40ac7d29cdd524a283cda26188264f99. Pure CRLF input projection is separately copied into TypeScript to avoid importing laboratory DOM auto-mount hooks in the product bundle.
- Product entry calls the explicit session-owner bootstrap/session/key ports and fails closed on unavailable/denied responses. The distinct fixture build uses existing I2 synthetic authenticated HTTP service and encrypted DraftVault. A fixture is not a product/provider acceptance result.
- Implemented React views: bootstrap zero/one/multiple workspaces, current principal/Agent labeling, My Issues and same-query thin board, project picker, Issue creation/detail/title/body/comments/assignee/priority/progress/status/history, loading/empty/partial/error/locked states, bound deep links, guarded in-app/history navigation.
- Integrated client-owner adapter: title/progress/transition modes, selected-workspace session, bootstrap, resource-bound key-provider. The service ports still require exact-head product ingress and real provider evidence. Pending domain-owner adapter: Wiki and artifact UI.
- API coordination: session-ports owner supplied createSessionAPI and HumanWorkflowController; fixed source manifest SHA-256 40ca888b61de558ac9137068c2f96da699065f928ff6e25600da5b775295e690. Bootstrap permits no application principal for zero memberships; workspace-local principal IDs are preserved rather than unified by email or guessed identity.
- React is a view/input adapter. Existing IssueContentController, MyIssuesController, bounded transport, receipt reconciliation and DraftVault perform client protocol work.

## Verification at checkpoint

- Node 24.19.0, npm 11.9.0
- Fixed official registry packages and committed package-lock.json
- npm run build: PASS
- npm test: PASS (104 tests; includes 84 reused I2 tests and 20 UI/port/flat-field checks)
- Fixture build: PASS
- Twelve real Chromium scenarios prepared in e2e/product.test.mjs: NOT_RUN locally, reserved for approved same-PR CI
- Real Access/provider renewal, production bootstrap/key lifecycle, live data, screen reader/touch/zoom/manual accessibility: NOT_RUN
- Full CC15/CC17/E01–E16 product acceptance: NOT_PASS; see ACCEPTANCE.md

## Commands

npm ci --ignore-scripts
npm run verify
PROJEKTOR_CORE_SOURCE=../atomic-command-poc npm run test:e2e

The E2E source directory defaults to the frozen sibling source in this scratch workspace. In the repository integrate this package beside experiments/atomic-command-poc, then set PROJEKTOR_CORE_SOURCE explicitly as above. Reuse the approved CI's installed Chromium (CHROMIUM_PATH if required). Do not interpret a missing browser or core fixture as a skipped pass.

## Remaining work

1. Integrate the owner's server ingress alongside the UI at exact release head; validate real provider/key lifecycle
2. Independent UI review and same-PR Chromium run on exact integrated head
3. Owner-driven Wiki/artifact adapters and cross-feature acceptance
4. Required real provider, migration, manual accessibility, backup and cutover evidence remain outside this UI checkpoint

## Independent review underway

UI/session-only read-only review requested by parent. Artifact integration and any containing aggregate are excluded. No local Chromium, deployment, live login, permission change, commit publication or merge was performed.

## Navigation evidence limits

The UI stores non-content scroll/focus and editor selection offsets in history.state. Editor position is principal/workspace/draft bound; plaintext remains in the existing encrypted vault. Full provider recovery navigation manifests and complete pagination restoration remain unproven.


## Review fixes, 2026-10-08

- Same-principal project revocation: picker clears/aborts while locked, uses fresh bootstrap accessRevision and rejects stale response binding before names can return
- Registry bound kept at architecture limit 10; owner service/client now reject 11, with no truncation or guessed workspace
- History push/replace exceptions cannot advance the internal route/index; cursor-position metadata failures are distinct from plaintext protection
- Original source display name/ID/resolution retained; null author time is unknown; time quality/source edit time/import recorder shown separately
- Workspace picker has explicit accessible Cancel and focus return; cancellation does not mutate URL or draft
- Editor navigation also requires durable opaque draft ID/original-scope locator in the current URL
- Twelve Chromium test cases prepared, including delayed old project response after same-principal revoke/resume; none executed locally

### Shared-client manual receipt correction integrated

The inherited automatic budget previously blocked manual receipt checks after 60 seconds/six reads. The shared owner corrected this in a separately reviewed patch, then the UI copied the exact approved file without further protocol edits:
- client SHA-256: 5881771e1d14a42a8c9d5073947bf34b40ac7d29cdd524a283cda26188264f99
- owner patch manifest: 548df46671cd9820c53c8591ce027473af61e7accb5ec940bf05c06f457e6772
- checkResult() now performs bounded, fresh-session, receipt-only manual checking, independently of the old resend budget
- retry:true retains its original send budget; manual checks never create or send a new command
- automatic-budget/manual-budget/backoff/protection failures have explicit UI notices
- reviewer confirmed the former failure witness and six independent manual cases pass against this exact UI vendor file

### Input retention and prepared browser evidence

Temporary absent membership retains the previous controller only as a locked, non-authoritative view. Root locking synchronously invalidates its requests and clears keys before paint; header/navigation never read retained identity. The same verified principal/kind/workspace/epoch reuses the same controller reference and freshly reauthorizes draft keys/current resource before reopening. Another binding replaces and erases the old controller. Unprotected drafts block navigation; already protected locked drafts may leave only with their durable opaque locator.

Prepared browser tests now include native Back cancellation under storage failure, Back/Forward protected restoration, and absent-membership recovery of unpersisted in-memory text. Synthetic projects have deterministic distinct names; revocation tests select the known primary project and retain the still-readable secondary project. These cases remain NOT_RUN locally.

A committed create draft disables Save to prevent a second Issue from the same completed create view; newer unsent fields remain visible and protected until the user explicitly continues editing.

Current source hash (SOURCE-SHA256SUMS): 474f371b603760ec7162a1bdeb7c214d839bad7cb5499a744d96f1117b5b70de.
