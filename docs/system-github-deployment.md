# Manual GitHub Actions deployment host

## Status and trigger

The source implements a protected manual host. Node 24.19.0 ships npm 11.17.0, so CI explicitly installs the separately measured npm 11.9.0 before lockfile installation. No environment, token, secret, GitHub deployment record, dispatch, merge or Cloudflare mutation is created by committing it. A successful local contract test is not a successful hosted rollout.

The existing default branch already contains `.github/workflows/release.yml` with `workflow_dispatch` and the string input `version`. GitHub requires that default-branch registration before dispatching a different branch. This implementation reuses that exact path and input. No branch-only input needs to appear in the default-branch UI.

- Ordinary version tags/manual version releases retain the artifact-release flow.
- Only a manual request whose version is `deploy:<exact 40-character selected commit>` enters deployment jobs.
- The selected branch must be `fix/modular-system-integration-20261012`.
- Pushes, PRs, tags and release events never enter these deployment jobs.
- Run attempts other than the original attempt are refused. Do not use “Re-run jobs”.

After explicit authorization and configuration, the supported CLI dispatch shape is:

```sh
gh workflow run release.yml --repo cer12u/projektor \
  --ref fix/modular-system-integration-20261012 \
  -f version=deploy:APPROVED_FULL_COMMIT
```

`APPROVED_FULL_COMMIT` must equal the actual branch head selected by GitHub. A branch movement fails closed. Dispatch itself has not been executed in this verification.

## Required protected setup

A repository administrator must configure environment `projektor-production`, restrict it to the exact work branch, require the verified owner `cer12u` as the sole reviewer, deliberately allow that owner to review a run they initiated (`prevent_self_review:false`), and disable administrator bypass. A second person is not required. The owner must explicitly review the exact commit/run/artifact; no automatic approval is implemented. Do this before dispatch: merely naming an environment in YAML does not establish protection. The host reads the actual fixed environment and exact branch policy using Actions read permission before the private configuration step and again before provider use. A missing/different owner reviewer, a policy that prevents the sole owner from reviewing their initiated run, administrator bypass, a wildcard/extra branch policy, or unavailable policy proof stops execution. It never changes environment settings.

The protected environment has exactly these inputs:

1. `CLOUDFLARE_API_TOKEN`: an account-owned token supplied securely by the owner, never in source or chat. For the selected account, the combined uploader/read collector needs Workers Scripts Edit (API Write), D1 Read, and Access Apps and Policies Read. Provider permission scope is not claimed to be one individual Worker; the implementation also pins one exact Worker/DB/hostname. No D1 Write is needed for the collector's fixed read queries.
2. `PROJEKTOR_DEPLOYMENT_CONFIG_JSON`: a JSON object with only `target`, `approvedState`, and `wrangler`, following the existing private configuration contracts. `approvedState.security` includes the four reviewed hashes, including `ownerBootstrapHash`. Populate real private values securely; do not publish them or use template placeholders. Existing JWT secret presence, canonical 19 migrations, stopped gate and exact current provider metadata must satisfy preflight.
3. `PROJEKTOR_APPROVED_RELEASE_JSON`: a JSON object with exactly `format:1`, `commit`, `runId` (string), `operationId` (stable UUID), `releaseId` (`projektor-modular-YYYYMMDD`), `sourceTreeSha256`, `artifactTreeSha256`, `expectedCurrent` (existing provider version UUID), and `action` (`upload` or `upload-and-promote`). The hashes come from independently reviewed measured source/artifacts, never from unreviewed input. After the no-secret build creates its run ID, securely bind this object to that run before approving the protected job.

The secret token is exposed only to the final host step. Checkout, locked Node 24.19.0/npm 11.9.0 installation, verification and measured artifact creation happen without Cloudflare credentials. A second job verifies the downloaded exact build against the protected reviewed digests before binding release manifests. Only release labels/manifest-file hashes are rebound; original measured pre/post build identities and timestamps remain intact.

The official Wrangler adapter's default Network-secret/proxy mode remains unchanged. This host explicitly uses `github-actions`; it verifies GitHub context and the actual checked-out Git HEAD, allows direct official Cloudflare HTTPS when no proxy exists, and retains destination/credential-environment restrictions.

## Durable intent, publication scope and recovery

Before any upload or activation, the journal appends a GitHub deployment record and reads it back. This uses the run-scoped `GITHUB_TOKEN` with `deployments:write`; job concurrency serializes the installation across branches and does not cancel a running deployment.

These records are visible on this public repository. Setup and dispatch consent must explicitly cover publication of: a stable operation UUID, approved commit and source/artifact SHA-256 digests, target fingerprint, action, run ID, predecessor record ID, phase, and an opaque uploaded-version UUID when known. No account ID, database ID, hostname, token, private configuration, raw provider response or private full journal is published. The Actions outcome artifact contains only phase, operation/commit/digests and an operator-reconciliation flag. Structured secret masking is not relied upon for field-level privacy.

The original detailed journal remains runner-local. A later run scans the durable exact-target/artifact history. If an attempt exists, it reads actual provider deployment state and the exact uploaded version when recorded, then stops for operator reconciliation. It never invents a version ID, creates a replacement operation ID, resumes activation from a sanitized success flag, or automatically uploads again. Lost acknowledgement without a trustworthy version ID remains unresolved and blocks replay. This bounded route does not implement automatic private-journal restoration or automatic crash recovery.

Only the current uninterrupted run can upload and, if explicitly approved, activate. No migration or permission change is performed by this host. Production acceptance and external browser checks remain separate.

## Verification and references

Run `node --test scripts/github-deployment-host.test.mjs` for exact-trigger/approval binding, immutable build comparison, strict public checkpoint projection, durable intent-before-dispatch, lost acknowledgement, prior-version readback and fork refusal. These tests use an in-memory GitHub transport and synthetic values; they do not claim a live Actions or Cloudflare run.

- [GitHub manual workflow runs and branch selection](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)
- [GitHub workflow_dispatch default-branch requirement](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)
- [GitHub environment protection](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
- [GitHub deployment REST records](https://docs.github.com/en/rest/deployments/deployments)
- [Cloudflare official GitHub Actions guidance](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [D1 query accepted permissions](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)
