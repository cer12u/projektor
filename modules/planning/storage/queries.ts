export const queries = {
  sprint:
    "SELECT id,project_id,name,version,closed FROM planning_sprints WHERE workspace_id=? AND id=?",
  list: "SELECT id,project_id,name,version,closed FROM planning_sprints WHERE workspace_id=? AND project_id=? ORDER BY id",
  items:
    "SELECT issue_id FROM planning_items WHERE workspace_id=? AND sprint_id=? AND present=1 AND issue_id>? ORDER BY issue_id LIMIT ?",
  create:
    "INSERT INTO planning_sprints(workspace_id,id,project_id,name,version,closed) VALUES(?,?,?,?,1,0)",
  bump: "UPDATE planning_sprints SET version=version+1 WHERE workspace_id=? AND id=? AND version=? AND closed=0",
  close:
    "UPDATE planning_sprints SET version=version+1,closed=1 WHERE workspace_id=? AND id=? AND version=? AND closed=0",
  addItem:
    "INSERT INTO planning_items(workspace_id,sprint_id,issue_id,active,present) VALUES(?,?,?,1,1) ON CONFLICT(workspace_id,sprint_id,issue_id) DO UPDATE SET active=1,present=1 WHERE active=0",
  removeItem:
    "UPDATE planning_items SET active=0,present=0 WHERE workspace_id=? AND sprint_id=? AND issue_id=? AND active=1",
  closeItems:
    "UPDATE planning_items SET active=0 WHERE workspace_id=? AND sprint_id=? AND active=1",
  guard: "INSERT INTO planning_guards(workspace_id,id,changed) VALUES(?,?,changes())",
  clearGuard: "DELETE FROM planning_guards WHERE workspace_id=? AND id=?",
  history:
    "INSERT INTO planning_history(workspace_id,sprint_id,project_id,version,action,issue_id,actor_id,occurred_at) SELECT workspace_id,id,project_id,version,?,?,?,? FROM planning_sprints WHERE workspace_id=? AND id=?",
  receipt:
    "INSERT INTO planning_receipts(workspace_id,principal_id,operation_id,fingerprint,result_id,project_id,result_version) SELECT ?,?,?,?,id,project_id,version FROM planning_sprints WHERE workspace_id=? AND id=?",
  readReceipt:
    "SELECT fingerprint,result_id,result_version FROM planning_receipts WHERE workspace_id=? AND principal_id=? AND operation_id=?",
  event:
    "INSERT INTO planning_events(workspace_id,sequence,event_id,aggregate_id,project_id,aggregate_version,type,issue_id,actor_id,occurred_at,client_id,schema_version) SELECT ?,(SELECT COALESCE(MAX(sequence),0)+1 FROM planning_events WHERE workspace_id=?),?,id,project_id,?,?,?,?,?,?,2 FROM planning_sprints WHERE workspace_id=? AND id=?",
  events:
    "SELECT e.sequence,e.event_id,e.aggregate_id,COALESCE(e.project_id,s.project_id) AS project_id,e.aggregate_version,e.type,e.issue_id,e.actor_id,e.occurred_at,e.client_id,e.schema_version FROM planning_events e LEFT JOIN planning_sprints s ON s.workspace_id=e.workspace_id AND s.id=e.aggregate_id WHERE e.workspace_id=? AND e.sequence>? ORDER BY e.sequence LIMIT ?",
  maintenanceMarker: "SELECT state FROM planning_maintenance WHERE workspace_id=? AND project_id=?",
  maintenanceFreeze:
    "INSERT OR IGNORE INTO planning_maintenance(workspace_id,project_id,state) VALUES(?,?,'frozen')",
  maintenancePurging:
    "UPDATE planning_maintenance SET state='purging' WHERE workspace_id=? AND project_id=? AND state='frozen'",
  maintenanceCount:
    "WITH scope(workspace_id,project_id) AS (VALUES(?,?)) SELECT (SELECT COUNT(*) FROM planning_sprints,scope WHERE planning_sprints.workspace_id=scope.workspace_id AND (scope.project_id='' OR planning_sprints.project_id=scope.project_id))+(SELECT COUNT(*) FROM planning_items,scope WHERE planning_items.workspace_id=scope.workspace_id AND (scope.project_id='' OR planning_items.sprint_id IN (SELECT id FROM planning_sprints WHERE workspace_id=scope.workspace_id AND project_id=scope.project_id)))+(SELECT COUNT(*) FROM planning_history,scope WHERE planning_history.workspace_id=scope.workspace_id AND (scope.project_id='' OR planning_history.project_id=scope.project_id))+(SELECT COUNT(*) FROM planning_receipts,scope WHERE planning_receipts.workspace_id=scope.workspace_id AND (scope.project_id='' OR planning_receipts.project_id=scope.project_id))+(SELECT COUNT(*) FROM planning_events,scope WHERE planning_events.workspace_id=scope.workspace_id AND (scope.project_id='' OR planning_events.project_id=scope.project_id)) AS n",
  maintenanceUnknown:
    "SELECT (SELECT COUNT(*) FROM planning_history WHERE workspace_id=? AND project_id IS NULL)+(SELECT COUNT(*) FROM planning_receipts WHERE workspace_id=? AND project_id IS NULL)+(SELECT COUNT(*) FROM planning_events WHERE workspace_id=? AND project_id IS NULL) AS n",
  purgeItems:
    "DELETE FROM planning_items WHERE rowid IN (SELECT rowid FROM planning_items WHERE workspace_id=? AND (?='' OR sprint_id IN (SELECT id FROM planning_sprints WHERE workspace_id=? AND project_id=?)) ORDER BY rowid LIMIT 50)",
  purgeHistory:
    "DELETE FROM planning_history WHERE rowid IN (SELECT rowid FROM planning_history WHERE workspace_id=? AND (?='' OR project_id=?) ORDER BY rowid LIMIT 50)",
  purgeReceipts:
    "DELETE FROM planning_receipts WHERE rowid IN (SELECT rowid FROM planning_receipts WHERE workspace_id=? AND (?='' OR project_id=?) ORDER BY rowid LIMIT 50)",
  purgeEvents:
    "DELETE FROM planning_events WHERE rowid IN (SELECT rowid FROM planning_events WHERE workspace_id=? AND (?='' OR project_id=?) ORDER BY rowid LIMIT 50)",
  purgeSprints:
    "DELETE FROM planning_sprints WHERE rowid IN (SELECT rowid FROM planning_sprints WHERE workspace_id=? AND (?='' OR project_id=?) AND NOT EXISTS(SELECT 1 FROM planning_items i WHERE i.workspace_id=planning_sprints.workspace_id AND i.sprint_id=planning_sprints.id) AND NOT EXISTS(SELECT 1 FROM planning_history h WHERE h.workspace_id=planning_sprints.workspace_id AND h.sprint_id=planning_sprints.id) ORDER BY rowid LIMIT 50)",
} as const;
