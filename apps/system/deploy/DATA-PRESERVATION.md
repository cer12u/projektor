# Data and history preservation

Canonical migrations0001–0017 are immutable. Additive0018/0019 introduce owner/recipient setup recovery state; they are not an import, cleanup, or repair of missing business records. No data count from a particular installation is published in this repository.

`tests/deploy/migration-upgrade.test.mjs` applies actual migration bytes to local SQLite with representative principal/session/grant rows, Work current/history identifiers, operation receipts, Execution attempts/heads/reports and prepared intents. It compares every preexisting application row and key, verifies retained schema/ledger and checks new constraints. The test also exercises rollback of additive DDL when its ledger insertion fails.

This is local migration preservation evidence. Actual workerd/D1 integration is a separate boundary check. Neither establishes production completeness, prior import coverage, per-user visible counts, or full business-body equality. Those require authorized installation-specific evidence kept outside the public repository.

Committed records, histories, operation IDs and setup recovery data must survive code rollback. There is no destructive down migration; follow ROLLBACK.md.
