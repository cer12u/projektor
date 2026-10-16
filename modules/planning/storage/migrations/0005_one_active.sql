CREATE UNIQUE INDEX planning_one_active_sprint ON planning_sprints(workspace_id,project_id) WHERE status='active';
