-- PTORDEV-6: project keys are an issue-ref namespace per workspace.
-- Archived rows retain their key. Projects are physically deleted, so there is
-- no deleted_at predicate. NOCASE covers legacy mixed-case ASCII keys as well as
-- the uppercase keys accepted by the service.
-- Run scripts/project-key-preflight.mjs on an approved database export first.
-- Fail closed on existing duplicates, including archived/case-only duplicates.
-- Never delete, rename, normalize, or select a winner automatically.
-- Keep the existing binary-collation hot-path lookup index: exact-key reads
-- cannot fully use a NOCASE index. Failure leaves all rows and old indexes intact.
CREATE UNIQUE INDEX idx_projects_ws_key_unique
  ON projects(workspace_id, key COLLATE NOCASE);
PRAGMA optimize;
