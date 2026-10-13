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

## Explicit GitHub Actions credential mode

The manual release host may set `PROJEKTOR_DEPLOYMENT_MODE=github-actions`, `GITHUB_ACTIONS=true`, `GITHUB_SHA`, and `PROJEKTOR_EXPECTED_COMMIT`. Both commit values must be the same exact reviewed 40-character commit, and local `git rev-parse HEAD` must match before each credential use. This is a consistency check; only the protected GitHub environment and reviewed workflow establish permission to deploy.

The one execution credential is `CLOUDFLARE_API_TOKEN`, injected by GitHub environment secrets only for the bounded execution step. It is never written into the private config, profile, journal or artifact. GitHub mode permits an ordinary trusted HTTPS connection with no proxy; if a proxy is configured, Node's required `--use-env-proxy` and official Wrangler retain it. Default `network-secret` mode still requires the approved proxy and forbids destination bypass. Neither mode logs in, refreshes, issues or saves a credential. API tokens remain valid until explicit expiry/revocation; rotation requires the separately authorized provider/secret update.

`PROJEKTOR_DEPLOYMENT_CONFIG_JSON` contains only target, approved state and Wrangler config. `PROJEKTOR_APPROVED_RELEASE_JSON` binds commit, one workflow run ID/first attempt, current production version and measured source/artifact trees. The manual workflow owns their validation and durable intent/receipt artifacts. Missing inputs stop before provider access; interrupted execution requires journal/result reconciliation before another authorized run. A fresh runner cannot treat a missing local journal as evidence that nothing happened.

The token must cover the actual endpoint set in PREREQUISITES.md: existing Worker version upload/promotion/read, D1 query reads, Access application/policy reads, and Workers domain metadata reads. A selected-Worker Editor role alone does not establish the other account-level read rights. The official D1 query endpoint accepts D1 Read or D1 Write; request D1 Read for this fixed SELECT/PRAGMA collector. If an existing token instead has D1 Write, disclose its broader write authority. No live proof with a Read-only token has been performed. No token is created by this repository and no permission is silently expanded.

Before release, the current owner bootstrap metadata fingerprint must match the independently reviewed private baseline. An expired bootstrap window stays expired; matching metadata never rearms it. `JWT_SECRET` must exist as a secret binding and is preserved by official `--keep-vars`; its value is never fetched. Ordinary runtime bindings are `DB`, `ASSETS`, `AUTH_ORIGIN`, and the explicitly disabled MCP configuration. Owner issuer/audience/subject are loaded from the existing D1 owner configuration, not inferred from Worker bindings.
