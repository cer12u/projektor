ALTER TABLE access_credentials ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE access_credentials ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
INSERT OR IGNORE INTO access_purge_bypass(workspace_id,project_id)
  SELECT workspace_id,project_id FROM access_frozen_scopes;
UPDATE access_credentials SET created_at=COALESCE((
  SELECT MIN(e.occurred_at) FROM access_events e
  WHERE e.workspace_id=access_credentials.workspace_id
    AND e.aggregate_id=access_credentials.id AND e.type='CredentialIssued'
),0);
DELETE FROM access_purge_bypass WHERE EXISTS(
  SELECT 1 FROM access_frozen_scopes f
  WHERE f.workspace_id=access_purge_bypass.workspace_id
    AND f.project_id=access_purge_bypass.project_id
);
