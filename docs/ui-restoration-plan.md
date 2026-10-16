# UI restoration plan

Status: approved by the owner on 2026-10-15.

## Why

The rewrite dropped the original web UI and most issue-tracker basics. Missing items included:
issue timestamps, comment listing, custom statuses, labels, parent/epics and links.

This plan does two things:
- restores the original UI unchanged;
- implements on the modular backend what that UI needs.

The original is the upstream GitHub repository at commit `d39852ce`. Read its files with
`git show d39852ce:<path>`.

## Invariants (never weakened)

Only behavior is ported from the original: the UI and the API inputs and outputs. Its implementation
is not ported. The following rules, and the checks and tests behind them, stay as they are.

### Boundaries and SQL

- Owner registry and public-only imports, with an acyclic DAG. `check-boundaries`, `sql_check`,
  allowlists and tests are never relaxed.
- SQL comes only from each owner's static `queries.ts`. Never use dynamic SQL; optional filters
  use static statements with optional parameters. Use at most 100 binds.
- Every table and unique key includes `workspace_id`. No owner touches another owner's tables.

### Commands

- Every command uses an operationId receipt with an input fingerprint and `expectedVersion` CAS.
- Every command uses the guard table.
- Row, history, receipt and outbox event are written in one D1 batch. This applies to new commands
  and to every write made through the UI API.

### Authorization and lifecycle

- Admission-time `requireMembership`/`authorize` and project authorization.
- A two-tenant isolation test for each added feature.
- New tables get freeze triggers and are covered by the owner's freeze, purge and status
  maintenance.

### Events, authentication and integrations

- Events are versioned, and new event types must not break Insights readers.
- Authentication:
  - Access JWTs are verified.
  - The Access cookie authenticates REST only, and cookie writes require the same origin.
  - OAuth tokens are rejected on REST.
  - MCP authentication is unchanged.
  - Secrets never appear in logs.
- Integrations HMAC verification and manual redirects are unchanged.
- Assets keep their prefix-scoped R2 adapter, GC, and hash and size verification.

### Migrations and deploy

- Migrations are additive only, with a checksummed ledger.
- Deploy artifacts are checksummed, configuration comes from variables, and `check:literals`
  stays in force.

### UI API and conflicts with the original

- The UI API (`gateway/ui/`) only translates. It holds no SQL, no business rules and no direct storage
  access.
- Where original behavior conflicts with these invariants, the invariant wins and the MR states the
  difference:
  - Last-write-wins PATCH becomes read-version CAS that returns 409 on conflict.
  - Auto-join on login is not ported. Only a one-time creation of the default workspace for
    `ADMIN_EMAILS`, when no workspace exists, is kept.

## Scope

### In scope

- The original `apps/web`, unchanged. The minimal SPA and its tests are removed.
- Session, workspaces and projects, including description, slug and timestamps.
- Issues:
  - created, updated and completed time, and creator;
  - the six statuses, custom statuses and issue types;
  - priority with `none`;
  - labels, parent/epic and issue links.
- Issue views: list with filters and sorting, board, detail, search and my issues.
- Comments: list, add, edit and delete.
- Sprints and attachments.
- Wiki core: list, view, create, update, delete, revisions and search.
- Settings: tokens, connectors and MCP connection info.
- Feedback core: list, convert, and listing and creating sources.

### Deferred

These endpoints return 501 and the original UI shows its error state.

- Wiki extras: draft, diff, templates, trash, tree, verify and stale pages.
- Feedback management: status, bulk actions, summary, and source update, delete and rotate.
- Groups.
- Brand (defaults only).
- Share links.
- Flow metrics.
- Code heatmap.

## Execution

- Each step is one Codex Sol run with one MR.
- Every design decision is written into the step prompt, including the original files to copy
  shapes from.
- `pnpm ci:local` mirrors every CI job and runs once before push. CI only confirms it.
- If CI fails after a green local run, Codex stops and reports instead of iterating.
- There are no audit or mutation runs.

| Step | Content |
|---|---|
| C1 | UI build, CI, routing, `ci:local`. Session, workspace and projects UI API. Access slug, email and name, default-workspace bootstrap. Projects description, slug and timestamps. |
| C2 | Issues module: statuses, types, fields, comments, links, migration backfill from history. |
| C3 | Issues UI API: issues, comments, links, statuses, types, search. Ported original route tests and E2E. |
| Checkpoint | The owner tries the deployed UI. |
| C4a | Sprints (Planning lookup of an issue's sprint) and files (Assets). |
| C4b | Wiki core, tokens, connectors, mcp-info, feedback core. |
| C6 | Stabilize browser and Cloudflare smoke checks; restore write-once issue `done_at` and Coordination flow history. |

## C6 flow history

Issues migration `0007_done_at.sql` preserves the first entry into a done status across reopen.
It backfills from the earliest recorded done transition or status update, then falls back to
`completed_at`. Coordination migration `0005_flow_history.sql` begins lease, file claim and
WIP-cap denial history. Earlier Coordination events omit fencing tokens and release reasons,
so historical spans cannot be reconstructed reliably. The new history starts empty.

Flow metrics read these histories for lease-held time, lease expiries, abandoned file claims
and WIP-cap pressure. Gate rejections remain zero because there is no review gate.

## Owner actions

- Sync GitLab main to GitHub at each checkpoint.
- For schema changes, apply migrations to production D1 and update `CF_APPROVED_SCHEMA_SHA256`.
  Each MR description gives the exact steps.
