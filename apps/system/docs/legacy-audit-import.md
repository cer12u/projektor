# Retained gate-rejection audit

`issue_gate_rejections` is original operational audit data, not an Issue edit or resolution. Its original `id`, `workspace_id`, `issue_id` and Unix-second `occurred_at` are preserved exactly. It does not create native Issue revisions, issue history or operation receipts.

The private v1 `legacy-operational-audit-preservation` artifact is an input to this operational tool; do not commit its records or provider identifiers. Validate an explicitly supplied file offline:

```
node scripts/maintenance/verify-legacy-audit.mjs /private/path/legacy-audit.json
```

This validates the serialized-file digest, every canonical row digest and the overall ordered canonical-row digest. It prints only counts and digests; it does not contact a provider or verify database relations.

For an approved, bound D1 maintenance session, `importLegacyGateAudit(db, serializedArtifact)` is exported by `src/adapters/d1/maintenance/import-model.ts`. No product HTTP/MCP import endpoint exists. The function:

- Requires the canonical schema and a stopped write gate. Target Issue/workspace/project/imported-source relationships are checked in the atomic batch.
- Uses a separate `legacy-gate-audit-<rows digest>` dataset with its own immutable receipts and serialized-artifact digest. The original core dataset, its counts and receipts remain unchanged.
- Atomically enters importing mode, inserts the original rows and receipts, verifies the dataset, and restores stopped mode. A conflicting existing row or intermediate failure rolls back the whole batch. An ambiguous acknowledgment is reconciled by exact readback; it is never blindly replayed.
- Accepts exact replay only. Different serialized bytes for the same row-digest dataset conflict; do not reformat the private file after recording its identity.

Retained rows appear in the existing authorized Issue source-history path (`/api/projects/{projectId}/source/issues/{issueId}` and MCP `source_get`) and the Web “移行前の記録を読む” view. They retain the source-table label, original ID and original timestamp. Current project view permission and current Issue relationship are required; no workspace-wide audit dump is exposed.

Local verification uses four synthetic records and actual workerd/D1, including rollback, lost acknowledgment, HTTP/MCP readback and read-time revocation. Loading the separately retained real records into a production database remains a distinct operational action and is not established by those tests.
