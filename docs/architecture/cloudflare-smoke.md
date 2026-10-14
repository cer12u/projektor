# Cloudflare verification smoke

The `cloudflare-smoke` GitLab job runs only on protected `main`, after the build and
local integration check. Missing protected `CLOUDFLARE_API_TOKEN` or
`CLOUDFLARE_ACCOUNT_ID` selects an `allow_failure` rule: the script still exits 78,
and the job shows as a warning. With both variables present, any error fails the
pipeline. (The runner reports script failures as exit 1, so `exit_codes: [78]`
could not tell these cases apart.) The MR pipeline runs the same smoke assertions against Miniflare with
`pnpm test:smoke`. The 07c suite also spawns the actual script with each missing
credential, and runs its orchestration with subprocesses stubbed to verify that
an API-token sentinel is absent from stdout/stderr. No real credential is used
and no Cloudflare resource is created by these local tests. The Worker test
rejects unauthenticated probes before running the real local storage assertions.
A green MR does not prove real D1 behavior or guarantee third-party CLI diagnostics
will never contain secrets.

The token needs account permissions **Workers Scripts:Edit**, **D1:Edit**,
**Workers KV Storage:Edit**, **Workers R2 Storage:Edit**, and **Account
Settings:Read**. Add both variables as masked, protected GitLab CI variables.
The account must have a workers.dev subdomain and R2 enabled. These resources
can incur Cloudflare usage charges. The job never uses production bindings.

Wrangler creates or reuses only these names in the selected account:

| Resource | Name |
|---|---|
| Worker | `projektor-verify` |
| D1 | `projektor-verify` |
| KV namespace | `projektor-verify` |
| R2 bucket | `projektor-verify` |

The job verifies `dist/artifact.json` commit and file SHA-256 values, then uploads
`dist/smoke-worker.js` with Wrangler `--no-bundle`. This verification entry point
contains the normal Gateway plus secret-guarded `__smoke` routes. It is built with
the production catalogs; synthetic test owners are excluded. The normal
`dist/worker.js` remains non-deployable. The temporary route exists only in the
verify Worker, requires both `SMOKE_ENABLED=1` and a fresh per-job secret, and
creates only a per-run `smoke_*` workspace. The job deletes its R2 test object;
per-run D1 workspaces remain isolated for audit and can be removed when tearing
down the verification database. No human assertion is minted. Bootstrap inserts a
machine bearer directly into the verify D1, and the REST/MCP checks then use the
normal authentication and authorization path. This bypass is never deployed as
the normal Worker.

The smoke runs all module migrations in owner order twice and compares the
ledger count. It checks a D1 batch rollback on a mid-batch constraint error,
100 accepted bind values and the adapter's 101-bind rejection, R2 put/get/delete,
health, REST creation/read/retry, stale-version conflict with no receipt, Japanese
FTS5 trigram search and short-term search, and an MCP tool call. If real D1 lacks
the required FTS5 trigram support, migration or search fails the job. Cloudflare
Access human login is deferred until the owner supplies a Zero Trust team domain
and audience; the placeholder Access configuration cannot authenticate humans.

To remove the verify environment, first stop the main smoke job, then run with
the same account credentials:

```sh
pnpm exec wrangler delete --name projektor-verify
pnpm exec wrangler d1 delete projektor-verify
pnpm exec wrangler kv namespace list  # find the exact projektor-verify namespace ID
pnpm exec wrangler kv namespace delete --namespace-id <ID>
pnpm exec wrangler r2 bucket delete projektor-verify
```

Delete the R2 test objects first if a previous run failed before cleanup. Check
each exact name and account before deletion.
