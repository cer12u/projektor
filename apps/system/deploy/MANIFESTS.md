# Release identity

Per-release pins/manifests are private ignored `.local/deployment/{release-pins,source-manifest,artifact-manifest}.json`. They are outside their own source inventory. Every public source/config/template/test/architecture file is inventoried. Only root `dist`, `node_modules`, `.local` and `.wrangler` are excluded; dist is separately exhaustive. Symlinks, unsafe paths, credential files and unlisted files are rejected.

Format3 tree identity is SHA256 of UTF-8 rows sorted by byte-lexical path: `path NUL decimalBytes NUL lowercaseSha256 LF`. Source and artifact manifests bind one release ID, complete file records, source-manifest byte hash and both tree hashes. Build evidence must record a real successful command with identical full source trees before and after; do not label refreshed source hashes as an earlier build.

Pins use format1/state `bound`, releaseId matching `projektor-modular-YYYYMMDD`, uploadTag `<releaseId>-<first12ArtifactTreeHash>`, and hashes: sourceManifestSha256, artifactManifestSha256, sourceTreeSha256, artifactTreeSha256, targetConfigSha256, productionConfigSha256, approvedStateSha256, canonicalMigrationTreeSha256, canonicalBaselineMigrationTreeSha256. Private target/config/state byte hashes bind installation-specific expectations without publishing their contents.

The canonical0001–0017 baseline digest is independently fixed. The exact release migration inventory must contain0019 as its last migration. `schema-contract.json` also binds each canonical migration's byte hash and the required guard definitions. Templates and test identities are synthetic and cannot establish real provider state.

No build, startup, verification or missing-file handler generates new release pins. Bind only after source, schema, tests and artifacts have a coherent measured freeze.
