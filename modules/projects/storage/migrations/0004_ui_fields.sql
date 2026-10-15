ALTER TABLE projects_projects ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE projects_projects ADD COLUMN slug TEXT;
ALTER TABLE projects_projects ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects_projects ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
UPDATE projects_projects SET slug=lower(project_key),
 created_at=COALESCE((SELECT MIN(e.occurred_at) FROM projects_events e WHERE e.workspace_id=projects_projects.workspace_id AND e.aggregate_id=projects_projects.id),0),
 updated_at=COALESCE((SELECT MAX(e.occurred_at) FROM projects_events e WHERE e.workspace_id=projects_projects.workspace_id AND e.aggregate_id=projects_projects.id),0);
CREATE UNIQUE INDEX projects_slug_unique ON projects_projects(workspace_id,slug);
