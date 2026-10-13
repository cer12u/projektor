# Deployment responsibility and evidence boundary

- `deploy.mjs`: parse fixed commands, load private configuration, validate frozen release and compose the use case.
- `deployment-config.mjs`: read only explicit ignored noncredential target/baseline files; reject missing, malformed or symlink configuration.
- `guard.mjs`: exhaustive source/artifact identity, measured build association, canonical migration chain and private configuration binding.
- `release-use-case.mjs`: sole release state machine. Validate prerequisites before intent, upload, independently verify version, promote separately, observe traffic, or retain uncertainty.
- `cloudflare-port.mjs`: explicit operations/capability/outcome contract. The host-managed connector is only a truthful capability descriptor because no supported Node transport is supplied.
- `wrangler-adapter.mjs`: pinned official upload/promotion and metadata commands. No custom uploader or protocol replacement.
- `prerequisite-reader.mjs`: closed read-only official API collection with pinned legacy service compatibility, strict response parsing, bounded safe-read retries and drift checks.
- `credential-context.mjs`: existing credential/proxy/CA policy; no credential creation, persistence, login or renewal.
- `official-cli.mjs`: isolated noncredential process HOME, log suppression, bounded/redacted output and full process-group stop on the pinned asset-retry diagnostic.
- `release-journal.mjs`: append-only local intent/outcome history and exclusive lock. Cross-executor durability must be supplied and verified by the approved hosting arrangement.

A valid local manifest or deterministic test is not a production deployment, live authorization proof or product acceptance. The module stops before authentication/network if no private target is configured and before mutation if evidence is incomplete, stale, denied or inconsistent. It never migrates D1 automatically, enables MCP, reopens writes or changes Access policies.
