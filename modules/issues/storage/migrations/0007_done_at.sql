ALTER TABLE issues_issues ADD COLUMN done_at INTEGER;

INSERT OR IGNORE INTO issues_purge_bypass(workspace_id,project_id)
SELECT workspace_id,project_id FROM issues_frozen_scopes;

UPDATE issues_issues SET done_at=COALESCE(
  (SELECT MIN(h.occurred_at) FROM issues_history h
   WHERE h.workspace_id=issues_issues.workspace_id AND h.issue_id=issues_issues.id
     AND ((h.action IN ('transition','status_category_changed') AND json_extract(h.detail,'$.to')='done')
       OR (h.action='update' AND json_extract(h.detail,'$.statusId') IN
         (SELECT id FROM issues_task_statuses s WHERE s.workspace_id=h.workspace_id AND s.category='done')))),
  completed_at);

DELETE FROM issues_purge_bypass WHERE EXISTS
  (SELECT 1 FROM issues_frozen_scopes f WHERE f.workspace_id=issues_purge_bypass.workspace_id
   AND f.project_id=issues_purge_bypass.project_id);
