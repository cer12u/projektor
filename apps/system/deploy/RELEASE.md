# Release setup and execution

## Explicit private setup

Use Node24.19.0 on Linux x64 and the pinned lockfile. The tested bootstrap retains development and optional dependencies: `npm ci --ignore-scripts --include=dev --include=optional`. Installation/build never deploys or migrates a database. Keep the platform's proxy and CA trust unchanged.

Create the following noncredential files in ignored `apps/system/.local/deployment/` under the installation owner's existing authorization:

1. `target.json`: copy `deploy/target.example.json`, replace every synthetic value, and record the exact stopped gate epoch expected for this release. Only its documented fields are accepted.
2. `wrangler.jsonc`: copy `wrangler.production.example.json` here and supply matching account/Worker/database/hostname values. Its relative main/assets/migration paths are deliberately relative to this private directory. The guard requires those paths to resolve to the verified `dist` and canonical migrations.
3. `approved-state.json`: record the reviewed security baseline as shown in `approved-state.example.json`. These are expected comparison values, never proof of current provider state. Do not invent hashes or copy another installation's evidence.
4. `source-manifest.json`, `artifact-manifest.json`, `release-pins.json`: bind a genuinely measured, unchanged-source build using MANIFESTS.md. No deployment-time regeneration or fallback to older pins is allowed.
5. `journals/`: preserve this release's append-only intent/outcome history. A new empty executor directory cannot establish that no previous upload occurred.

These files must never contain credentials. Do not commit `.local`, profiles, raw provider output, uploaded session JWTs, business data, or private metadata evidence. Private setup is not itself authorization to create or expand persistent access.

## Credentials and platform check

The adapter consumes an existing authorized credential execution context. It requires the approved HTTP(S) proxy path and normal CA verification. A managed Network-secret placeholder may be supplied by an authorized platform, but the kit neither implements nor proves that platform's substitution. It has no login, logout, profile cache, OAuth refresh, token creation, or credential export fallback. A standalone API token remains usable only while valid; expiry/revocation/rotation must follow the owner's authorized process.

After local release binding, `node deploy/platform-check.mjs .` starts official Wrangler without a token. It validates local configuration/process compatibility only. It cannot prove proxy network access, secret substitution, provider permissions or cross-executor recovery. Establish those prerequisites through the authorized hosting setup before live operations.

Official Wrangler may receive short-lived static-asset upload JWTs internally. The unmodified uploader owns them. Raw output is withheld, disk debug logs are disabled, and the wrapper stops the process group at the first asset-retry diagnostic. A failed/uncertain mutation requires readback before any authorized retry.

## Separate upload and promotion

The controller validates full-release capability and obtains fresh prerequisite observations before any mutation intent. It then runs official `versions upload --keep-vars --strict --tag <bound-tag>`. This uploads modules/assets without promoting traffic or changing routes/triggers. Matching remote version metadata is required before `UPLOAD_VERIFIED`.

Promotion uses official `versions deploy VERSION@100% --yes`, after repeating prerequisites and upload readback. A zero command exit is not confirmation; active deployment/version/settings are observed afterward. Remote Worker source bytes are not read. Local artifact hashes, the official upload receipt and remote metadata are distinct evidence.

The controller's journal is local. An authorized durable storage/transfer arrangement is required before real cross-executor use. Stop if that arrangement, credentials, scope, expected state or provider compatibility is absent. Do not substitute stale attestations or broaden credentials automatically.
