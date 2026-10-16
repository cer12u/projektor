export const queries = {
  project:
    "SELECT id, project_key, name, description, slug, created_at, updated_at, version, archived FROM projects_projects WHERE workspace_id=? AND id=?",
  projectBySlug: "SELECT id FROM projects_projects WHERE workspace_id=? AND slug=?",
  projectByKey:
    "SELECT p.id,p.project_key,p.name,p.description,p.slug,p.created_at,p.updated_at,p.version,p.archived,g.role AS grant_role FROM projects_projects p LEFT JOIN projects_grants g ON g.workspace_id=p.workspace_id AND g.project_id=p.id AND g.principal_id=? AND g.active=1 WHERE p.workspace_id=? AND p.project_key=? COLLATE NOCASE AND p.archived=0 AND (?=1 OR g.principal_id IS NOT NULL)",
  grant:
    "SELECT role, active FROM projects_grants WHERE workspace_id=? AND project_id=? AND principal_id=?",
  visible:
    "SELECT p.id, p.project_key, p.name, p.description, p.slug, p.created_at, p.updated_at, p.version, p.archived, g.role AS grant_role FROM projects_projects p LEFT JOIN projects_grants g ON g.workspace_id=p.workspace_id AND g.project_id=p.id AND g.principal_id=? AND g.active=1 WHERE p.workspace_id=? AND p.archived=0 AND p.id>? AND (?=1 OR g.principal_id IS NOT NULL) ORDER BY p.id LIMIT ?",
  create:
    "INSERT INTO projects_projects(workspace_id,id,project_key,name,description,slug,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?,?,1)",
  rename:
    "UPDATE projects_projects SET project_key=?,name=?,updated_at=?,version=version+1 WHERE workspace_id=? AND id=? AND version=? AND archived=0",
  updateProject:
    "UPDATE projects_projects SET project_key=?,name=?,description=?,slug=?,updated_at=?,version=version+1 WHERE workspace_id=? AND id=? AND version=? AND archived=0",
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
    "INSERT INTO projects_receipts(workspace_id,principal_id,operation_id,fingerprint,result_id,result_version,project_id) VALUES(?,?,?,?,?,?,?)",
  readReceipt:
    "SELECT fingerprint,result_id,result_version FROM projects_receipts WHERE workspace_id=? AND principal_id=? AND operation_id=?",
  event:
    "INSERT INTO projects_events(workspace_id,sequence,event_id,aggregate_id,aggregate_version,type,occurred_at,actor_id,client_id,schema_version,project_id) VALUES(?,(SELECT COALESCE(MAX(sequence),0)+1 FROM projects_events WHERE workspace_id=?),?,?,?,?,?,?,?,2,?)",
  events:
    "SELECT sequence,event_id,aggregate_id,aggregate_version,type,occurred_at,actor_id,client_id,schema_version,project_id FROM projects_events WHERE workspace_id=? AND sequence>? ORDER BY sequence LIMIT ?",
  maintenanceFreeze:
    "INSERT INTO projects_frozen_scopes(workspace_id,project_id,state) VALUES(?,?,'frozen') ON CONFLICT(workspace_id,project_id) DO NOTHING",
  maintenanceMarker:
    "SELECT state FROM projects_frozen_scopes WHERE workspace_id=? AND project_id=?",
  maintenanceBegin:
    "UPDATE projects_frozen_scopes SET state='purging' WHERE workspace_id=? AND project_id=? AND state='frozen'",
  maintenanceDone:
    "UPDATE projects_frozen_scopes SET state='purged' WHERE workspace_id=? AND project_id=? AND state='purging'",
  maintenanceBypass: "INSERT INTO projects_purge_bypass(workspace_id,project_id) VALUES(?,?)",
  maintenanceUnbypass: "DELETE FROM projects_purge_bypass WHERE workspace_id=? AND project_id=?",
  maintenanceCountGrants:
    "SELECT COUNT(*) AS n FROM projects_grants t WHERE t.workspace_id=? AND (?='' OR t.project_id=?)",
  maintenanceDeleteGrants:
    "DELETE FROM projects_grants WHERE rowid IN (SELECT t.rowid FROM projects_grants t WHERE t.workspace_id=? AND (?='' OR t.project_id=?) ORDER BY t.rowid LIMIT 50)",
  maintenanceCountReceipts:
    "SELECT COUNT(*) AS n FROM projects_receipts t WHERE t.workspace_id=? AND (?='' OR t.project_id=?)",
  maintenanceDeleteReceipts:
    "DELETE FROM projects_receipts WHERE rowid IN (SELECT t.rowid FROM projects_receipts t WHERE t.workspace_id=? AND (?='' OR t.project_id=?) ORDER BY t.rowid LIMIT 50)",
  maintenanceCountEvents:
    "SELECT COUNT(*) AS n FROM projects_events t WHERE t.workspace_id=? AND (?='' OR t.project_id=?)",
  maintenanceDeleteEvents:
    "DELETE FROM projects_events WHERE rowid IN (SELECT t.rowid FROM projects_events t WHERE t.workspace_id=? AND (?='' OR t.project_id=?) ORDER BY t.rowid LIMIT 50)",
  maintenanceCountGuards:
    "SELECT COUNT(*) AS n FROM projects_guards t WHERE t.workspace_id=? AND ?=''",
  maintenanceDeleteGuards:
    "DELETE FROM projects_guards WHERE rowid IN (SELECT t.rowid FROM projects_guards t WHERE t.workspace_id=? AND ?='' ORDER BY t.rowid LIMIT 50)",
  maintenanceCountProjects:
    "SELECT COUNT(*) AS n FROM projects_projects t WHERE t.workspace_id=? AND (?='' OR t.id=?)",
  maintenanceDeleteProjects:
    "DELETE FROM projects_projects WHERE rowid IN (SELECT t.rowid FROM projects_projects t WHERE t.workspace_id=? AND (?='' OR t.id=?) AND NOT EXISTS (SELECT 1 FROM projects_grants c WHERE c.workspace_id=t.workspace_id AND c.project_id=t.id) AND NOT EXISTS (SELECT 1 FROM projects_receipts c WHERE c.workspace_id=t.workspace_id AND c.result_id=t.id) AND NOT EXISTS (SELECT 1 FROM projects_events c WHERE c.workspace_id=t.workspace_id AND c.aggregate_id=t.id) ORDER BY t.rowid LIMIT 50)",
} as const;
