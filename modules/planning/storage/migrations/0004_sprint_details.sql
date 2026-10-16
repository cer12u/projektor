ALTER TABLE planning_sprints ADD COLUMN goal TEXT;
ALTER TABLE planning_sprints ADD COLUMN status TEXT NOT NULL DEFAULT 'planned';
ALTER TABLE planning_sprints ADD COLUMN start_date INTEGER;
ALTER TABLE planning_sprints ADD COLUMN end_date INTEGER;
ALTER TABLE planning_sprints ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE planning_sprints ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER planning_check_sprints_insert BEFORE INSERT ON planning_sprints WHEN NEW.status NOT IN ('planned','active','completed') OR NEW.closed <> (NEW.status='completed') BEGIN SELECT RAISE(ABORT,'invalid sprint status'); END;
CREATE TRIGGER planning_check_sprints_update BEFORE UPDATE ON planning_sprints WHEN NEW.status NOT IN ('planned','active','completed') OR NEW.closed <> (NEW.status='completed') BEGIN SELECT RAISE(ABORT,'invalid sprint status'); END;
UPDATE planning_sprints SET created_at=COALESCE((SELECT MIN(occurred_at) FROM planning_history WHERE workspace_id=planning_sprints.workspace_id AND sprint_id=planning_sprints.id),0), updated_at=COALESCE((SELECT MAX(occurred_at) FROM planning_history WHERE workspace_id=planning_sprints.workspace_id AND sprint_id=planning_sprints.id),0), status=CASE WHEN closed=1 THEN 'completed' ELSE 'planned' END WHERE NOT EXISTS(SELECT 1 FROM planning_maintenance WHERE workspace_id=planning_sprints.workspace_id AND (project_id='' OR project_id=planning_sprints.project_id));
