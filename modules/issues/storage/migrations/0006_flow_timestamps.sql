ALTER TABLE issues_issues ADD COLUMN ready_at INTEGER;
ALTER TABLE issues_issues ADD COLUMN claimed_at INTEGER;
ALTER TABLE issues_issues ADD COLUMN in_review_at INTEGER;
ALTER TABLE issues_issues ADD COLUMN review_bounce_count INTEGER NOT NULL DEFAULT 0;

INSERT OR IGNORE INTO issues_purge_bypass(workspace_id,project_id)
SELECT workspace_id,project_id FROM issues_frozen_scopes;

UPDATE issues_issues SET
  claimed_at=(SELECT MIN(h.occurred_at) FROM issues_history h
    WHERE h.workspace_id=issues_issues.workspace_id AND h.issue_id=issues_issues.id
      AND h.action IN ('transition','status_category_changed')
      AND json_extract(h.detail,'$.to')='in_progress'),
  ready_at=CASE WHEN status='backlog' THEN NULL ELSE
    (SELECT MIN(h.occurred_at) FROM issues_history h
      WHERE h.workspace_id=issues_issues.workspace_id AND h.issue_id=issues_issues.id
        AND h.action IN ('transition','status_category_changed')
        AND json_extract(h.detail,'$.to') IN ('todo','in_progress','done')) END;

DELETE FROM issues_purge_bypass WHERE EXISTS
  (SELECT 1 FROM issues_frozen_scopes f WHERE f.workspace_id=issues_purge_bypass.workspace_id
   AND f.project_id=issues_purge_bypass.project_id);
