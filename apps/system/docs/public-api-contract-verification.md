# Public API contract verification (PTORDEV33)

## Artifact and scope

`openapi.json` is the composed OpenAPI 3.1 contract: 81 explicit paths and 94 operations. Rebuild using `node scripts/contracts/generate-execution-openapi.mjs && node scripts/contracts/build-public-openapi.mjs`. `openapi-base.json` is the frozen accepted32 starting input, not the published contract. The generator corrects it against the current worker and composes the separately owned execution/report fragment without overwriting schema names.

Included: health, login/session identity/logout, initial/reset setup management and holder flow, fixed-owner initial bootstrap, browser exchange, project access, Issue create/read/list/edit/history/receipts/assignees, project/workspace Wiki and comments, source records/history, legacy URL resolution/directory, management context/records/history/registration/mutations/receipts, execution leases/reports/reconciliation/restart/receipts.

The contract includes the protected recipient context/status/completion/retirement routes. No delete API, new public credential issuance, administrator-assignment API, wildcard permission, automatic enrollment, old-auth fallback, deployment operation, or external agent integration is invented. Deployment management remains a private executable interface, not a public HTTP endpoint. New-core features omitted from runtime remain omitted rather than being claimed through documentation.

## Important distinctions

- Body mutation limits do not restrict preserved source bodies or already-stored snapshots. Native IDs and preserved UUIDs are accepted where runtime accepts both.
- Input actor/authority extras are rejected. References preserve string Library version IDs and raw original URLs, with rendering safety separate from persistence.
- Current read and historical operation receipt are different contracts. Receipt lookup checks current credentials, recorded operation permissions and current target visibility; it does not grant current lease ownership.
- Issue PATCH requires view plus permissions for changed fields: edit for body/title/references/priority/schedule/parent/type, assign for assignee, transition for state. No permission hierarchy is implied.
- Admin authority is separate from project view/manage. Directory/context may succeed with empty project lists. Public management registration does not issue credentials or assign administrator status.
- The importing gate intercepts ordinary data and management requests before authentication, but auth/setup routes and setup-management routes are evaluated first. Stopped mode allows reads and blocks common mutations; retry header presence differs between the outer router and caught domain errors.
- Original source records/history retain arbitrary original JSON intentionally; their envelopes are typed. No fictional operation IDs, revisions or current authentication status are attached to imported historical data.
- New administrator setup requires a recipient context established before issuance, exact Origin and scoped CSRF; completion confirms the bound target, purpose, issuer and operation. Legacy bearer consumption remains only for previously issued unbound rights. See [recipient setup](recipient-password-setup.md). Signed Access assertions authorize only the configured fixed-owner bootstrap and are not ordinary application authentication.

## Evidence

`node tests/integration/http/check-public-openapi.mjs` compiles every response schema using Ajv and exercises the actual product worker in ephemeral local workerd/D1. It validates successful request bodies, observed HTTP statuses and response bodies, no-store headers, every documented operation's reachability, and denial envelopes without snapshot disclosure. No auth or database mocks replace the product boundary.

`python tests/integration/schema/check-public-schema.py` independently checks schema objects against JSON Schema 2020-12 and resolves every local reference. This is not presented as a full third-party OpenAPI conformance certification. Standard schema keywords are executable; `x-max-utf8-bytes`/`x-max-json-utf8-bytes` document runtime byte constraints not expressible as ordinary JSON Schema character limits.

The integration harness covers positive create/edit/readback/history/receipts across project and workspace content; input rejection and revision conflict; explicit management operations; synthetic password initial completion, login, logout and session invalidation; browser ticket exchange and replay denial; source/legacy resolution; importing/stopped gates; revoked credentials; execution report schemas; interrupted reconciliation/restart; and rejection of restart when the prior attempt already has a completed result.

The harness observes all 94 operations, including all four recipient routes, waiting/ready/completed state, same-operation recovery, active-bound retirement rejection, missing-capability uncertainty and no protected denial disclosure. Owner-initial is exercised as a uniform rejection and renewal as too-early rejection; positive owner bootstrap/JWT and successful renewal are separately verified by their integration owners and are not counted as successes in this harness. Real production credentials, production browser, production deployment, real owner setup and external-agent product integration are not tested here.

## Review and reproducibility

Focused source review and local runtime checks cover the contracts above. Final integrated source/artifact association, browser behavior and repository-wide checks are separate release evidence; this document does not claim those checks have passed merely because schemas compile. Regenerate and rerun against the final integrated candidate after any API source change; do not treat a copied test source tree as a source patch.

The published contract is generated from the current runtime contract inputs. Keep the generator, schema and actual-route verification synchronized; unsupported fields must not be accepted merely to retain obsolete response shapes.
