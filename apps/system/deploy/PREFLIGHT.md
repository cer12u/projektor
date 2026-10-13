# Preflight and additive migration planning

The controller verifies the exact canonical migration chain through0019 before upload. It never applies migrations. Existing0001–0017 bytes remain independently pinned by the baseline digest in `cloudflare-port.mjs`; rewriting a manifest cannot silently replace that history.

Before an authorized migration, read the actual ledger, schema definitions, stopped gate/epoch, integrity results and necessary aggregate counts through a supported existing-credential route. Preserve identifiers, current rows, histories, receipts and prepared intents. Do not infer that a database is complete from counts alone. Do not read business bodies or credentials merely to prepare a schema change.

For each missing additive migration, freeze the exact file hash and use a proven atomic migration-plus-ledger operation. Reject existing object-name collisions or structural drift. After success or an uncertain acknowledgment, read back ledger and exact definitions before considering another dispatch. Do not replay an already applied migration or mark a no-op/weakened trigger as compatible because its name exists.

The release read collector requires the complete exact ledger, quick_check success, no foreign-key violations, expected stopped gate and exact canonical0018/0019 security-relevant table/index/trigger definitions. It compares fresh Access policy, routing ownership and selected Worker-settings fingerprints to the reviewed private baseline. Two equal bounded scans, with active-version checks around each, detect observed drift; this is not an atomic transaction across separate provider APIs.

The pinned normal Wrangler branch additionally requires the current service projection to report Wrangler origin and empty tags, its migration tag to match the release config, and version metadata to report preview disabled. Unknown responses, denied reads, drift, missing permissions or an unreviewed provider branch stop the operation before upload.
