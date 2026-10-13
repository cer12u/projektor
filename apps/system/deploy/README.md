# Deployment controller

This is an executable release controller, not an automatic deployment. It contains no account, database, hostname, historical security fingerprint, credential, or bound release identity for a real installation. The public checkout stops before authentication or network access until explicit private configuration and a verified release are supplied.

Run from `apps/system`:

- `node deploy/deploy.mjs verify .` checks the full frozen source/artifact identity and private configuration hashes locally.
- `node deploy/deploy.mjs status .` reads the release's recovery journal locally.
- `node --use-env-proxy deploy/deploy.mjs deployments .` and `probe . VERSION_UUID` read provider metadata.
- `node --use-env-proxy deploy/deploy.mjs upload . CURRENT_VERSION_UUID` uploads through pinned official Wrangler only, then verifies metadata.
- `node --use-env-proxy deploy/deploy.mjs deploy . CURRENT_VERSION_UUID` separately promotes a verified upload and reads back traffic.
- `node --use-env-proxy deploy/deploy.mjs reconcile .` observes an uncertain prior operation; it never blindly repeats a mutation.
- `node --test tests/deploy/*.test.mjs` runs local contract/migration checks. It does not authenticate to Cloudflare.

Target, expected security state, private Wrangler config, release pins/manifests and journal belong in ignored `.local/deployment/`. See [RELEASE.md](RELEASE.md) for preparation, [MANIFESTS.md](MANIFESTS.md) for binding, [PREREQUISITES.md](PREREQUISITES.md) for exact reads, and [ROLLBACK.md](ROLLBACK.md) for recovery limits.

The kit does not create credentials, change access policy, run migrations, enable MCP, or reopen writes. Product acceptance and real deployment acceptance require separate evidence; local test success is not production success.
