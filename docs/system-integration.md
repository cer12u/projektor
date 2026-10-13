# Canonical runtime integration

## Selected development line

The implementation continues the existing PR#7 development line (`experiment/ptordev-7-atomic-command`), preserving the repository's prior commits, applications, packages and experiments. `apps/system` is the sole canonical runtime selected by root development, build, check and release commands. The previous Hono/Astro application and experiments remain reference source and independently named legacy checks.

The runtime graph is Worker → composition → Identity / Work / Execution application ports → concrete adapters, with Web and Agent clients using the same business API. No route fallback, dual writer, old-schema adapter or dependency on `apps/api`, `apps/web`, `packages/db` or experiments is introduced.

## Toolchains and contracts

The active app is deliberately isolated from the retained pnpm workspace: Node 24.19.0, npm 11.9.0 and its own committed package-lock define the tested toolchain. Root commands delegate explicitly; the new CI gate performs a frozen npm install and exercises source checks, ownership boundaries and local built-Worker contracts. Legacy jobs retain their prior toolchain and are not evidence for the new app.

`apps/system/docs/architecture-spec.md` is authoritative. Its generated `docs/openapi.json` describes the current API. The old catalog generator updates `README.legacy.md` and the retained docs site; its tool counts do not advertise current-system functionality.

The release builder selects only the new Worker, static WASM dependencies, Web assets and ordered `apps/system/migrations` chain. Existing release workflows now use `apps/system/package.json` as version authority. No branch push invokes a production deployment, and this integration does not authorize a merge or release tag.

## Retained functionality not ported

The following upstream families remain in reference source but are not claimed as implemented by this app:

- R2 files and attachments
- Full workspace/project administration and branding
- Sprints, custom-field value editing and the full task catalog administration
- Full issue-link/reference operations
- Wiki search/backlinks/watchers/drafts/export/trash/attachment extensions
- Feedback ingestion and triage, public-share capabilities
- Legacy group/token/OAuth connector administration
- Fleet sessions, file claims, WIP coordination and agent messages
- Flow metrics, code heatmaps, activity/playbook suite and WebSocket notifications

The current Issue/Wiki/comment, planning/reference, Identity and execution-attempt contracts are bounded replacements, not proof of feature parity. Dormant plugin source is retained without reconnecting an unreviewed plugin runtime. Automatic login provisioning, scheduled business-data purges and the old authorization model are not reintroduced.

## Data and migration limits

The old and new schemas are different lineages. Never concatenate `packages/db/migrations` and `apps/system/migrations`, reinterpret old rows using new table definitions, or delete historical source to imply migration completion.

A saved, bounded aggregate inventory indicated that the omitted feature-table families were empty at that observation, while business families, separately preserved historical records and excluded credentials had distinct dispositions. This is not a fresh hosted inventory or a public dump of user records. Feature omission therefore does not itself establish loss of nonempty rows in that snapshot; it also does not establish current completeness or a normal application reference path for every separately preserved artifact.

The import contract, fixture preservation tests and code/source history are distinct evidence. Neither synthetic local data nor retained source proves access to all real historical records. Provider identifiers, business bodies and private operational evidence are excluded from this public repository.

## Verification boundaries

Local checks can establish source/dependency resolution, pure rules, atomic D1 behavior, actual Worker API behavior and controlled browser/client cases. They do not establish hosted Cloudflare eligibility, real Access/OAuth configuration, credential custody, production data migration, Android behavior or next-day continuity. Each current-commit check and remaining implementation gap must be reported separately; retained earlier evidence is reusable only for its unchanged dependency scope.
