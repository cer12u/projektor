# Security Policy

## Reporting a vulnerability

Please report security issues **privately** - do not open a public issue.

For **upstream Projektor** vulnerabilities, email the upstream maintainer at
**tajdickson@protonmail.com** with:

- a description of the vulnerability and its impact,
- steps to reproduce (a proof of concept if you have one),
- the affected version or commit.

For **Fork-specific code or deployment** vulnerabilities, contact the Fork operator
through an established private channel. No separate Fork disclosure address is
documented here; do not assume the upstream maintainer operates this Fork. Please
allow a reasonable window to address an issue before public disclosure.

## Scope

projektor is a self-hosted application: each deployment runs on the operator's
own Cloudflare account, behind their own Cloudflare Access configuration. Reports
about the projektor codebase itself are in scope; misconfiguration of an
individual deployment (e.g. a missing Access policy) is the operator's
responsibility - see [CONFIGURE.md in the deploy repo](https://github.com/TAJD/projektor-deploy-example/blob/main/CONFIGURE.md).

## Owner-provisioned machine credentials

A workspace owner can use an interactive Access session to create a token for an
existing `member` actor through `POST /api/workspaces/:slug/tokens`. Supply an
explicit `machineActorId`, `scopes` (`read` and/or `write`, never `*`) and
`expiresInDays` (1–365). Issuance returns the acting `userId`, `issuedByUserId` and
`workspaceId` alongside the one-time secret. This does not create a user, grant
project access, or change any existing token. Use the intended machine identity,
not the owner's identity, and verify `/auth/me` before allowing writes.

The server persists the issuer separately from the actor. Delegated tokens are
workspace-confined and require that actor to remain a live `member`. Removal,
promotion, demotion, expiry or revocation fails closed; promotion never gives an
existing machine token owner/admin access. Project access still uses live group
grants and is capped at `member`. Issue authorship, comments, activity and
`assignee=me` use the credential's actor. A caller-supplied actor or issuer cannot
replace the authenticated identity. Token creation/revocation still require an
interactive human session; a machine cannot issue a replacement for itself.

Apply migration `0071_machine_token_issuer.sql` before deploying code that reads
its column. Existing rows retain NULL issuance provenance and their existing
actor, scopes and privileges. Newly self-issued owner/admin tokens keep their
existing behavior. Human Access sessions combined with a bearer now return 403
rather than silently selecting the human identity. Access service-token assertions
combined with a bearer remain supported; Access/MFA policies are unchanged.

Source changes and tests do not provision production access. Deployment,
migration, token issuance, secure storage and switching the operational client
are separate controlled steps. Never include a real credential in tests, logs,
source control, an issue, or a checkpoint. Routine machine issue operations use
the approved scoped credential; they do not initiate an owner's interactive login.
