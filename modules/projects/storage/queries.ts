export const queries = {
  project:
    "SELECT id, project_key, name, version, archived FROM projects_projects WHERE workspace_id=? AND id=?",
  grant:
    "SELECT role, active FROM projects_grants WHERE workspace_id=? AND project_id=? AND principal_id=?",
  visible:
    "SELECT p.id, p.project_key, p.name, p.version, p.archived, g.role AS grant_role FROM projects_projects p LEFT JOIN projects_grants g ON g.workspace_id=p.workspace_id AND g.project_id=p.id AND g.principal_id=? AND g.active=1 WHERE p.workspace_id=? AND p.archived=0 AND p.id>? AND (?=1 OR g.principal_id IS NOT NULL) ORDER BY p.id LIMIT ?",
  create:
    "INSERT INTO projects_projects(workspace_id,id,project_key,name,version) VALUES(?,?,?,?,1)",
  rename:
    "UPDATE projects_projects SET project_key=?,name=?,version=version+1 WHERE workspace_id=? AND id=? AND version=? AND archived=0",
  bump: "UPDATE projects_projects SET version=version+1 WHERE workspace_id=? AND id=? AND version=? AND archived=0",
  archive:
    "UPDATE projects_projects SET archived=1,version=version+1 WHERE workspace_id=? AND id=? AND version=? AND archived=0",
  grantRole:
    "INSERT INTO projects_grants(workspace_id,project_id,principal_id,role,active) VALUES(?,?,?,?,1) ON CONFLICT(workspace_id,project_id,principal_id) DO UPDATE SET role=excluded.role,active=1 WHERE projects_grants.role!=excluded.role OR projects_grants.active=0",
  revokeRole:
    "UPDATE projects_grants SET active=0 WHERE workspace_id=? AND project_id=? AND principal_id=? AND active=1",
  guard: "INSERT INTO projects_guards(workspace_id,id,changed) VALUES(?,?,changes())",
  clearGuard: "DELETE FROM projects_guards WHERE workspace_id=? AND id=?",
  receipt:
    "INSERT INTO projects_receipts(workspace_id,principal_id,operation_id,fingerprint,result_id,result_version) VALUES(?,?,?,?,?,?)",
  readReceipt:
    "SELECT fingerprint,result_id,result_version FROM projects_receipts WHERE workspace_id=? AND principal_id=? AND operation_id=?",
  event:
    "INSERT INTO projects_events(workspace_id,sequence,event_id,aggregate_id,aggregate_version,type,occurred_at,actor_id,client_id,schema_version) VALUES(?,(SELECT COALESCE(MAX(sequence),0)+1 FROM projects_events WHERE workspace_id=?),?,?,?,?,?,?,?,2)",
  events:
    "SELECT sequence,event_id,aggregate_id,aggregate_version,type,occurred_at,actor_id,client_id,schema_version FROM projects_events WHERE workspace_id=? AND sequence>? ORDER BY sequence LIMIT ?",
} as const;
